/**
 * @file Test helper that serves a freshly created Git repository over HTTP
 * for end-to-end tests of Git operations.
 */
import { SimpleGit, simpleGit } from 'simple-git';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo, Server as HttpServer } from 'node:net';
import { Git } from 'node-git-server';

type GitRepoContext = { tmp: string; remoteUrl: string };

/**
 * A higher-order function for realistic, end-to-end testing of Git operations.
 *
 * This function creates a fully isolated Git test environment over HTTP,
 * preventing any overlap or state leakage between tests.
 * @param commits - The commit messages to create, in order, on the `master` branch.
 * @param fn - The test body that receives the local checkout path and the remote URL.
 * @returns A function that sets up the repository inside the given directory and runs `fn`.
 * @example
 * ```ts
 * await withGitRepo(['feat: init'], async ({ tmp, remoteUrl }) => {
 *   console.log(tmp, remoteUrl);
 * })({ tmp: await mkdtemp(path.join(os.tmpdir(), 'repo-')) });
 * ```
 */
export function withGitRepo(
  commits: string[],
  fn: (ctx: GitRepoContext) => Promise<void>,
) {
  return async ({ tmp: baseTmp }: { tmp: string }): Promise<void> => {
    const repoDir = path.join(baseTmp, 'repos');
    await mkdir(repoDir, { recursive: true });

    const server = new Git(repoDir, {
      autoCreate: true,
    });

    server.on('push', (push) => push.accept());
    server.on('fetch', (fetch) => fetch.accept());

    try {
      const port = await new Promise<number>((resolve, reject) => {
        server.listen(0, undefined, () => {
          const internalHttpServer = server.server as HttpServer;
          const port = (internalHttpServer.address() as AddressInfo).port;
          resolve(port);
        });
        server.on('error', reject);
      });

      const remoteUrl = `http://127.0.0.1:${port}/remote.git`;
      const localPath = path.join(baseTmp, 'local');
      await mkdir(localPath);

      const git: SimpleGit = simpleGit(localPath);

      await git.init();
      await git.addRemote('origin', remoteUrl);
      await git.addConfig('user.name', 'Test User');
      await git.addConfig('user.email', 'test@example.com');
      await git.checkout(['-b', 'master']);

      for (const message of commits) {
        await git.commit(message, [], { '--allow-empty': null });
      }

      await git.push(['-u', 'origin', 'master']);

      await fn({ tmp: localPath, remoteUrl });
    } finally {
      if (server.server?.listening) {
        await server.close();
      }
    }
  };
}
