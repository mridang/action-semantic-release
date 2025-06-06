/* eslint-disable testing-library/no-debugging-utils */
import { Context } from '@actions/github/lib/context.js';
import { getOctokit } from '@actions/github';
import { debug, info, warning } from '@actions/core';

const CHECK_TIMEOUT_MS = 20 * 60 * 1000;
const CHECK_INTERVAL_MS = 2 * 1000;

/**
 * Waits for all *other* GitHub check runs on the current commit to complete
 * and be successful.
 *
 * This version includes a refined heuristic: if the current job's ID is not
 * found in the list of check run names AND only one check is running,
 * it assumes that single check is the current job and proceeds.
 *
 * @param ghCtx - The GitHub Actions context object.
 * @param token - The GitHub token for API authentication.
 * @returns A Promise that resolves when all other check runs are successful.
 * @throws {Error} if any other check run fails or if the monitoring times out.
 */
export default async function waitForAllChecks(
  ghCtx: Context,
  token: string,
): Promise<void> {
  const octokit = getOctokit(token);
  const { owner, repo } = ghCtx.repo;
  const ref = ghCtx.sha;
  const selfIdentifier = ghCtx.job;
  const deadline = Date.now() + CHECK_TIMEOUT_MS;

  info(`Starting check run monitoring for ref ${ref}`);
  debug(`Identifying self as job ID: '${selfIdentifier}'`);

  while (Date.now() < deadline) {
    const { data } = await octokit.rest.checks.listForRef({ owner, repo, ref });
    const checkRuns = data.check_runs;

    const selfIsPresentInChecks = checkRuns.some(
      (run) => run.name === selfIdentifier,
    );

    if (!selfIsPresentInChecks && checkRuns.length === 1) {
      const theOnlyCheck = checkRuns[0];
      info(
        `Heuristic triggered: The job ID '${selfIdentifier}' was not found.`,
      );
      info(
        `Only one check is running: '${theOnlyCheck.name}'. Assuming this is the current job and proceeding.`,
      );
      warning(
        'This heuristic is safe for most workflows but may be inaccurate in complex scenarios.',
      );
      return;
    }

    const otherRuns = checkRuns.filter((run) => run.name !== selfIdentifier);

    if (otherRuns.length === 0) {
      info('No other check runs found. Proceeding.');
      return;
    }

    const pendingChecks = otherRuns.filter((run) => run.status !== 'completed');

    if (pendingChecks.length === 0) {
      const allSuccessful = otherRuns.every(
        (run) =>
          run.conclusion === 'success' ||
          run.conclusion === 'skipped' ||
          run.conclusion === 'neutral',
      );
      if (allSuccessful) {
        info('All other check runs have completed successfully.');
        return;
      } else {
        const failedCheck = otherRuns.find(
          (run) =>
            run.conclusion !== 'success' &&
            run.conclusion !== 'skipped' &&
            run.conclusion !== 'neutral',
        );
        throw new Error(
          `Check '${failedCheck?.name}' failed with conclusion: ${failedCheck?.conclusion}.`,
        );
      }
    } else {
      const pendingCheckNames = pendingChecks.map((run) => run.name).join(', ');
      info(`Waiting for checks to complete: ${pendingCheckNames}`);
    }

    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
  }

  throw new Error('Timed out waiting for check runs to complete.');
}
