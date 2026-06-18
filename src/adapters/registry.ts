// src/adapters/registry.ts — constructs the active TargetAdapter list from the
// hosts located on disk (§5.6 step 5: "Construct adapters").
//
// Today this wires the Claude Code webview surfaces:
//   • `claude-overlay` — surface 1 (primary spinner clobber).
//   • `claude-banner`  — surface 2 (usage-limit banner; server-gated by
//                        `banner_enabled` via PatchParams.bannerOn).
//
// Both share the SAME located `webview/index.js` bundle but are INDEPENDENT
// adapters with their own markers, backups, and apply/restore — so each can be
// toggled, primed, and restored without disturbing the other.
//
// Pure construction + location: never throws, no patching here. Returns null
// entries when a host isn't installed so callers can surface "incompatible".

import type { TargetAdapter } from './types';
import { ClaudeOverlayAdapter } from './claude-code/adapter';
import { ClaudeBannerAdapter } from './claude-banner/adapter';
import { locateClaudeCode, type LocatedHost } from '../locate';

export interface ActiveAdapters {
  host: LocatedHost | null;
  overlay: ClaudeOverlayAdapter | null;
  banner: ClaudeBannerAdapter | null;
  all: TargetAdapter[];
}

// Build the active adapter set from the located Claude Code host. Surfaces whose
// target bundle is missing are returned as null (caller surfaces "incompatible").
export function buildClaudeCodeAdapters(roots?: string[]): ActiveAdapters {
  const host = locateClaudeCode(roots);
  if (!host || !host.webviewJs) {
    return { host, overlay: null, banner: null, all: [] };
  }

  const overlay = new ClaudeOverlayAdapter({
    webviewJsPath: host.webviewJs,
    hostJsPath: host.hostJs,
    version: host.version,
  });
  const banner = new ClaudeBannerAdapter({
    webviewJsPath: host.webviewJs,
    version: host.version,
  });

  return { host, overlay, banner, all: [overlay, banner] };
}

// Construct ONLY the banner adapter for the located host (null if not present).
// Convenience for the banner-specific serving path (server `banner_enabled`).
export function locateBannerAdapter(roots?: string[]): ClaudeBannerAdapter | null {
  const host = locateClaudeCode(roots);
  if (!host || !host.webviewJs) return null;
  return new ClaudeBannerAdapter({ webviewJsPath: host.webviewJs, version: host.version });
}
