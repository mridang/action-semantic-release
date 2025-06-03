/* eslint-disable testing-library/no-debugging-utils */
import {
  getInput,
  setFailed,
  info,
  debug,
  startGroup,
  endGroup,
  summary,
} from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { cosmiconfig } from 'cosmiconfig';
import semanticRelease, { Options, Result } from 'semantic-release';
import { basename, extname } from 'path';

interface StrategyOptions {
  githubToken: string;
  waitForChecks: boolean;
  workingDirectory: string;
}

type Strategy = (opts: StrategyOptions) => Promise<void>;

const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const CHECK_INTERVAL_MS = 10 * 1000;

type SupportedFormats = 'json' | 'yaml' | 'js' | 'cjs' | 'mjs';

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

function isPushOrTag(): boolean {
  if (context.eventName === 'push') {
    if (
      context.ref.startsWith('refs/heads/') ||
      context.ref.startsWith('refs/tags/')
    ) {
      return true;
    } else {
      return false;
    }
  } else {
    return false;
  }
}
function getStrategyName(
  format: SupportedFormats,
): 'declarative' | 'imperative' {
  if (format === 'json' || format === 'yaml') {
    return 'declarative';
  } else {
    return 'imperative';
  }
}

async function waitForAllChecks(token: string): Promise<void> {
  const octokit = getOctokit(token);
  const { owner, repo } = context.repo;
  const ref = context.sha;
  const deadline = Date.now() + CHECK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const { data } = await octokit.rest.checks.listForRef({ owner, repo, ref });
    const runs = data.check_runs;

    if (runs.length > 0) {
      if (runs.every((run) => run.status === 'completed')) {
        if (runs.every((run) => run.conclusion === 'success')) {
          info('All required checks have passed.');
          return;
        } else {
          throw new Error('One or more required checks failed.');
        }
      } else {
        debug('Waiting for checks to complete...');
      }
    } else {
      debug('No checks found. Waiting...');
    }

    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
  }

  throw new Error('Timeout: Not all checks completed in time.');
}

async function run(): Promise<void> {
  try {
    if (!isPushOrTag()) {
      info('Skipping: not a branch or tag push.');
      return;
    }

    const githubToken = getGithubToken();
    const workingDirectory = getWorkingDirectory();
    const waitForChecks = getWaitForChecks();

    const explorer = cosmiconfig('release', { stopDir: workingDirectory });
    const result = await explorer.search();

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
    }

    const filepath = result.filepath;
    const config = result.config;

    let format: SupportedFormats;
    const ext = extname(filepath);
    const base = basename(filepath);

    if (ext === '.json') {
      format = 'json';
    } else if (ext === '.yaml' || ext === '.yml') {
      format = 'yaml';
    } else if (ext === '.cjs') {
      format = 'cjs';
    } else if (ext === '.mjs') {
      format = 'mjs';
    } else if (ext === '.js') {
      format = 'js';
    } else if (base === '.releaserc') {
      format = 'json';
    } else {
      throw new Error(`Unsupported file extension: "${ext || 'none'}"`);
    }

    const strategyName = getStrategyName(format);

    startGroup('Preparing configuration');
    info(`Using "${strategyName}" strategy to install dependencies.`);
    // const strategyModule = await import(`./strategies/${strategyName}`);
    // const strategy: Strategy = strategyModule.default;
    // await strategy({ githubToken, waitForChecks, workingDirectory });
    // endGroup();
    //
    // if (waitForChecks) {
    //   startGroup('Waiting for checks to pass');
    //   await waitForAllChecks(githubToken);
    //   endGroup();
    // }
    //
    // startGroup('Running semantic-release');
    // const releaseResult: Result | false = await semanticRelease(
    //   config as Options,
    // );
    // endGroup();
    //
    // if (!releaseResult) {
    //   setFailed('No release was published.');
    // } else {
    //   const version = releaseResult.nextRelease.version;
    //   info(`Release published: version ${version}`);
    //   await summary
    //     .addHeading('Semantic Release')
    //     .addRaw(`Version ${version} was successfully released.`, true)
    //     .write();
    // }
  } catch (err) {
    if (err instanceof Error) {
      setFailed(err.message);
    } else {
      setFailed('An unknown error occurred.');
    }
  }
}

void run();
