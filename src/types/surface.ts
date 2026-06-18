// src/types/surface.ts — AdSurface union type (§5.7 / §3).
// The five surface ids verbatim, in spec order.

export type AdSurface =
  | 'claude-overlay'
  | 'claude-banner'
  | 'codex-shimmer'
  | 'claude-cli-statusline'
  | 'claude-cli-spinner';

// Canonical, ordered list of every surface id (§3). Tested in surface.test.ts.
export const AD_SURFACES: readonly AdSurface[] = [
  'claude-overlay',
  'claude-banner',
  'codex-shimmer',
  'claude-cli-statusline',
  'claude-cli-spinner',
] as const;
