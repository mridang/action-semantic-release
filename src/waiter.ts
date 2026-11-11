/**
 * @file Waits for the other GitHub check runs on the current commit to finish
 * successfully before the release is allowed to proceed.
 */
import type { context } from '@actions/github';
import { getOctokit } from '@actions/github';
import { debug as logDebug, info, warning } from '@actions/core';

const CHECK_TIMEOUT_MS = 20 * 60 * 1000;
const CHECK_INTERVAL_MS = 2 * 1000;
const PASSING_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

/**
 * Tells whether a finished check run counts as a pass.
 * @param conclusion - The conclusion reported for the check run, if any.
 * @returns `true` for success, skipped and neutral conclusions.
 * @example
 * ```ts
 * const passed = isPassing('success'); // true
 * ```
 */
function isPassing(conclusion: string | null | undefined): boolean {
  return PASSING_CONCLUSIONS.has(conclusion ?? '');
}

/**
 * Collects the check suites that belong to workflow runs not triggered by the
 * release event, such as scheduled or dynamic runs. Their checks are ignored.
 * If the workflow runs cannot be listed, no suite is excluded and a warning is raised.
 * @param octokit - The authenticated GitHub API client.
 * @param owner - The owner of the repository.
 * @param repo - The name of the repository.
 * @param ref - The commit SHA the checks are attached to.
 * @param allowedEvents - The events whose check suites must still be evaluated.
 * @returns The IDs of the check suites to exclude.
 * @example
 * ```ts
 * const excluded = await findExcludedSuites(octokit, 'owner', 'repo', sha, new Set(['push']));
 * ```
 */
async function findExcludedSuites(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
  ref: string,
  allowedEvents: Set<string>,
): Promise<Set<number>> {
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
  return excludedSuites;
}

/**
 * Waits for all *other* GitHub check runs on the current commit to complete
 * and be successful.
 *
 * This version includes a refined heuristic based on the list of PENDING checks
 * to correctly identify and bypass a deadlock caused by a custom job name.
 * @param ghCtx - The GitHub Actions context object.
 * @param token - The GitHub token for API authentication.
 * @returns A Promise that resolves when all other check runs are successful.
 * @throws If any other check run fails or if the monitoring times out.
 * @example
 * ```ts
 * await waitForAllChecks(context, process.env.GITHUB_TOKEN ?? '');
 * ```
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
  logDebug(`Identifying self as job ID: '${selfIdentifier}'`);

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
    const excludedSuites = await findExcludedSuites(
      octokit,
      owner,
      repo,
      ref,
      allowedEvents,
    );
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
      const allSuccessful = otherRuns.every((run) => isPassing(run.conclusion));

      if (allSuccessful) {
        info('All other check runs have completed successfully.');
        return;
      } else {
        const failedCheck = otherRuns.find((run) => !isPassing(run.conclusion));
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
