/* eslint-disable testing-library/no-debugging-utils */
import { Context } from '@actions/github/lib/context.js';
import { getOctokit } from '@actions/github';
import { debug, info } from '@actions/core';

const CHECK_TIMEOUT_MS = 20 * 60 * 1000;
const CHECK_INTERVAL_MS = 2 * 1000;

/**
 * Waits for all *other* GitHub check runs on the current commit to complete
 * and be successful. This function ignores the currently running job itself.
 * It polls for check statuses at a defined interval and times out after
 * a maximum duration.
 *
 * @param ghCtx - The GitHub Actions context object, providing details
 * about the current workflow run, including repository, SHA,
 * and current job name.
 * @param token - The GitHub token (e.g., `secrets.GITHUB_TOKEN`) required
 * for authenticate API requests for listing check runs.
 * @returns A Promise that resolves when all the other check runs are successful.
 * @throws {Error} if any other check run fails or if the monitoring
 * times out before all checks complete successfully.
 */
export default async function waitForAllChecks(
  ghCtx: Context,
  token: string,
): Promise<void> {
  const octokit = getOctokit(token);
  const { owner, repo } = ghCtx.repo;
  const ref = ghCtx.sha;
  const currentJobName = ghCtx.job;
  const deadline = Date.now() + CHECK_TIMEOUT_MS;

  info(`Starting check run monitoring for ref ${ref}`);
  debug(`Will ignore self (this job) named '${currentJobName}'`);

  while (Date.now() < deadline) {
    const { data } = await octokit.rest.checks.listForRef({ owner, repo, ref });
    const otherRuns = data.check_runs.filter(
      (run) => run.name !== currentJobName,
    );

    if (otherRuns.length === 0) {
      info('No other check runs found. Proceeding.');
      return;
    } else {
      const pendingChecks = otherRuns.filter(
        (run) => run.status !== 'completed',
      );

      if (pendingChecks.length === 0) {
        const allSuccessful = otherRuns.every(
          (run) => run.conclusion === 'success',
        );
        if (allSuccessful) {
          info('All other check runs have completed successfully.');
          return;
        } else {
          const failedCheck = otherRuns.find(
            (run) => run.conclusion !== 'success',
          );
          throw new Error(
            `Check '${failedCheck?.name}' failed with conclusion: ${failedCheck?.conclusion}.`,
          );
        }
      } else {
        const pendingCheckNames = pendingChecks
          .map((run) => run.name)
          .join(', ');
        info(`Waiting for checks to complete: ${pendingCheckNames}`);
      }

      await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
    }
  }

  throw new Error('Timed out waiting for check runs to complete.');
}
