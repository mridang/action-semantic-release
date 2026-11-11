/**
 * @file Rollup configuration that bundles the action entrypoint into a single
 * CommonJS file, inlining the package.json files that dependencies require.
 */
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import typescript from '@rollup/plugin-typescript';

const NODE_BUILTINS = builtinModules.reduce(
  (acc, name) => [...acc, name, `node:${name}`],
  [],
);

const inlinePackageJsonPlugin = {
  name: 'inline-json',
  transform(code, id) {
    if (!id.includes('node_modules')) {
      return null;
    }

    const requirePattern =
      /require\((['"`])([-./\w]+?(?:package\.json|commitlint\.schema\.json))\1\)/g;

    const newCode = code.replaceAll(
      requirePattern,
      (match, _quote, requiredPath) => {
        try {
          const filePath = path.resolve(path.dirname(id), requiredPath);
          // eslint-disable-next-line n/no-sync -- sync is fine in a script/bootstrap
          return readFileSync(filePath, 'utf8');
        } catch (error) {
          // eslint-disable-next-line unicorn/no-this-outside-of-class -- rollup supplies the plugin context as this
          this.warn(
            `Failed to inline '${requiredPath}' for ${id}: ${error.message}`,
          );
          return match;
        }
      },
    );

    return {
      code: newCode,
      map: null,
    };
  },
};

/**
 * Creates the Rollup configuration that bundles the action into `dist/main.cjs`.
 * @param {object} [configOverrides] - Optional overrides; `typescript` is merged into the
 * `@rollup/plugin-typescript` options.
 * @returns {object} The Rollup input and output options.
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
      inlinePackageJsonPlugin,
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
