/**
 * @file Test helper that creates a temporary directory for an asynchronous
 * test body.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A higher-order function that creates a temporary directory for an
 * asynchronous operation and guarantees its cleanup.
 *
 * It provides a safe and isolated file system scope for tests that
 * need to create files or clone repositories. The temporary directory
 * and all its contents are automatically deleted after the provided
 * function has finished executing, even if it throws an error.
 * @template T The type of the function to execute, which must accept
 * a context object with the temporary directory path (`tmp`) and
 * return a Promise.
 * @param fn - The asynchronous function to execute. It receives an object
 * containing the `tmp` property, which is the path to the created
 * temporary directory.
 * @returns A new async function that, when called, will set up the
 * temporary directory and run the provided function.
 * @example
 * ```ts
 * await withTempDir(async ({ tmp }) => {
 *   await writeFile(path.join(tmp, 'notes.txt'), 'hello');
 * })();
 * ```
 */
export function withTempDir<T extends (ctx: { tmp: string }) => Promise<void>>(
  fn: T,
) {
  return async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'test-'));
    await fn({ tmp });
  };
}
