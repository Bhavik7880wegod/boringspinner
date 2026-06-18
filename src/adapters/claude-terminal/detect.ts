// src/adapters/claude-terminal/detect.ts — Claude Code spinner detection.
//
// Pure function (no `vscode` dependency) so it is unit-testable in isolation.
// Given ONE terminal buffer line (as VS Code hands us via TerminalLinkContext.line,
// already stripped of ANSI escapes), decide whether it is a Claude Code "thinking"
// spinner line and, if so, return the character range to attach an ad link to.
//
// A Claude Code spinner line looks like:
//   ✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)
//   · Forging ahead… (esc to interrupt)
//   ⠹ Thinking… (4s · esc to interrupt)
// i.e. an optional leading spinner glyph, a gerund verb ending in an ellipsis, and
// (usually) the "esc to interrupt" hint. We return the span from the first content
// character through the ellipsis — a stable, visible target the ad link rides on.

export interface SpinnerRange {
  startIndex: number;
  length: number;
}

// Spinner glyphs Claude Code cycles through (sparkles + braille + dot fallbacks).
const GLYPHS = new Set(
  ['✶', '✻', '✳', '✢', '✽', '✺', '✦', '✧', '·', '∗', '*',
    '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏',
    '◐', '◓', '◑', '◒'],
);

// The "(… esc to interrupt)" affordance Claude Code prints while streaming.
const ESC_HINT = /esc to interrupt/i;

const isSpace = (c: string): boolean => c === ' ' || c === '\t';

// Earliest ellipsis (Unicode '…' or ASCII '...') at or after `from`. Returns the
// index of its first char and its length, or null if none.
function findEllipsis(line: string, from: number): { index: number; len: number } | null {
  const uni = line.indexOf('…', from);
  const ascii = line.indexOf('...', from);
  if (uni === -1 && ascii === -1) return null;
  if (uni !== -1 && (ascii === -1 || uni <= ascii)) return { index: uni, len: 1 };
  return { index: ascii, len: 3 };
}

export function detectSpinner(line: string): SpinnerRange | null {
  if (!line) return null;

  // Skip leading whitespace, then an optional single spinner glyph + its spaces.
  let i = 0;
  while (i < line.length && isSpace(line[i])) i++;
  const hasGlyph = i < line.length && GLYPHS.has(line[i]);
  if (hasGlyph) {
    i++;
    while (i < line.length && isSpace(line[i])) i++;
  }
  const contentStart = i;

  const ell = findEllipsis(line, contentStart);
  if (!ell) return null;

  // A spinner is only a spinner if it carries a Claude Code signal: either a
  // leading spinner glyph OR the "esc to interrupt" hint. This rejects ordinary
  // output that merely contains "..." (e.g. "Loading dependencies...").
  if (!hasGlyph && !ESC_HINT.test(line)) return null;

  const endExclusive = ell.index + ell.len;
  return { startIndex: contentStart, length: endExclusive - contentStart };
}
