import { expect } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/index.js';
import { withTempDir } from './helpers/with-temp-dir.js';
import { withGitRepo } from './helpers/with-git-repo.js';
import { withEnvVars } from './helpers/with-env-vars.js';
import { tmpdir } from 'node:os';

/**
 * A test helper to execute the main action script (`run`) within a
 * controlled environment. It simulates the GitHub Actions runtime by
 * preparing environment variables and mocking necessary features like
 * Job Summaries.
 *
 * @param inputs A record of key-value pairs representing the action's
 * inputs, equivalent to the `with` block in a workflow YAML file.
 * @param extraEnv A record of additional environment variables to set
 * during the action's execution, used to simulate workflow context
 * like `GITHUB_REF` or `GITHUB_EVENT_NAME`.
 * @param waiterFn An optional async function that can be passed to the
 * underlying `run` function, typically used for testing race
 * conditions or waiting for asynchronous operations.
 * @returns A promise that resolves with the action's result or void.
 */
async function runAction(
  inputs: Record<string, string>,
  extraEnv: Record<string, string | undefined> = {},
  waiterFn?: () => Promise<void>,
): Promise<string | void> {
  const summaryDir = mkdtempSync(join(tmpdir(), 'test-'));
  const summaryPath = join(summaryDir, 'summary.md');
  writeFileSync(summaryPath, '');

  const eventDir = mkdtempSync(join(tmpdir(), 'test-'));
  const eventPath = join(eventDir, 'event.json');
  writeFileSync(eventPath, JSON.stringify({}));

  const wrapped = withEnvVars(
    {
      ...extraEnv,
      ...Object.fromEntries(
        Object.entries(inputs).map(([key, value]) => [
          `INPUT_${key.replace(/ /g, '_').toUpperCase()}`,
          value,
        ]),
      ),
      GITHUB_STEP_SUMMARY: summaryPath,
      GITHUB_EVENT_PATH: eventPath,
    },
    () => run(waiterFn),
  );
  return await wrapped();
}

const matrix = [
  {
    eventName: 'push',
    ref: 'refs/heads/master',
    wait: 'true',
    shouldRun: true,
  },
  {
    eventName: 'push',
    ref: 'refs/tags/v1.0.0',
    wait: 'false',
    shouldRun: true,
  },
  {
    eventName: 'push',
    ref: 'refs/notes/commits',
    wait: '???',
    shouldRun: false,
  },
  {
    eventName: 'pull_request',
    ref: 'refs/heads/master',
    wait: 'true',
    shouldRun: false,
  },
];

test.each(matrix)(
  'runs semantic-release for event "$eventName" with ref "$ref" and wait="$wait" (shouldRun: $shouldRun)',
  ({ eventName, ref, wait, shouldRun }) => {
    return withTempDir(
      withGitRepo(
        [
          'chore: init',
          'feat: some feat',
          'fix: some fix',
          'feat: another feat',
        ],
        async ({ tmp, remoteUrl }) => {
          writeFileSync(
            join(tmp, '.releaserc.json'),
            JSON.stringify({
              branches: ['master'],
              plugins: ['@semantic-release/commit-analyzer'],
              repositoryUrl: remoteUrl,
              dryRun: true,
              ci: false,
            }),
          );

          let waited = false;
          const waiterFn = async () => {
            waited = true;
          };

          await runAction(
            {
              'github-token': 'fake-token',
              'working-directory': tmp,
              'wait-for-checks': wait,
            },
            {
              GITHUB_EVENT_NAME: eventName,
              GITHUB_REF: ref,
              GITHUB_SHA: 'abc123',
              GITHUB_REPOSITORY: 'user/repo',
              GITHUB_TOKEN: '*******',
              GITHUB_ACTIONS: undefined,
            },
            waiterFn,
          );

          if (shouldRun) {
            expect(waited).toBe(wait !== 'false');
          } else {
            expect(waited).toBe(false);
          }
        },
      ),
    )();
  },
);
