import { SimpleGit, simpleGit } from 'simple-git';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

type GitRepoContext = { tmp: string; remoteUrl: string };

/**
 * A higher-order function for end-to-end testing of Git operations.
 *
 * This function orchestrates a complex test environment that simulates a
 * real-world Git remote setup. It performs the following steps:
 *
 * 1.  Creates a bare Git repository to act as a remote 'origin'.
 * 2.  Sets the bare repository's symbolic HEAD to 'refs/heads/main' to
 * ensure it behaves correctly for remote operations like 'fetch'.
 * 3.  Spawns a live `git daemon` process, creating a lightweight, local
 * Git server on port 9418 to serve the bare repository.
 * 4.  Clones the bare repository via the daemon to create a local
 * working copy, simulating a developer's checkout.
 * 5.  Populates the local repository with an initial history based on
 * the provided commit messages.
 * 6.  Pushes this history to the simulated remote daemon.
 * 7.  Executes the provided test function within this fully-configured
 * Git environment.
 * 8.  Guarantees the cleanup of the spawned `git daemon` process,
 * preventing orphaned processes after the test completes.
 *
 * @param commits An array of strings, where each string is used as the
 * message for an initial empty commit.
 * @param fn The asynchronous test function to execute. It receives a
 * context object containing `tmp` (the path to the local working
 * directory) and `remoteUrl` (the URL of the temporary Git daemon).
 * @returns A new async function that, when called, performs the entire
 * setup, execution, and cleanup process.
 */
export function withGitRepo(
  commits: string[],
  fn: (ctx: GitRepoContext) => Promise<void>,
) {
  return async ({ tmp: baseTmp }: { tmp: string }): Promise<void> => {
    const remotePath = join(baseTmp, 'remote.git');
    const localPath = join(baseTmp, 'local');
    const remoteUrl = `git://127.0.0.1:9418/remote.git`;

    mkdirSync(remotePath);
    mkdirSync(localPath);

    const remoteGit: SimpleGit = simpleGit(remotePath);
    await remoteGit.init(true);

    await remoteGit.raw('symbolic-ref', 'HEAD', 'refs/heads/master');

    const daemon: ChildProcess = spawn('git', [
      'daemon',
      `--base-path=${baseTmp}`,
      '--export-all',
      '--enable=receive-pack',
      '--port=9418',
      '--reuseaddr',
    ]);

    let daemonClosed = false;
    daemon.on('close', () => {
      daemonClosed = true;
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 200));

      const git: SimpleGit = simpleGit();
      await git.clone(remoteUrl, localPath);

      await git.cwd(localPath);
      await git.checkout(['-b', 'master']);

      await git.addConfig('user.name', 'Test User');
      await git.addConfig('user.email', 'test@example.com');

      for (const message of commits) {
        await git.commit(message, [], { '--allow-empty': null });
      }

      await git.push(['-u', 'origin', 'master']);

      await fn({ tmp: localPath, remoteUrl });
    } finally {
      daemon.kill();
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (daemonClosed) {
            clearInterval(interval);
            resolve();
          }
        }, 50);
      });
    }
  };
}
