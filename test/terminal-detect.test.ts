import { describe, it, expect } from 'vitest';
import { detectSpinner } from '../src/adapters/claude-terminal/detect';

// Real-world Claude Code spinner lines as they appear in the VS Code integrated
// terminal: a leading spinner glyph, a gerund verb ending in an ellipsis, and the
// "(… esc to interrupt)" hint. The detector must find a clickable span (the verb
// phrase, from the first content char through the ellipsis).
const SAMPLES: Array<{ line: string; span: string }> = [
  { line: '✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)', span: 'Cogitating…' },
  { line: '· Forging ahead… (esc to interrupt)', span: 'Forging ahead…' },
  { line: '⠹ Thinking… (4s · esc to interrupt)', span: 'Thinking…' },
];

describe('detectSpinner — Claude Code spinner detection', () => {
  it('finds the spinner verb span in each real Claude Code spinner sample', () => {
    for (const { line, span } of SAMPLES) {
      const r = detectSpinner(line);
      expect(r, `expected a match for: ${line}`).not.toBeNull();
      // The returned range must isolate the verb-through-ellipsis span.
      expect(line.slice(r!.startIndex, r!.startIndex + r!.length)).toBe(span);
    }
  });

  it('returns null for ordinary terminal output (no false positives)', () => {
    const negatives = [
      '$ npm run build',
      'Compiled successfully in 1.23s',
      'Loading dependencies...', // ellipsis but no spinner glyph / no esc hint
      'total 48',
      '',
    ];
    for (const line of negatives) {
      expect(detectSpinner(line), `should not match: ${line}`).toBeNull();
    }
  });
});
