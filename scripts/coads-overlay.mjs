#!/usr/bin/env node
// scripts/coads-overlay.mjs — DEMO HARNESS for the `claude-overlay` surface
// (deliverables 1–3). Lets you SEE a sponsored line inside the Claude Code VS
// Code panel and watch the click round-trip, without packaging the .vsix.
//
// It uses the REAL adapter / loopback / locate code (bundled to
// dist/coads-overlay-lib.cjs), so what you verify here is what the extension ships.
//
// Usage:
//   node scripts/coads-overlay.mjs apply     # backup + relax CSP + inject ad, then
//                                            # run the loopback and print clicks live
//   node scripts/coads-overlay.mjs restore   # revert BOTH files byte-exactly
//   node scripts/coads-overlay.mjs status    # diagnose (located? patched? CSP?)
//
// After `apply`, run "Developer: Reload Window" in the Claude Code VS Code window.
// The sponsored bar appears at the bottom of the panel; clicking it opens the
// advertiser URL AND prints a CLICK line in this terminal.

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let lib;
try {
  lib = require(join(__dirname, '..', 'dist', 'coads-overlay-lib.cjs'));
} catch (e) {
  console.error('✗ dist/coads-overlay-lib.cjs not found. Run `npm run build` first.');
  process.exit(1);
}
const { ClaudeOverlayAdapter, locateClaudeCode, startLoopback } = lib;

// Demo creative (Phase-2 hardcoded ad; real creative comes from the auction queue).
const AD = {
  adText: 'Sponsored: Linear — fast issue tracking →',
  clickUrl: 'https://linear.app',
  iconUrl: '',
};

function locate() {
  const host = locateClaudeCode();
  if (!host || !host.webviewJs) {
    console.error('✗ Could not find an installed Claude Code extension (webview/index.js).');
    process.exit(1);
  }
  return host;
}

function makeAdapter(host) {
  return new ClaudeOverlayAdapter({
    webviewJsPath: host.webviewJs,
    hostJsPath: host.hostJs,
    version: host.version,
  });
}

async function cmdApply() {
  const host = locate();
  console.log(`→ Claude Code ${host.version ?? '?'} at\n   ${host.dir}`);
  const adapter = makeAdapter(host);

  const pf = adapter.preflight();
  if (!pf.compatible) {
    console.error(`✗ incompatible target: ${pf.reason}`);
    process.exit(1);
  }

  // 1) Loopback FIRST so we can bake its URL into the injected block.
  const token = randomUUID().replace(/-/g, '');
  const lb = await startLoopback({
    token,
    onClick: (q) =>
      console.log(`\n💰 CLICK  ad=${q.get('ad')} surface=${q.get('surface')} corr=${q.get('corr')}`),
    onLog: (q) => console.log(`   · log  ${q.toString()}`),
  });
  console.log(`→ loopback listening ${lb.baseUrl}  (token ${token.slice(0, 8)}…)`);

  // 2) Patch (backup + CSP relax + ad block).
  const corr = `ad_demo.${randomUUID().slice(0, 8)}`;
  const res = adapter.applyPatch({
    tier: 0,
    adText: AD.adText,
    iconRef: '',
    iconUrl: AD.iconUrl,
    clickToken: token,
    clickUrl: AD.clickUrl,
    corr,
    loopbackPort: lb.port,
    loopbackToken: token,
    loopbackBase: lb.baseUrl,
    viewThresholdMs: 3000,
    debug: true,
  });
  if (!res.ok) {
    console.error(`✗ applyPatch failed: ${res.reason}`);
    await lb.close();
    process.exit(1);
  }

  console.log('\n✓ Patched. Backups written next to each file (*.boringspinner.bak.<ts>).');
  console.log('\n   NEXT STEP — in the Claude Code VS Code window:');
  console.log('     Cmd+Shift+P → "Developer: Reload Window"');
  console.log('   Then look at the bottom of the Claude Code panel for the sponsored bar.');
  console.log('   Click it → Linear opens in your browser AND a CLICK prints here.\n');
  console.log('   (leave this running; Ctrl+C to stop the loopback, then:');
  console.log('    node scripts/coads-overlay.mjs restore   to revert the bundle)\n');

  process.on('SIGINT', async () => {
    console.log('\n→ stopping loopback (bundle still patched; run `restore` to revert).');
    await lb.close();
    process.exit(0);
  });
}

function cmdRestore() {
  const host = locate();
  const adapter = makeAdapter(host);
  const r = adapter.restore(); // full: ad block + CSP
  if (!r.ok) {
    console.error(`✗ restore failed: ${r.reason}`);
    process.exit(1);
  }
  console.log(`✓ restored byte-exact (${r.restored ? 'reverted' : 'already pristine'}).`);
  console.log('  Reload the Claude Code window to drop the relaxed CSP + ad.');
}

function cmdStatus() {
  const host = locate();
  const adapter = makeAdapter(host);
  const d = adapter.diagnose();
  console.log(JSON.stringify({ host: { dir: host.dir, version: host.version }, diagnose: d }, null, 2));
}

const cmd = process.argv[2] || 'apply';
if (cmd === 'apply') await cmdApply();
else if (cmd === 'restore') cmdRestore();
else if (cmd === 'status') cmdStatus();
else {
  console.error(`unknown command "${cmd}". use: apply | restore | status`);
  process.exit(1);
}
