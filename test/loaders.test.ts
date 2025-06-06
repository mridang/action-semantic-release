import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cosmiconfig } from 'cosmiconfig';
import { createLoaders } from '../src/loaders.js';
import * as YAML from 'yaml';

function withTempDir(fn: (ctx: { tmp: string }) => void | Promise<void>) {
  return async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'test-'));
    try {
      await fn({ tmp });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
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
  ['.releaserc.yaml', true, YAML.stringify(baseConfig)],
  ['.releaserc.yml', true, YAML.stringify(baseConfig)],
  ['.releaserc', true, YAML.stringify(baseConfig)],
  ['release.config.js', false, `module.exports = {};`],
  ['release.config.cjs', false, `module.exports = {};`],
  ['release.config.mjs', false, `export default {};`],
  ['release.config.ts', false, `export default {};`],
])(
  'correctly handles %s config with isDeclarative = %s',
  (filename, isDeclarative, contents) =>
    withTempDir(async ({ tmp }) => {
      const filepath = join(tmp, filename);
      writeFileSync(filepath, contents);

      if (!isDeclarative) {
        writeFileSync(
          join(tmp, 'package.json'),
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

      const pkgJsonPath = join(tmp, 'package.json');
      const pkgLockPath = join(tmp, 'package-lock.json');

      expect(existsSync(pkgJsonPath)).toBe(true);
      expect(existsSync(pkgLockPath)).toBe(true);

      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      const deps = pkgJson.dependencies || pkgJson.devDependencies;
      expect(deps).toMatchObject({
        '@semantic-release/commit-analyzer': '*',
        '@mridang/semantic-release-peer-version': '*',
      });

      const pkgLock = JSON.parse(readFileSync(pkgLockPath, 'utf8'));
      expect(pkgLock.packages).toHaveProperty(
        'node_modules/@semantic-release/commit-analyzer',
      );
      expect(pkgLock.packages).toHaveProperty(
        'node_modules/@mridang/semantic-release-peer-version',
      );
    })(),
);
