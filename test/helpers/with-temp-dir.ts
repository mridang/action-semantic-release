import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function withTempDir<T extends (ctx: { tmp: string }) => Promise<void>>(
  fn: T,
) {
  return async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'test-'));
    try {
      await fn({ tmp });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}
