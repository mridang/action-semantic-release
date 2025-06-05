import alias from '@rollup/plugin-alias';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import esbuild from 'rollup-plugin-esbuild';
import { resolve as r, dirname } from 'node:path';
import { readFileSync } from 'node:fs';

const badJson = r(
  'node_modules/@pnpm/npm-conf/lib/tsconfig.make-out.json'
);

/**
 * ✅ A more powerful custom plugin to find and inline any `require(".../package.json")`
 * call made from within ES Modules in your dependencies.
 */
const inlinePackageJsonPlugin = {
  name: 'inline-package-json',
  transform(code, id) {
    // Only run on files inside node_modules
    if (!id.includes('node_modules')) {
      return null;
    }

    // Regex to find requires of any path ending in package.json
    // e.g., require('./package.json'), require('../../package.json')
    const requirePattern = /require\((['"`])(.+?package\.json)\1\)/g;

    // Don't proceed if the pattern doesn't exist at all
    if (!requirePattern.test(code)) {
      return null;
    }

    // Use replace with a replacer function to handle all matches
    const newCode = code.replace(requirePattern, (match, quote, requiredPath) => {
      try {
        // Find the correct package.json relative to the file being processed
        const pkgPath = r(dirname(id), requiredPath);
        const pkgContent = readFileSync(pkgPath, 'utf-8');
        // Return the file content to replace the require() call
        return pkgContent;
      } catch (e) {
        // If the file can't be found, warn but don't break the build.
        // Return the original match so we don't change the code.
        this.warn(`Failed to inline '${requiredPath}' for ${id}: ${e.message}`);
        return match;
      }
    });

    return {
      code: newCode,
      map: null, // Invalidate the source map for this transformation
    };
  },
};


export default {
  input: 'src/main.ts',
  output: {
    file: 'dist/index.cjs',
    format: 'cjs',
    sourcemap: true,
    inlineDynamicImports: true,
  },
  plugins: [
    alias({ entries: [{ find: badJson, replacement: '\0empty-json' }] }),
    {
      name: 'empty-json',
      resolveId(id) {
        return id === '\0empty-json' ? id : null;
      },
      load(id) {
        if (id === '\0empty-json') return 'export default {};';
      },
    },

    // ✅ Use our new, more robust plugin
    inlinePackageJsonPlugin,

    json({
      preferConst: true,
      compact: true,
    }),
    resolve({ exportConditions: ['node', 'default'], preferBuiltins: true }),
    commonjs({
      include: /node_modules/,
      requireReturnsDefault: 'auto',
    }),
    esbuild({ target: 'node20', tsconfig: './tsconfig.json' }),
  ],
  external: [],
};
