/**
 * @file Action entrypoint logic that reads the action inputs, configures SSH,
 * loads the semantic-release configuration and runs the release.
 */
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
import { cosmiconfig, type CosmiconfigResult } from 'cosmiconfig';
import semanticRelease, { Options, Result } from 'semantic-release';
import { createLoaders } from './loaders.js';
import { context } from '@actions/github';
import waitForAllChecks from './waiter.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execAsync = promisify(exec);

/**
 * Retrieves the GitHub token from the action's 'github-token' input.
 * @returns The GitHub token.
 * @throws {Error} If the 'github-token' input is empty.
 * @example
 * ```ts
 * const token = getGithubToken();
 * ```
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
 * @returns The specified working directory or the current process's
 * working directory if the input is empty.
 * @example
 * ```ts
 * const cwd = getWorkingDirectory();
 * ```
 */
function getWorkingDirectory(): string {
  const dir = getInput('working-directory').trim();
  return dir || process.cwd();
}

/**
 * Retrieves the boolean value for 'wait-for-checks' input.
 * @returns `true` if 'wait-for-checks' is 'true' or empty, `false` if 'false'.
 * @throws {Error} If the 'wait-for-checks' input is an invalid value.
 * @example
 * ```ts
 * const waitForChecks = getWaitForChecks();
 * ```
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
 * @returns `true` if 'allow-force-install' is 'true' or empty, `false` if 'false'.
 * @throws {Error} If the 'allow-force-install' input is an invalid value.
 * @example
 * ```ts
 * const allowForce = getAllowForceInstall();
 * ```
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
 * @returns The SSH deploy key or undefined if not provided.
 * @example
 * ```ts
 * const deployKey = getDeployKey();
 * if (deployKey) {
 *   await setupSshKey(deployKey);
 * }
 * ```
 */
function getDeployKey(): string | undefined {
  const key = getInput('deploy-key').trim();
  return key || undefined;
}

/**
 * The default command executor used by {@link setupSshKey}. Tests can pass
 * a different implementation to avoid invoking real `ssh-keyscan`,
 * `ssh-agent`, or `ssh-add` binaries.
 * @param command - The shell command to execute.
 * @param options - Optional environment overrides for the command.
 */
export type SshCommandRunner = (
  command: string,
  options?: { env?: Record<string, string | undefined> },
) => Promise<void>;

const defaultSshCommandRunner: SshCommandRunner = async (command, options) => {
  await execAsync(command, {
    env: options?.env ?? process.env,
  });
};

/**
 * Sets up SSH authentication using a deploy key.
 * @param deployKey - The SSH private key content.
 * @param runCommand - The command runner used to invoke `ssh-keyscan`,
 * `ssh-agent`, and `ssh-add`. Defaults to a wrapper around `exec`;
 * tests can swap this for a stub so the production logic can be
 * exercised without requiring real SSH tooling on the host.
 * @throws If the known_hosts entry cannot be added or the SSH agent fails.
 * @example
 * ```ts
 * await setupSshKey(process.env.DEPLOY_KEY ?? '');
 * ```
 */
