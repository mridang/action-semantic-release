import { expect } from '@jest/globals';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/index.js';
import { withTempDir } from './helpers/with-temp-dir.js';
import { withGitRepo } from './helpers/with-git-repo.js';
import { withEnvVars } from './helpers/with-env-vars.js';

function runAction(
  inputs: Record<string, string>,
  extraEnv: Record<string, string> = {},
  waiterFn?: () => Promise<void>,
): Promise<string | void> {
  const envVars: Record<string, string> = { ...extraEnv };

  for (const [key, value] of Object.entries(inputs)) {
    const formattedKey = `INPUT_${key.replace(/ /g, '_').toUpperCase()}`;
    envVars[formattedKey] = value;
  }

  const wrapped = withEnvVars(envVars, () => run(waiterFn));
  return wrapped();
}

const matrix = [
  { eventName: 'push', ref: 'refs/heads/main', wait: 'true', shouldRun: true },
  {
    eventName: 'push',
    ref: 'refs/tags/v1.0.0',
    wait: 'false',
    shouldRun: true,
  },
  { eventName: 'push', ref: 'refs/notes/commits', wait: '', shouldRun: false },
  {
    eventName: 'pull_request',
    ref: 'refs/heads/main',
    wait: 'true',
    shouldRun: false,
  },
];

test.each(matrix)(
  'runs semantic-release for event "$eventName" with ref "$ref" and wait="$wait" (shouldRun: $shouldRun)',
  ({ eventName, ref, wait, shouldRun }) => {
    return withTempDir(
      withGitRepo(['chore: init'], async ({ tmp }) => {
        writeFileSync(
          join(tmp, '.releaserc.json'),
          JSON.stringify({
            branches: ['main'],
            plugins: ['@semantic-release/commit-analyzer'],
            repositoryUrl: 'https://github.com/github/docs',
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
          },
          waiterFn,
        );

        if (shouldRun) {
          expect(waited).toBe(wait !== 'false');
        } else {
          expect(waited).toBe(false);
        }
      }),
    )();
  },
);
