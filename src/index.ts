// noinspection ExceptionCaughtLocallyJS
import {
  getInput,
  setFailed as actionFailed,
  info,
  startGroup,
  endGroup,
  summary,
  warning,
} from '@actions/core';
import { cosmiconfig } from 'cosmiconfig';
import semanticRelease, { Options, Result } from 'semantic-release';
import { createLoaders } from './loaders.js';
import { Context } from '@actions/github/lib/context.js';
import waitForAllChecks from './waiter.js';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Retrieves the GitHub token from the action's 'github-token' input.
 *
 * @returns The GitHub token.
 * @throws {Error} if the 'github-token' input is empty.
 */
function getGithubToken(): string {
  const token = getInput('github-token', { required: true }).trim();
  if (token) {
    return token;
  } else {
    throw new Error('The "github-token" input must not be empty.');
  }
}

/**
 * Retrieves the working directory from the action's 'working-directory' input.
 *
 * @returns The specified working directory or the current process's
 * working directory if the input is empty.
 */
function getWorkingDirectory(): string {
  const dir = getInput('working-directory').trim();
  if (dir) {
    return dir;
  } else {
    return process.cwd();
  }
}

/**
 * Retrieves the boolean value for 'wait-for-checks' input.
 *
 * @returns `true` if 'wait-for-checks' is 'true' or empty, `false` if 'false'.
 * @throws {Error} if the 'wait-for-checks' input is an invalid value.
 */
function getWaitForChecks(): boolean {
  const raw = getInput('wait-for-checks').trim().toLowerCase();
  if (raw === 'false') {
    return false;
  } else if (raw === 'true' || raw === '') {
    return true;
  } else {
    throw new Error(
      'Invalid value for "wait-for-checks". Use "true" or "false".',
    );
  }
}

/**
 * Retrieves the boolean value for the 'allow-force-install' input.
 *
 * @returns `true` if 'allow-force-install' is 'true' or empty, `false` if 'false'.
 * @throws {Error} if the 'allow-force-install' input is an invalid value.
 */
function getAllowForceInstall(): boolean {
  const raw = getInput('allow-force-install').trim().toLowerCase();
  if (raw === 'true') {
    return true;
  } else if (raw === 'false' || raw === '') {
    return false;
  } else {
    throw new Error(
      'Invalid value for "allow-force-install". Use "true" or "false".',
    );
  }
}

/**
 * Retrieves the deploy key from the action's 'deploy-key' input.
 *
 * @returns The SSH deploy key or undefined if not provided.
 */
function getDeployKey(): string | undefined {
  const key = getInput('deploy-key').trim();
  if (key) {
    return key;
  } else {
    return undefined;
  }
}

/**
 * The default command executor used by {@link setupSshKey}. Tests can pass
 * a different implementation to avoid invoking real `ssh-keyscan`,
 * `ssh-agent`, or `ssh-add` binaries.
 *
 * @param command - The shell command to execute.
 * @param options - Optional environment overrides for the command.
 */
export type SshCommandRunner = (
  command: string,
  options?: { env?: Record<string, string | undefined> },
) => void;

const defaultSshCommandRunner: SshCommandRunner = (command, options) => {
  execSync(command, {
    stdio: 'pipe',
    env: options?.env ?? process.env,
  });
};

/**
 * Sets up SSH authentication using a deploy key.
 *
 * @param deployKey - The SSH private key content.
 * @param runCommand - The command runner used to invoke `ssh-keyscan`,
 * `ssh-agent`, and `ssh-add`. Defaults to a wrapper around `execSync`;
 * tests can swap this for a stub so the production logic can be
 * exercised without requiring real SSH tooling on the host.
 */
