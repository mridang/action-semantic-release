/* eslint-disable testing-library/no-debugging-utils */
import type { context } from '@actions/github';
import { getOctokit } from '@actions/github';
import { debug, info, warning } from '@actions/core';

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
  ghCtx: typeof context,
  token: string,
): Promise<void> {
  const octokit = getOctokit(token);
  const { owner, repo } = ghCtx.repo;
  const ref = ghCtx.sha;
  const selfIdentifier = ghCtx.job;
  const deadline = Date.now() + CHECK_TIMEOUT_MS;

  info(`Starting check run monitoring for ref ${ref}`);
  debug(`Identifying self as job ID: '${selfIdentifier}'`);

  const allowedEvents = new Set(['push', ghCtx.eventName]);

  while (Date.now() < deadline) {
    const checkRuns = await octokit.paginate(octokit.rest.checks.listForRef, {
      owner,
      repo,
      ref,
      per_page: 100,
    });
    // Scheduled and dynamic runs (e.g. Dependabot) attach to the latest commit
    // of the default branch but are unrelated to the release being gated.
    const excludedSuites = new Set<number>();
    try {
      const workflowRuns = await octokit.paginate(
        octokit.rest.actions.listWorkflowRunsForRepo,
        { owner, repo, head_sha: ref, per_page: 100 },
      );
      for (const run of workflowRuns) {
        if (!allowedEvents.has(run.event) && run.check_suite_id !== undefined) {
          excludedSuites.add(run.check_suite_id);
        }
      }
    } catch (error) {
      warning(
        `Could not list workflow runs (needs actions: read on private repositories), so checks from non-push runs are not excluded: ${error}`,
      );
    }
    const allRuns = checkRuns.filter(
      (run) =>
        run.check_suite?.id === undefined ||
        !excludedSuites.has(run.check_suite.id),
    );

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
