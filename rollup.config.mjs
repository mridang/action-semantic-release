import alias from '@rollup/plugin-alias';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import esbuild from 'rollup-plugin-esbuild';
import { resolve as r, dirname } from 'node:path';
import { readFileSync } from 'node:fs';

const badJson = r('node_modules/@pnpm/npm-conf/lib/tsconfig.make-out.json');

const inlinePackageJsonPlugin = {
  name: 'inline-package-json',
  transform(code, id) {
    if (!id.includes('node_modules')) {
      return null;
    }

    const requirePattern = /require\((['"`])(.+?package\.json)\1\)/g;

    if (!requirePattern.test(code)) {
      return null;
    }

    const newCode = code.replace(
      requirePattern,
      (match, quote, requiredPath) => {
        try {
          const pkgPath = r(dirname(id), requiredPath);
          const pkgContent = readFileSync(pkgPath, 'utf-8');
          return pkgContent;
        } catch (e) {
          this.warn(
            `Failed to inline '${requiredPath}' for ${id}: ${e.message}`,
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

export default {
  input: 'src/main.ts',
  output: {
    file: 'dist/main.cjs',
    format: 'cjs',
    sourcemap: false,
    inlineDynamicImports: true,
  },
  onwarn(warning, warn) {
    if (warning.code === 'CIRCULAR_DEPENDENCY') {
      return;
    }
    warn(warning);
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

    json({
      preferConst: true,
      compact: true,
    }),
    resolve({ exportConditions: ['node', 'default'], preferBuiltins: true }),
    commonjs({
      include: /node_modules/,
      requireReturnsDefault: 'auto',
    }),
    esbuild({
      target: 'node20',
      tsconfig: './tsconfig.json',
    }),
  ],
  external: [],
};
