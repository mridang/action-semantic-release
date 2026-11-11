/**
 * @file Tests that the cosmiconfig loaders write the package.json and lock
 * file needed for declarative and imperative semantic-release configurations.
 */
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { cosmiconfig } from 'cosmiconfig';
import { createLoaders } from '../src/loaders.js';
import { stringify as toYaml } from 'yaml';

/**
 * Runs a test body inside a freshly created temporary directory and removes
 * the directory afterwards, even when the body fails.
 * @param fn - The test body that receives the temporary directory path.
 * @returns A function that runs `fn` inside the temporary directory.
 * @example
 * ```ts
 * await withTempDir(async ({ tmp }) => {
 *   await writeFile(path.join(tmp, '.releaserc.json'), '{}');
 * })();
 * ```
 */
function withTempDir(fn: (ctx: { tmp: string }) => void | Promise<void>) {
  return async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'test-'));
    try {
      await fn({ tmp });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  };
}

const baseConfig = {
  branches: ['main'],
  plugins: [
    '@semantic-release/commit-analyzer',
    ['@mridang/semantic-release-peer-version', { repo: 'github/github' }],
  ],
};

it.each([
  ['.releaserc.json', true, JSON.stringify(baseConfig, null, 2)],
  ['.releaserc.yaml', true, toYaml(baseConfig)],
  ['.releaserc.yml', true, toYaml(baseConfig)],
  ['.releaserc', true, toYaml(baseConfig)],
  ['release.config.js', false, `module.exports = {};`],
  ['release.config.cjs', false, `module.exports = {};`],
  ['release.config.mjs', false, `export default {};`],
  ['release.config.ts', false, `export default {};`],
])(
  'correctly handles %s config with isDeclarative = %s',
  (filename, isDeclarative, contents) =>
    withTempDir(async ({ tmp }) => {
      const filepath = path.join(tmp, filename);
      await writeFile(filepath, contents);

      if (!isDeclarative) {
        await writeFile(
          path.join(tmp, 'package.json'),
          JSON.stringify(
            {
              name: 'imperative',
              version: '1.0.0',
              devDependencies: {
                '@semantic-release/commit-analyzer': '*',
                '@mridang/semantic-release-peer-version': '*',
              },
            },
            null,
            2,
          ),
        );
      }

      const explorer = cosmiconfig('release', {
        stopDir: tmp,
        loaders: createLoaders(),
      });

      const result = await explorer.search(tmp);
      expect(result?.filepath).toBe(filepath);

      const pkgJsonPath = path.join(tmp, 'package.json');
      const pkgLockPath = path.join(tmp, 'package-lock.json');

      await expect(access(pkgJsonPath)).resolves.toBeUndefined();
      await expect(access(pkgLockPath)).resolves.toBeUndefined();

      const pkgJson = JSON.parse(await readFile(pkgJsonPath, 'utf8'));
      const deps = pkgJson.dependencies || pkgJson.devDependencies;
      expect(deps).toMatchObject({
        '@semantic-release/commit-analyzer': '*',
        '@mridang/semantic-release-peer-version': '*',
      });

      const pkgLock = JSON.parse(await readFile(pkgLockPath, 'utf8'));
      expect(pkgLock.packages).toHaveProperty(
        'node_modules/@semantic-release/commit-analyzer',
      );
      expect(pkgLock.packages).toHaveProperty(
        'node_modules/@mridang/semantic-release-peer-version',
      );
    })(),
);
