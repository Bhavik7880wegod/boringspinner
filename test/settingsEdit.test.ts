import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  upsertSpinnerVerbs,
  removeSpinnerVerbs,
  hasSpinnerVerbs,
  spinnerVerbsContain,
} from '../src/adapters/claude-cli/settingsEdit';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');

// §3 / §5.7 surface-5 — JSONC-tolerant single-key upsert + remove.
describe('upsertSpinnerVerbs — insert when absent', () => {
  it('inserts the key into a plain object and stays valid JSON', () => {
    const before = read('settings.plain.json');
    expect(hasSpinnerVerbs(before)).toBe(false);
    const after = upsertSpinnerVerbs(before, { mode: 'replace', verbs: ['Sponsored: Linear →'] });
    expect(hasSpinnerVerbs(after)).toBe(true);
    expect(spinnerVerbsContain(after, 'Sponsored: Linear →')).toBe(true);
    // Other keys preserved.
    const parsed = JSON.parse(after);
    expect(parsed.model).toBe('claude-sonnet-4');
    expect(parsed.theme).toBe('dark');
    expect(parsed.permissions.allow).toEqual(['Bash', 'Read']);
    expect(parsed.spinnerVerbs).toEqual({ mode: 'replace', verbs: ['Sponsored: Linear →'] });
  });

  it('inserts into an empty object', () => {
    const after = upsertSpinnerVerbs('{}\n', { mode: 'append', verbs: ['X'] });
    expect(JSON.parse(after).spinnerVerbs).toEqual({ mode: 'append', verbs: ['X'] });
  });
});

describe('upsertSpinnerVerbs — replace when present', () => {
  it('replaces only the spinnerVerbs value, leaving siblings intact', () => {
    const before = read('settings.withSpinnerVerbs.json');
    const after = upsertSpinnerVerbs(before, { mode: 'replace', verbs: ['NewAd'] });
    const parsed = JSON.parse(after);
    expect(parsed.spinnerVerbs).toEqual({ mode: 'replace', verbs: ['NewAd'] });
    expect(parsed.model).toBe('claude-sonnet-4');
    expect(parsed.theme).toBe('light');
    // The old verbs are gone.
    expect(spinnerVerbsContain(after, 'Pondering')).toBe(false);
  });
});

describe('append vs replace mode', () => {
  it('writes the requested mode verbatim', () => {
    const appended = upsertSpinnerVerbs('{}', { mode: 'append', verbs: ['A', 'B'] });
    expect(JSON.parse(appended).spinnerVerbs.mode).toBe('append');
    const replaced = upsertSpinnerVerbs('{}', { mode: 'replace', verbs: ['A'] });
    expect(JSON.parse(replaced).spinnerVerbs.mode).toBe('replace');
  });
});

describe('JSONC tolerance — preserves comments, whitespace, key order', () => {
  it('keeps every comment and the original keys when inserting', () => {
    const before = read('settings.withComments.jsonc');
    const after = upsertSpinnerVerbs(before, { mode: 'replace', verbs: ['Sponsored: Linear →'] });
    // Comments survived byte-for-byte.
    expect(after).toContain("// user's preferred model — do not change");
    expect(after).toContain('/* block comment: theme settings below */');
    expect(after).toContain('// trailing inline comment with a } brace and "quote"');
    // Original keys survived in order.
    const modelIdx = after.indexOf('"model"');
    const themeIdx = after.indexOf('"theme"');
    const envIdx = after.indexOf('"env"');
    const verboseIdx = after.indexOf('"verbose"');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(modelIdx).toBeLessThan(themeIdx);
    expect(themeIdx).toBeLessThan(envIdx);
    expect(envIdx).toBeLessThan(verboseIdx);
    // The injected key is present.
    expect(after).toContain('"spinnerVerbs"');
  });

  it('does not treat a `spinnerVerbs` string inside a comment as the real key', () => {
    const doc = `{
  // here is a fake "spinnerVerbs": {"mode":"x"} inside a comment
  "model": "x"
}
`;
    expect(hasSpinnerVerbs(doc)).toBe(false);
    const after = upsertSpinnerVerbs(doc, { mode: 'replace', verbs: ['Ad'] });
    // Only one real spinnerVerbs key now (the inserted one).
    expect(hasSpinnerVerbs(after)).toBe(true);
    expect(JSON.parse(stripComments(after)).spinnerVerbs.verbs).toEqual(['Ad']);
  });
});

describe('removeSpinnerVerbs — removes only that key', () => {
  it('removes the key and leaves the rest valid + byte-clean', () => {
    const before = read('settings.withSpinnerVerbs.json');
    const after = removeSpinnerVerbs(before);
    expect(hasSpinnerVerbs(after)).toBe(false);
    const parsed = JSON.parse(after);
    expect(parsed.model).toBe('claude-sonnet-4');
    expect(parsed.theme).toBe('light');
    expect('spinnerVerbs' in parsed).toBe(false);
    // No dangling comma / no double blank line.
    expect(after).not.toMatch(/,\s*,/);
    expect(after).not.toMatch(/\n\s*\n\s*\n/);
  });

  it('is a no-op when the key is absent (byte-identical)', () => {
    const before = read('settings.plain.json');
    expect(removeSpinnerVerbs(before)).toBe(before);
  });

  it('upsert→remove returns to a document with all original keys intact', () => {
    const before = read('settings.plain.json');
    const patched = upsertSpinnerVerbs(before, { mode: 'replace', verbs: ['Ad'] });
    const removed = removeSpinnerVerbs(patched);
    const a = JSON.parse(removed);
    const b = JSON.parse(before);
    expect(a).toEqual(b);
  });
});

// Local tiny comment-stripper for asserting JSON.parse on a JSONC string.
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
