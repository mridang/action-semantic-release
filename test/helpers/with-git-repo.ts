// file: test/helpers/with-git-repo.ts
import { SimpleGit, simpleGit } from 'simple-git';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

type GitRepoContext = { tmp: string; remoteUrl: string };

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

    // 1. Initialize the bare remote repository.
    const remoteGit: SimpleGit = simpleGit(remotePath);
    await remoteGit.init(true); // `true` for bare

    // ===================================================================
    // FIX: Set the symbolic reference for HEAD in the bare repository.
    // This tells Git that 'main' is the default branch for this remote.
    // It's necessary for remote commands like 'git fetch' to succeed.
    await remoteGit.raw('symbolic-ref', 'HEAD', 'refs/heads/main');
    // ===================================================================

    const daemon = spawn('git', [
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

      // The rest of the logic remains the same.
      const git: SimpleGit = simpleGit();
      await git.clone(remoteUrl, localPath);

      await git.cwd(localPath);
      await git.checkout(['-b', 'main']);

      await git.addConfig('user.name', 'Test User');
      await git.addConfig('user.email', 'test@example.com');

      for (const message of commits) {
        await git.commit(message, [], { '--allow-empty': null });
      }

      await git.push(['-u', 'origin', 'main']);

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
