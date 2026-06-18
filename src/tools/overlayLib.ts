// src/tools/overlayLib.ts — entry point for the standalone `coads-overlay` demo
// tool (scripts/coads-overlay.mjs). esbuild bundles this to
// dist/coads-overlay-lib.cjs so the demo exercises the EXACT same adapter /
// loopback / locate code the shipped extension uses — no duplicated logic.
//
// Nothing here may require the `vscode` runtime at import time.

export { ClaudeOverlayAdapter } from '../adapters/claude-code/adapter';
export { locateClaudeCode, locateHost } from '../locate';
export { startLoopback } from '../loopback';
export {
  hasOverlayBlock,
  hasCspRelax,
  relaxCsp,
  restoreCsp,
} from '../adapters/claude-code/injection';
