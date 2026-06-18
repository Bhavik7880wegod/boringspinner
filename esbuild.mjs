// esbuild.mjs — single-file CJS bundle build → dist/extension.js
// Bundles src/extension.ts into one CommonJS file with `vscode` left external.
import { build } from 'esbuild';

const watch = process.argv.includes('--watch');

const opts = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // `vscode` is provided by the host at runtime — must stay external.
  external: ['vscode'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

await build(opts);

// Second entry: the standalone overlay demo/apply library (no vscode runtime).
// Consumed by scripts/coads-overlay.mjs so the demo runs the real adapter code.
await build({
  entryPoints: ['src/tools/overlayLib.ts'],
  bundle: true,
  outfile: 'dist/coads-overlay-lib.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'], // lazily required by log.ts; absent in plain node (handled)
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});
// Third entry: the standalone `boringspinner` terminal CLI (no vscode runtime).
// Shebang banner so the bundled file is directly executable as the `bin`.
await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  outfile: 'dist/cli.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'], // lazily required by log.ts; absent in plain node (handled)
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

if (watch) {
  // Phase 1: no watch mode wired; flag accepted for parity with future phases.
  console.log('[coads] --watch is a no-op in Phase 1');
}
