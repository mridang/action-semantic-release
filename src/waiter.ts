/* eslint-disable testing-library/no-debugging-utils */
import { Context } from '@actions/github/lib/context.js';
import { getOctokit } from '@actions/github';
import { debug, info } from '@actions/core';

const CHECK_TIMEOUT_MS = 20 * 60 * 1000;
const CHECK_INTERVAL_MS = 2 * 1000;

/**
 * Waits for all *other* GitHub check runs on the current commit to complete
 * and be successful.
 *
 * This version includes a refined heuristic based on the list of PENDING checks
 * to correctly identify and bypass a deadlock caused by a custom job name.
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
    const allRuns = data.check_runs;

    const pendingRuns = allRuns.filter((run) => run.status !== 'completed');

    const selfIsPresentInPending = pendingRuns.some(
      (run) => run.name === selfIdentifier,
    );

    if (!selfIsPresentInPending && pendingRuns.length === 1) {
      const theOnlyPendingCheck = pendingRuns[0];
      info(
        `Heuristic triggered: The job ID '${selfIdentifier}' was not found in the list of pending checks.`,
      );
      info(
        `Only one pending check remains: '${theOnlyPendingCheck.name}'. Assuming this is the current job and proceeding.`,
      );
      return;
    }

    const otherRuns = allRuns.filter((run) => run.name !== selfIdentifier);

    if (otherRuns.length === 0) {
      info('No other check runs found. Proceeding.');
      return;
    }

    const pendingOtherRuns = otherRuns.filter(
      (run) => run.status !== 'completed',
    );

    if (pendingOtherRuns.length === 0) {
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
      const pendingCheckNames = pendingOtherRuns
        .map((run) => run.name)
        .join(', ');
      info(`Waiting for checks to complete: ${pendingCheckNames}`);
    }

    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
  }

  throw new Error('Timed out waiting for check runs to complete.');
}
