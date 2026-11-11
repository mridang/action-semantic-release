/**
 * @file Rollup configuration that bundles the action entrypoint into a single
 * CommonJS file, inlining the package.json files that dependencies require.
 */
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import typescript from '@rollup/plugin-typescript';

const NODE_BUILTINS = builtinModules.reduce(
  (acc, name) => [...acc, name, `node:${name}`],
  [],
);

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
      /require\((['"`])([-./\w]+?(?:package\.json|commitlint\.schema\.json))\1\)/g;

    let newCode = '';
    let lastIndex = 0;
    for (const found of code.matchAll(requirePattern)) {
      const [match, , requiredPath] = found;
      let replacement = match;
      try {
        const filePath = path.resolve(path.dirname(id), requiredPath);
        replacement = await readFile(filePath, 'utf8');
      } catch (error) {
        this.warn(
          `Failed to inline '${requiredPath}' for ${id}: ${error.message}`,
        );
      }
      newCode += code.slice(lastIndex, found.index) + replacement;
      lastIndex = found.index + match.length;
    }
    newCode += code.slice(lastIndex);

    return {
      code: newCode,
      map: null,
    };
  }
}

/**
 * Creates the Rollup configuration that bundles the action into `dist/main.cjs`.
 * @param {object} [configOverrides] - Optional overrides; `typescript` is merged into the
 * `@rollup/plugin-typescript` options.
 * @returns {import('rollup').RollupOptions & { output: import('rollup').OutputOptions }} The Rollup input and output options.
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
        include: /node_modules/,
        requireReturnsDefault: () => {
          return 'auto';
        },
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
