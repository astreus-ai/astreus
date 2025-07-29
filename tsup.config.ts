import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  outExtension: ({ format }) => ({
    js: format === 'esm' ? '.mjs' : '.cjs',
  }),
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false, // Disable minify to preserve decorator inheritance
  keepNames: true, // Preserve function names for proper inheritance
}); 