export function setupSshKey(
  deployKey: string,
  runCommand: SshCommandRunner = defaultSshCommandRunner,
): void {
  const home = process.env.HOME || homedir();
  const sshDir = join(home, '.ssh');
  const keyPath = join(sshDir, 'id_rsa');
  const socketPath = '/tmp/ssh_agent.sock';

  if (!existsSync(sshDir)) {
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  }

  writeFileSync(keyPath, deployKey + '\n', { mode: 0o600 });

  try {
    runCommand(
      `ssh-keyscan github.com >> ${join(sshDir, 'known_hosts')} 2>/dev/null`,
    );
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(
        `Failed to add github.com to known_hosts: ${err.message}`,
      );
    }
    throw new Error('Failed to add github.com to known_hosts');
  }

  process.env.SSH_AUTH_SOCK = socketPath;

  try {
    runCommand(`ssh-agent -a ${socketPath}`);
    runCommand(`ssh-add ${keyPath}`, {
      env: { ...process.env, SSH_AUTH_SOCK: socketPath },
    });
    info('SSH deploy key configured successfully');
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(`Failed to set up SSH agent: ${err.message}`);
    }
    throw new Error('Failed to set up SSH agent');
  }
}

/**
 * Sets the action's failure status with a given message.
 * In a JEST test environment, it throws an error instead of calling
 * `actionFailed`.
 *
 * @param message - The error message or Error object.
 */
function setFailed(message: string | Error): void {
  if (process.env.JEST_WORKER_ID) {
    if (message instanceof Error) {
      throw message;
    } else {
      throw new Error(message);
    }
  } else {
    actionFailed(message);
  }
}

export async function run(
  waiterFn?: () => Promise<void>,
  ghCtx = new Context(),
  sshCommandRunner: SshCommandRunner = defaultSshCommandRunner,
): Promise<string | void> {
  try {
    if (ghCtx.eventName === 'push') {
      if (
        ghCtx.ref.startsWith('refs/heads/') ||
        ghCtx.ref.startsWith('refs/tags/')
      ) {
        const githubToken = getGithubToken();
        const workingDirectory = getWorkingDirectory();
        const waitForChecks = getWaitForChecks();
        const deployKey = getDeployKey();

        if (deployKey) {
          startGroup('Configuring SSH authentication');
          setupSshKey(deployKey, sshCommandRunner);
          endGroup();
        }

        const explorer = cosmiconfig('release', {
          loaders: createLoaders(getAllowForceInstall()),
        });

        const result = await explorer.search(workingDirectory);

        if (result === null) {
          // noinspection ExceptionCaughtLocallyJS
          throw new Error('No configuration file found.');
        } else if (
          typeof result.config !== 'object' ||
          result.config === null ||
          !result.filepath
        ) {
          // noinspection ExceptionCaughtLocallyJS
          throw new Error('Invalid semantic-release configuration.');
        } else if (result.isEmpty) {
          // noinspection ExceptionCaughtLocallyJS
          throw new Error(`Configuration file "${result.filepath}" is empty.`);
        } else {
          const config = result.config;

          if (waitForChecks) {
            startGroup('Waiting for checks to pass');
            if (waiterFn) {
              await waiterFn();
            } else {
              await waitForAllChecks(ghCtx, githubToken);
            }
            endGroup();
          }

          startGroup('Running semantic-release');
          const releaseResult: Result | false = await semanticRelease(
            config as Options,
            {
              cwd: workingDirectory,
              env: {
                ...process.env,
                GITHUB_TOKEN: githubToken,
                SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
              },
            },
          );
          endGroup();

          if (!releaseResult) {
            warning('No release was published.');
          } else {
            const version = releaseResult.nextRelease.version;
            info(`Release published: version ${version}`);
            return (
              await summary
                .addHeading('Semantic Release')
                .addRaw(`Version ${version} was successfully released.`, true)
                .write()
            ).stringify();
          }
        }
      } else {
        info('Skipping: not a branch or tag push.');
      }
    } else {
      info('Skipping: not a branch or tag push.');
    }
  } catch (err) {
    if (err instanceof Error) {
      setFailed(err);
    } else {
      setFailed(err as unknown as string);
    }
  }
}
