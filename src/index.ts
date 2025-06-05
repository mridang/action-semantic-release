/* eslint-disable testing-library/no-debugging-utils */
// noinspection ExceptionCaughtLocallyJS
import {
  getInput,
  setFailed as actionFailed,
  info,
  debug,
  startGroup,
  endGroup,
  summary,
} from '@actions/core';
import { getOctokit } from '@actions/github';
import { cosmiconfig } from 'cosmiconfig';
import semanticRelease, { Options, Result } from 'semantic-release';
import { loaders } from './loaders.js';
import { Context } from '@actions/github/lib/context.js';

const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const CHECK_INTERVAL_MS = 2 * 1000;

function getGithubToken(): string {
  const token = getInput('github-token', { required: true }).trim();
  if (token) {
    return token;
  } else {
    throw new Error('The "github-token" input must not be empty.');
  }
}

function getWorkingDirectory(): string {
  const dir = getInput('working-directory').trim();
  if (dir) {
    return dir;
  } else {
    return process.cwd();
  }
}

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

async function waitForAllChecks(ghCtx: Context, token: string): Promise<void> {
  const octokit = getOctokit(token);
  const { owner, repo } = ghCtx.repo;
  const ref = ghCtx.sha;
  const currentJobName = ghCtx.job;
  const deadline = Date.now() + CHECK_TIMEOUT_MS;

  info(`Starting check run monitoring for ref: ${ref}`);
  info(`Will ignore self (this job): '${currentJobName}'`);

  while (Date.now() < deadline) {
    const { data } = await octokit.rest.checks.listForRef({ owner, repo, ref });

    const otherRuns = data.check_runs.filter(
      (run) => run.name !== currentJobName,
    );

    if (otherRuns.length === 0) {
      info('No other check runs found. Proceeding.');
      return;
    }

    const pendingChecks = otherRuns.filter((run) => run.status !== 'completed');

    if (pendingChecks.length === 0) {
      const allSuccessful = otherRuns.every(
        (run) => run.conclusion === 'success',
      );
      if (allSuccessful) {
        info('✅ All other check runs have completed successfully.');
        return;
      } else {
        const failedCheck = otherRuns.find(
          (run) => run.conclusion !== 'success',
        );
        throw new Error(
          `❌ Check '${failedCheck?.name}' failed with conclusion: ${failedCheck?.conclusion}.`,
        );
      }
    } else {
      const pendingCheckNames = pendingChecks.map((run) => run.name).join(', ');
      debug(`⏳ Waiting for checks to complete: ${pendingCheckNames}`);
    }

    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
  }

  throw new Error('Timeout: Not all other check runs completed in time.');
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
