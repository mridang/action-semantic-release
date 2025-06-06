/* eslint-disable testing-library/no-debugging-utils */
// noinspection ExceptionCaughtLocallyJS
import {
  getInput,
  setFailed as actionFailed,
  info,
  startGroup,
  endGroup,
  summary,
} from '@actions/core';
import { cosmiconfig } from 'cosmiconfig';
import semanticRelease, { Options, Result } from 'semantic-release';
import { loaders } from './loaders.js';
import { Context } from '@actions/github/lib/context.js';
import waitForAllChecks from './waiter.js';

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

        const explorer = cosmiconfig('release', {
          loaders,
        });

        const result = await explorer.search(workingDirectory);

        if (result === null) {
          throw new Error('No configuration file found.');
        } else if (
          typeof result.config !== 'object' ||
          result.config === null ||
          !result.filepath
        ) {
          throw new Error('Invalid semantic-release configuration.');
        } else if (result.isEmpty) {
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
                GITHUB_TOKEN: ghCtx.repo,
              },
            },
          );
          endGroup();

          if (!releaseResult) {
            setFailed('No release was published.');
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
      setFailed(err.message);
    } else {
      setFailed('An unknown error occurred.');
    }
  }
}
