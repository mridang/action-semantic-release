import { SimpleGit, simpleGit } from 'simple-git';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo, Server as HttpServer } from 'node:net';
import { Git } from 'node-git-server';

type GitRepoContext = { tmp: string; remoteUrl: string };

/**
 * A higher-order function for realistic, end-to-end testing of Git operations.
 *
 * This function creates a fully isolated Git test environment over HTTP,
 * preventing any overlap or state leakage between tests.
 */
export function withGitRepo(
  commits: string[],
  fn: (ctx: GitRepoContext) => Promise<void>,
) {
  return async ({ tmp: baseTmp }: { tmp: string }): Promise<void> => {
    const repoDir = join(baseTmp, 'repos');
    mkdirSync(repoDir, { recursive: true });

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
      const localPath = join(baseTmp, 'local');
      mkdirSync(localPath);

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
