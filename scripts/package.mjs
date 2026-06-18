// scripts/package.mjs — produces coads.vsix (NOT coads-ai.vsix).
// Ensures the icon + bundle exist, runs `vsce package`, and verifies the
// artifact is < 2 MB (§5.1 build-size budget).
import { execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const out = join(root, 'coads.vsix');

const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

// 1. Icon (manifest references media/icon.png).
if (!existsSync(join(root, 'media', 'icon.png'))) {
  run('node', ['scripts/gen-icon.mjs']);
}

// 2. Bundle (dist/extension.js).
if (!existsSync(join(root, 'dist', 'extension.js'))) {
  run('node', ['esbuild.mjs']);
}

// 3. Package via vsce → coads.vsix.
//    --no-dependencies: we ship a self-contained esbuild bundle.
//    --allow-missing-repository + --baseContentUrl: no repo field in the
//    verbatim §5.3 manifest, so silence vsce's README-link repo inference.
run('npx', [
  'vsce',
  'package',
  '--no-dependencies',
  '--allow-missing-repository',
  '--baseContentUrl',
  'https://boringspinner.com',
  '--out',
  out,
]);

// 4. Size budget check (< 2 MB).
const bytes = statSync(out).size;
const MB = bytes / (1024 * 1024);
console.log(`[coads] ${out} = ${bytes} bytes (${MB.toFixed(3)} MB)`);
if (bytes >= 2 * 1024 * 1024) {
  console.error('[coads] FAIL: .vsix exceeds 2 MB build budget (§5.1).');
  process.exit(1);
}
console.log('[coads] OK: under 2 MB budget.');
