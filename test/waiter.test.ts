import { jest } from '@jest/globals';

type Check = {
  name: string;
  status: string;
  conclusion: string | null;
  check_suite: { id: number };
};
type WorkflowRun = { event: string; check_suite_id: number };

const listForRef = jest.fn();
const paginate =
  jest.fn<(fn: unknown, params: object) => Promise<Check[] | WorkflowRun[]>>();
const listWorkflowRunsForRepo = jest.fn();
const warning = jest.fn();

jest.unstable_mockModule('@actions/github', () => ({
  getOctokit: () => ({
    paginate,
    rest: {
      checks: { listForRef },
      actions: { listWorkflowRunsForRepo },
    },
  }),
}));
jest.unstable_mockModule('@actions/core', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warning,
}));

const { Context } = await import('@actions/github/lib/context.js');
const { default: waitForAllChecks } = await import('../src/waiter.js');

const ctxFor = (eventName: string) => {
  process.env.GITHUB_REPOSITORY = 'o/r';
  process.env.GITHUB_SHA = 'abc';
  process.env.GITHUB_JOB = 'release';
  process.env.GITHUB_EVENT_NAME = eventName;
  return new Context();
};

const check = (
  name: string,
  suite: number,
  conclusion: string | null = 'success',
): Check => ({
  name,
  status: conclusion ? 'completed' : 'in_progress',
  conclusion,
  check_suite: { id: suite },
});

const workflowRun = (event: string, suite: number): WorkflowRun => ({
  event,
  check_suite_id: suite,
});

let workflowRuns: WorkflowRun[] | Error = [];

const givenChecks = (...runs: Check[]) =>
  paginate.mockImplementation(async (fn) => {
    if (fn === listForRef) return runs;
    if (workflowRuns instanceof Error) throw workflowRuns;
    return workflowRuns;
  });

describe('waitForAllChecks', () => {
  const originalEnv = { ...process.env };

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    workflowRuns = [];
  });

  it('requests every page of check runs', async () => {
    givenChecks(check('release', 1, null), check('build', 1));

    await waitForAllChecks(ctxFor('push'), 'token');

    expect(paginate).toHaveBeenCalledWith(listForRef, {
      owner: 'o',
      repo: 'r',
      ref: 'abc',
      per_page: 100,
    });
  });

  it('fails on a failed check beyond the first 30 runs', async () => {
    const runs = Array.from({ length: 40 }, (_, i) => check(`job-${i}`, 1));
    runs[35] = check('late-job', 1, 'failure');
    givenChecks(check('release', 1, null), ...runs);

    await expect(waitForAllChecks(ctxFor('push'), 'token')).rejects.toThrow(
      "Check 'late-job' failed with conclusion: failure.",
    );
  });

  it('looks up the workflow runs of the release commit', async () => {
    givenChecks(check('release', 1, null));
    workflowRuns = [];

    await waitForAllChecks(ctxFor('push'), 'token');

    expect(paginate).toHaveBeenCalledWith(listWorkflowRunsForRepo, {
      owner: 'o',
      repo: 'r',
      head_sha: 'abc',
      per_page: 100,
    });
  });

  it('ignores failed checks from dynamic and scheduled runs', async () => {
    givenChecks(
      check('release', 1, null),
      check('build', 1),
      check('Dependabot', 2, 'failure'),
      check('Dependabot', 3, 'failure'),
    );
    workflowRuns = [
      workflowRun('push', 1),
      workflowRun('dynamic', 2),
      workflowRun('schedule', 3),
    ];

    await expect(
      waitForAllChecks(ctxFor('push'), 'token'),
    ).resolves.toBeUndefined();
  });

  it('ignores pending checks from dynamic runs', async () => {
    givenChecks(
      check('release', 1, null),
      check('build', 1),
      check('Dependabot', 2, null),
    );
    workflowRuns = [workflowRun('push', 1), workflowRun('dynamic', 2)];

    await expect(
      waitForAllChecks(ctxFor('push'), 'token'),
    ).resolves.toBeUndefined();
  });

  it('still fails on a failed check from a push run', async () => {
    givenChecks(
      check('release', 1, null),
      check('build', 1, 'failure'),
      check('Dependabot', 2, 'failure'),
    );
    workflowRuns = [workflowRun('push', 1), workflowRun('dynamic', 2)];

    await expect(waitForAllChecks(ctxFor('push'), 'token')).rejects.toThrow(
      "Check 'build' failed with conclusion: failure.",
    );
  });

  it('still fails on a failed check from the triggering event', async () => {
    givenChecks(
      check('release', 1, null),
      check('build', 2, 'failure'),
      check('Dependabot', 3, 'failure'),
    );
    workflowRuns = [
      workflowRun('workflow_dispatch', 1),
      workflowRun('workflow_dispatch', 2),
      workflowRun('dynamic', 3),
    ];

    await expect(
      waitForAllChecks(ctxFor('workflow_dispatch'), 'token'),
    ).rejects.toThrow("Check 'build' failed with conclusion: failure.");
  });

  it('still fails on a failed check that has no workflow run', async () => {
    givenChecks(check('release', 1, null), check('external-app', 9, 'failure'));
    workflowRuns = [workflowRun('push', 1)];

    await expect(waitForAllChecks(ctxFor('push'), 'token')).rejects.toThrow(
      "Check 'external-app' failed with conclusion: failure.",
    );
  });

  it('evaluates every check when workflow runs cannot be listed', async () => {
    givenChecks(check('release', 1, null), check('Dependabot', 2, 'failure'));
    workflowRuns = new Error('Resource not accessible');

    await expect(waitForAllChecks(ctxFor('push'), 'token')).rejects.toThrow(
      "Check 'Dependabot' failed with conclusion: failure.",
    );
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Resource not accessible'),
    );
  });
});
