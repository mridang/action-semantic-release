import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import esbuild from 'rollup-plugin-esbuild';

export default {
  input: 'src/index.ts',
  output: {
    file: 'dist/index.cjs',
    format: 'cjs',
    sourcemap: true,
    inlineDynamicImports: true,
  },
  plugins: [
    resolve({ preferBuiltins: true }),
    commonjs(),
    json(),
    esbuild({
      target: 'node20',
      tsconfig: './tsconfig.json',
    }),
  ],
  external: [], // Add external dependencies here if needed
};
