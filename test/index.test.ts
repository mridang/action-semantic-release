import { expect } from '@jest/globals';
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  statSync,
  appendFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
// noinspection ES6PreferShortImport
import { run, type SshCommandRunner } from '../src/index.js';
import { Context } from '@actions/github/lib/context.js';
import { withTempDir } from './helpers/with-temp-dir.js';
import { withGitRepo } from './helpers/with-git-repo.js';
import { withEnvVars } from './helpers/with-env-vars.js';
import { tmpdir } from 'node:os';
import forge from 'node-forge';

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
  sshCommandRunner?: SshCommandRunner,
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
    () => run(waiterFn, new Context(), sshCommandRunner),
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

test('configures SSH deploy key when provided', () => {
  return withTempDir(
    withGitRepo(
      ['chore: init', 'feat: some feature'],
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

        const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
        const privateKeyPem = forge.ssh.privateKeyToOpenSSH(keypair.privateKey);

        const sshDir = join(tmp, '.ssh');
        const keyPath = join(sshDir, 'id_rsa');
        const knownHostsPath = join(sshDir, 'known_hosts');

        const commands: string[] = [];
        const sshCommandRunner: SshCommandRunner = (command) => {
          commands.push(command);
          if (command.startsWith('ssh-keyscan')) {
            // Real ssh-keyscan would append host keys to known_hosts via
            // shell redirection; emulate just the file-write side-effect
            // so we can assert the action wires it up correctly without
            // depending on the binary being installed.
            if (!existsSync(sshDir)) {
              mkdirSync(sshDir, { recursive: true, mode: 0o700 });
            }
            appendFileSync(knownHostsPath, 'github.com ssh-rsa AAAA-stub\n');
            return;
          }
          if (
            command.startsWith('ssh-agent') ||
            command.startsWith('ssh-add')
          ) {
            // No-op: a real agent isn't available in CI/devbox shells, so
            // we just record that the command was attempted.
            return;
          }
          throw new Error(`Unexpected SSH command: ${command}`);
        };

        await runAction(
          {
            'github-token': 'fake-token',
            'working-directory': tmp,
            'wait-for-checks': 'false',
            'deploy-key': privateKeyPem,
          },
          {
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: 'refs/heads/master',
            GITHUB_SHA: 'abc123',
            GITHUB_REPOSITORY: 'user/repo',
            GITHUB_TOKEN: '*******',
            GITHUB_ACTIONS: undefined,
            HOME: tmp,
          },
          undefined,
          sshCommandRunner,
        );

        expect(existsSync(keyPath)).toBe(true);
        expect(existsSync(knownHostsPath)).toBe(true);

        const stats = statSync(keyPath);
        expect(stats.mode & 0o777).toBe(0o600);

        expect(
          commands.some((c) => c.startsWith('ssh-keyscan github.com')),
        ).toBe(true);
        expect(commands.some((c) => c.startsWith('ssh-agent'))).toBe(true);
        expect(commands.some((c) => c.startsWith(`ssh-add ${keyPath}`))).toBe(
          true,
        );
      },
    ),
  )();
});
