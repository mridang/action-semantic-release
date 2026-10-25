import { jest } from '@jest/globals';

const paginate = jest.fn<(...args: unknown[]) => Promise<unknown[]>>();
const listForRef = jest.fn();

jest.unstable_mockModule('@actions/github', () => ({
  getOctokit: () => ({
    paginate,
    rest: { checks: { listForRef } },
  }),
}));
jest.unstable_mockModule('@actions/core', () => ({
  debug: jest.fn(),
  info: jest.fn(),
}));

const { default: waitForAllChecks } = await import('../src/waiter.js');

const ctx = {
  repo: { owner: 'o', repo: 'r' },
  sha: 'abc',
  job: 'release',
} as never;

const run = (name: string, conclusion: string | null = 'success') => ({
  name,
  status: conclusion ? 'completed' : 'in_progress',
  conclusion,
});

describe('waitForAllChecks', () => {
  beforeEach(() => {
    paginate.mockReset();
  });

  it('requests every page of check runs', async () => {
    paginate.mockResolvedValue([run('release', null), run('build')]);

    await waitForAllChecks(ctx, 'token');

    expect(paginate).toHaveBeenCalledWith(listForRef, {
      owner: 'o',
      repo: 'r',
      ref: 'abc',
      per_page: 100,
    });
  });

  it('fails on a failed check beyond the first 30 runs', async () => {
    const runs = Array.from({ length: 40 }, (_, i) => run(`job-${i}`));
    runs[35] = run('late-job', 'failure');
    paginate.mockResolvedValue([run('release', null), ...runs]);

    await expect(waitForAllChecks(ctx, 'token')).rejects.toThrow(
      "Check 'late-job' failed with conclusion: failure.",
    );
  });
});
