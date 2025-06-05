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
    resolve({
      exportConditions: ['node', 'default'],   // 1st match wins → ./node.js
      preferBuiltins: true,
    }),
    commonjs({
      include: /node_modules/,            // transform every CJS in node_modules
      requireReturnsDefault: 'auto',

      /* ③ mark every package.json require as “static → bundle it”       */
      dynamicRequireTargets: [
        '**/package.json'                 // globs are relative to project root
      ],
    }),
    json(),
    esbuild({
      target: 'node20',
      tsconfig: './tsconfig.json',
    }),
  ],
  external: []
};