export async function setupSshKey(
  deployKey: string,
  runCommand: SshCommandRunner = defaultSshCommandRunner,
): Promise<void> {
  const home = process.env.HOME || homedir();
  const sshDir = path.join(home, '.ssh');
  const keyPath = path.join(sshDir, 'id_rsa');
  // The agent socket must sit at a fixed path so later steps can reuse SSH_AUTH_SOCK.
  const socketPath = path.join(sshDir, 'ssh_agent.sock');

  await mkdir(sshDir, { recursive: true, mode: 0o700 });
  await writeFile(keyPath, deployKey + '\n', { mode: 0o600 });

  try {
    await runCommand(
      `ssh-keyscan github.com >> ${path.join(sshDir, 'known_hosts')} 2>/dev/null`,
    );
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        `Failed to add github.com to known_hosts: ${error.message}`,
      );
    }
    throw new Error('Failed to add github.com to known_hosts');
  }

  process.env.SSH_AUTH_SOCK = socketPath;

  try {
    await runCommand(`ssh-agent -a ${socketPath}`);
    await runCommand(`ssh-add ${keyPath}`, {
      env: { ...process.env, SSH_AUTH_SOCK: socketPath },
    });
    info('SSH deploy key configured successfully');
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to set up SSH agent: ${error.message}`);
    }
    throw new Error('Failed to set up SSH agent');
  }
}

/**
 * Sets the action's failure status with a given message.
 * In a JEST test environment, it throws an error instead of calling
 * `actionFailed`.
 * @param message - The error message or Error object.
 * @throws The error itself when running under Jest, so tests can assert on it.
 * @example
 * ```ts
 * setFailed('The "github-token" input must not be empty.');
 * ```
 */
function setFailed(message: string | Error): void {
  if (process.env.JEST_WORKER_ID) {
    throw message instanceof Error ? message : new Error(message);
  } else {
    actionFailed(message);
  }
}

/**
 * Checks whether the current run was triggered by a push to a branch or tag.
 * @param ghCtx - The GitHub Actions context of the current run.
 * @returns `true` when the event is a push to a `refs/heads/` or `refs/tags/` ref.
 * @example
 * ```ts
 * if (isBranchOrTagPush(context)) {
 *   info('Releasing from this push.');
 * }
 * ```
 */
function isBranchOrTagPush(ghCtx: typeof context): boolean {
  return (
    ghCtx.eventName === 'push' &&
    (ghCtx.ref.startsWith('refs/heads/') || ghCtx.ref.startsWith('refs/tags/'))
  );
}

/**
 * Asserts that cosmiconfig found a usable, non-empty semantic-release configuration.
 * @param result - The search result from cosmiconfig, or `null` when no file exists.
 * @returns The configuration exactly as loaded from the file.
 * @throws If no file was found, the configuration is not an object, or the file is empty.
 * @example
 * ```ts
 * const config = requireConfig(await explorer.search(workingDirectory));
 * ```
 */
function requireConfig(result: CosmiconfigResult): unknown {
  if (result === null) {
    throw new Error('No configuration file found.');
  }
  if (
    typeof result.config !== 'object' ||
    result.config === null ||
    !result.filepath
  ) {
    throw new Error('Invalid semantic-release configuration.');
  }
  if (result.isEmpty) {
    throw new Error(`Configuration file "${result.filepath}" is empty.`);
  }
  return result.config;
}

/**
 * Runs the release for a branch or tag push, returning the job summary when a
 * release is published.
 * @param waiterFn - Optional replacement for the check-waiting step.
 * @param ghCtx - The GitHub Actions context of the current run.
 * @param sshCommandRunner - The command runner used for SSH setup.
 * @returns The rendered job summary when a release was published, otherwise `undefined`.
 * @throws If inputs are invalid, the configuration cannot be loaded, or a check fails.
 * @example
 * ```ts
 * const summaryMarkup = await executeAction(undefined, context, defaultSshCommandRunner);
 * ```
 */
async function executeAction(
  waiterFn: (() => Promise<void>) | undefined,
  ghCtx: typeof context,
  sshCommandRunner: SshCommandRunner,
): Promise<string | undefined> {
  if (!isBranchOrTagPush(ghCtx)) {
    info('Skipping: not a branch or tag push.');
    return undefined;
  }

  const githubToken = getGithubToken();
  const workingDirectory = getWorkingDirectory();
  const waitForChecks = getWaitForChecks();
  const deployKey = getDeployKey();

  if (deployKey) {
    startGroup('Configuring SSH authentication');
    await setupSshKey(deployKey, sshCommandRunner);
    endGroup();
  }

  const explorer = cosmiconfig('release', {
    loaders: createLoaders(getAllowForceInstall()),
  });
  const config = requireConfig(await explorer.search(workingDirectory));

  if (waitForChecks) {
    startGroup('Waiting for checks to pass');
    await (waiterFn ? waiterFn() : waitForAllChecks(ghCtx, githubToken));
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
        ...(process.env.SSH_AUTH_SOCK !== undefined && {
          SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
        }),
      },
    },
  );
  endGroup();

  if (!releaseResult) {
    warning('No release was published.');
    return undefined;
  }

  const version = releaseResult.nextRelease.version;
  info(`Release published: version ${version}`);
  const written = await summary
    .addHeading('Semantic Release')
    .addRaw(`Version ${version} was successfully released.`, true)
    .write();
  return written.stringify();
}

/**
 * Runs the action end to end and reports any failure through the action status.
 * @param waiterFn - Optional replacement for the check-waiting step, used by tests.
 * @param ghCtx - The GitHub Actions context; defaults to the live runner context.
 * @param sshCommandRunner - The command runner used for SSH setup.
 * @returns The rendered job summary when a release was published, otherwise `undefined`.
 * @example
 * ```ts
 * await run();
 * ```
 */
export async function run(
  waiterFn?: () => Promise<void>,
  ghCtx = new (context.constructor as new () => typeof context)(),
  sshCommandRunner: SshCommandRunner = defaultSshCommandRunner,
): Promise<string | void> {
  try {
    return await executeAction(waiterFn, ghCtx, sshCommandRunner);
  } catch (error) {
    if (error instanceof Error) {
      setFailed(error);
    } else {
      setFailed(String(error));
    }
    return undefined;
  }
}
