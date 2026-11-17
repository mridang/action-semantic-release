/**
 * @file Rollup configuration that bundles the action entrypoint into a single
 * CommonJS file, inlining the package.json files that dependencies require.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';

const NODE_BUILTINS = builtinModules.flatMap((name) => [name, `node:${name}`]);

/** Matches the node_modules directory in a module path. */
const NODE_MODULES_PATTERN = /node_modules/u;

/**
 * Rollup plugin that inlines the package.json files that dependencies require. It is a class so that the
 * plugin context Rollup passes as this to each hook is a legitimate use of this.
 */
class InlinePackageJsonPlugin {
  name = 'inline-json';

  async transform(code, id) {
    if (!id.includes('node_modules')) {
      return null;
    }

    const requirePattern =
      /require\((['"`])([-./\w]+?(?:package\.json|commitlint\.schema\.json))\1\)/gu;

    const matches = [...code.matchAll(requirePattern)];
    const replacements = await Promise.all(
      matches.map(async ([match, , requiredPath]) => {
        try {
          const filePath = path.resolve(path.dirname(id), requiredPath);
          return await readFile(filePath, 'utf8');
        } catch (error) {
          this.warn(
            `Failed to inline '${requiredPath}' for ${id}: ${error.message}`,
          );
          return match;
        }
      }),
    );
    const segmentStart = (index) =>
      index === 0 ? 0 : matches[index - 1].index + matches[index - 1][0].length;
    const rewrittenCode =
      matches
        .map(
          (found, index) =>
            code.slice(segmentStart(index), found.index) + replacements[index],
        )
        .join('') + code.slice(segmentStart(matches.length));

    return {
      code: rewrittenCode,
      map: null,
    };
  }
}

/**
 * Creates the Rollup configuration that bundles the action into `dist/main.cjs`.
 * @param {object} [configOverrides] - Optional overrides; `typescript` is merged into the
 * `@rollup/plugin-typescript` options.
 * @returns {Omit<import('rollup').RollupOptions, 'output'> & { output: import('rollup').OutputOptions }} The Rollup input and output options.
 * @example
 * ```js
 * import createRollupConfig from './rollup.config.mjs';
 * const config = createRollupConfig({ typescript: { sourceMap: true } });
 * ```
 */
function createRollupConfig(configOverrides = {}) {
  return {
    input: 'src/main.ts',
    output: {
      file: 'dist/main.cjs',
      format: 'cjs',
      sourcemap: true,
      inlineDynamicImports: true,
      interop: (id) => {
        // For Node.js built-in modules (e.g., 'buffer', 'fs/promises'):
        // Return 'default' to ensure they are treated as pure CommonJS modules,
        // without extra '.default' wrappers, matching Node.js's native behavior.
        if (NODE_BUILTINS.includes(id)) {
          return 'default';
        }
        // For all other modules (e.g., 'jwt-decode'), return 'esModule' to ensure
        // they get the `__esModule: true` flag, allowing `import Foo from 'foo'` to work.
        return 'esModule';
      },
    },
    onwarn(warning, warn) {
      switch (warning.code) {
        case 'CIRCULAR_DEPENDENCY':
        case 'THIS_IS_UNDEFINED': {
          return;
        }
        default: {
          warn(warning);
        }
      }
    },
    plugins: [
      json({
        preferConst: true,
        compact: true,
      }),
      new InlinePackageJsonPlugin(),
      resolve({
        exportConditions: ['node', 'default'],
        preferBuiltins: true,
      }),
      commonjs({
        include: NODE_MODULES_PATTERN,
        requireReturnsDefault: () => 'auto',
        ignore: NODE_BUILTINS,
      }),
      typescript({
        tsconfig: './tsconfig.json',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        ...configOverrides.typescript,
      }),
    ],
    external: NODE_BUILTINS,
  };
}

export default createRollupConfig;
