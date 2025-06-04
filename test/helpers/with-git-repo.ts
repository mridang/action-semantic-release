import { SimpleGit, simpleGit } from 'simple-git';

type GitRepoContext = { tmp: string };

export function withGitRepo(
  commits: string[],
  fn: (ctx: GitRepoContext) => Promise<void>,
): (ctx: GitRepoContext) => Promise<void> {
  return async ({ tmp }) => {
    const git: SimpleGit = simpleGit({ baseDir: tmp });
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');

    for (const message of commits) {
      await git.commit(message, [], { '--allow-empty': null });
    }

    await fn({ tmp });
  };
}
