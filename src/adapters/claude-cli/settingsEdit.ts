// src/adapters/claude-cli/settingsEdit.ts — JSONC-tolerant upsert / remove.
//
// Phase 2: surgical, single-key editing of a ~/.claude/settings.json STRING.
// We operate on text (never reserialize the whole document) so user comments,
// whitespace, and existing key order are preserved. Only the top-level
// `spinnerVerbs` key is ever touched.
//
// Schema (§3, surface 5):  "spinnerVerbs": { "mode": "append"|"replace", "verbs": string[] }
//
// SAFETY: the fs wrappers here are thin and operate on whatever path the caller
// passes. The adapter + tests only ever point them at fixtures / temp copies —
// never the live ~/.claude/settings.json.

import * as fs from 'fs';

export const SPINNER_VERBS_KEY = 'spinnerVerbs';
export const STATUS_LINE_KEY = 'statusLine'; // surface 4 (`claude-cli-statusline`)

export type SpinnerMode = 'append' | 'replace';

export interface SpinnerVerbsValue {
  mode: SpinnerMode;
  verbs: string[];
}

export interface UpsertOpts {
  mode: SpinnerMode;
  verbs: string[];
}

// ---------------------------------------------------------------------------
// JSONC-tolerant scanning helpers
// ---------------------------------------------------------------------------

// Strip `//` line and `/* */` block comments + string contents so we can scan
// structure without tripping on commented-out keys or braces inside strings.
// Returns a same-length mask string where comment/string bytes are spaces and
// every other byte is preserved. Region offsets computed on the mask map 1:1
// onto the original text (lengths are identical).
function maskCommentsAndStrings(text: string): string {
  const out = text.split('');
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && text[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out[i] = ' ';
        i++;
      }
      if (i < n) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    if (c === '"') {
      // Keep the delimiting quotes so structure-scanning can recognize a real
      // string; blank only the contents (so braces/quotes inside don't fool us).
      out[i] = '"';
      i++;
      while (i < n) {
        if (text[i] === '\\') {
          out[i] = ' ';
          if (i + 1 < n) out[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          out[i] = '"';
          i++;
          break;
        }
        out[i] = ' ';
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

// Find the [start, end) byte range of the top-level `spinnerVerbs` member,
// covering the key, the colon, and the full value (object/array/scalar).
// Returns null if the key is absent at the top level. Depth-aware so a nested
// `spinnerVerbs` inside some other object is not mistaken for the top-level one.
interface KeyRegion {
  keyStart: number; // index of the opening quote of the key
  valueEnd: number; // index just past the end of the value
}

function findTopLevelKey(text: string, key: string): KeyRegion | null {
  const mask = maskCommentsAndStrings(text);
  const n = text.length;

  // Locate the top-level object body (between the first '{' and matching '}').
  let objStart = -1;
  for (let i = 0; i < n; i++) {
    if (mask[i] === '{') {
      objStart = i;
      break;
    }
  }
  if (objStart < 0) return null;

  // Walk members at depth 1 (inside the top-level object).
  let depth = 0;
  let i = objStart;
  while (i < n) {
    const m = mask[i];
    if (m === '{' || m === '[') {
      depth++;
      i++;
      continue;
    }
    if (m === '}' || m === ']') {
      depth--;
      i++;
      if (depth === 0) break;
      continue;
    }
    // A string key only matters at depth 1 (direct child of the top object).
    // Gate on the MASK: a `"` at this position in the original text that is
    // masked to a space lives inside a comment/string and is not a real key.
    if (depth === 1 && text[i] === '"' && mask[i] === '"') {
      const keyStart = i;
      const keyEnd = scanStringEnd(text, i);
      const literal = text.slice(keyStart + 1, keyEnd - 1);
      // Advance past whitespace to the ':'
      let j = keyEnd;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] === ':' && literal === key) {
        const valueEnd = scanValueEnd(mask, j + 1);
        return { keyStart, valueEnd };
      }
      // Not our key — skip the value so we don't re-scan its inner strings.
      if (text[j] === ':') {
        i = scanValueEnd(mask, j + 1);
        continue;
      }
      i = keyEnd;
      continue;
    }
    i++;
  }
  return null;
}

// Given the index of an opening quote, return index just past the closing quote.
function scanStringEnd(text: string, openQuote: number): number {
  let i = openQuote + 1;
  const n = text.length;
  while (i < n) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '"') return i + 1;
    i++;
  }
  return n;
}

// From `from`, skip whitespace then consume one JSON value (object/array/string/
// number/keyword), returning the index just past it. Operates on the mask so
// nested braces/quotes inside strings or comments are already neutralized.
function scanValueEnd(mask: string, from: number): number {
  const n = mask.length;
  let i = from;
  while (i < n && /\s/.test(mask[i])) i++;
  const c = mask[i];
  if (c === '{' || c === '[') {
    let depth = 0;
    while (i < n) {
      const m = mask[i];
      if (m === '{' || m === '[') depth++;
      else if (m === '}' || m === ']') {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return n;
  }
  // Scalar (string masked to spaces, number, true/false/null). Read until a
  // structural delimiter at this level: ',' '}' ']' or EOF.
  while (i < n && mask[i] !== ',' && mask[i] !== '}' && mask[i] !== ']') i++;
  return i;
}

// ---------------------------------------------------------------------------
// String-level operations (pure; the heart of Phase 2)
// ---------------------------------------------------------------------------

// Detect the indentation used by the first top-level member, so an inserted
// key matches the document's style (defaults to two spaces).
function detectIndent(text: string): string {
  const m = text.match(/\{[^\S\n]*\n([ \t]+)\S/);
  return m ? m[1] : '  ';
}

function serializeValue(value: SpinnerVerbsValue, indent: string): string {
  // Compact-but-readable single-line object; verbs as a JSON array.
  const verbs = JSON.stringify(value.verbs);
  return `{ "mode": ${JSON.stringify(value.mode)}, "verbs": ${verbs} }`;
}

// Upsert the top-level `spinnerVerbs` key. If present, replace ONLY its value
// region (key + colon + existing value) — preserving every other byte. If
// absent, insert a minimal member right after the opening `{`.
export function upsertSpinnerVerbs(jsonText: string, opts: UpsertOpts): string {
  const value: SpinnerVerbsValue = { mode: opts.mode, verbs: opts.verbs };
  const region = findTopLevelKey(jsonText, SPINNER_VERBS_KEY);
  const indent = detectIndent(jsonText);
  const rendered = `"${SPINNER_VERBS_KEY}": ${serializeValue(value, indent)}`;

  if (region) {
    // Replace the whole member (key..valueEnd) in place — no reserialize.
    return (
      jsonText.slice(0, region.keyStart) +
      rendered +
      jsonText.slice(region.valueEnd)
    );
  }

  // Insert as the first member after the top-level '{'.
  const mask = maskCommentsAndStrings(jsonText);
  const braceIdx = mask.indexOf('{');
  if (braceIdx < 0) {
    // Not an object — return a minimal valid document.
    return `{\n${indent}${rendered}\n}\n`;
  }

  const after = jsonText.slice(braceIdx + 1);
  // Is the object otherwise empty (only whitespace/comments before '}')?
  const restMask = mask.slice(braceIdx + 1);
  const closeIdx = restMask.indexOf('}');
  const bodyMask = restMask.slice(0, closeIdx < 0 ? restMask.length : closeIdx);
  const isEmpty = bodyMask.trim() === '';

  if (isEmpty) {
    return (
      jsonText.slice(0, braceIdx + 1) +
      `\n${indent}${rendered}\n` +
      after.slice(closeIdx >= 0 ? closeIdx : after.length)
    );
  }

  // Non-empty: insert our member + trailing comma before the first real member.
  return (
    jsonText.slice(0, braceIdx + 1) +
    `\n${indent}${rendered},` +
    after
  );
}

// Remove the top-level `spinnerVerbs` member entirely, leaving every other byte
// intact. Also consumes a single adjacent comma + the line's own indentation so
// no dangling comma or blank line is left behind.
export function removeSpinnerVerbs(jsonText: string): string {
  const region = findTopLevelKey(jsonText, SPINNER_VERBS_KEY);
  if (!region) return jsonText;

  let start = region.keyStart;
  let end = region.valueEnd;
  const mask = maskCommentsAndStrings(jsonText);

  // Eat a trailing comma after the value (and the whitespace before it).
  let j = end;
  while (j < jsonText.length && /[ \t]/.test(jsonText[j])) j++;
  if (mask[j] === ',') {
    end = j + 1;
  } else {
    // No trailing comma → this was the last member. Eat a PRECEDING comma.
    let k = start - 1;
    while (k >= 0 && /\s/.test(jsonText[k])) k--;
    if (mask[k] === ',') start = k;
  }

  // Eat the member's own leading indentation back to (not including) the newline.
  let s = start - 1;
  while (s >= 0 && (jsonText[s] === ' ' || jsonText[s] === '\t')) s--;
  if (jsonText[s] === '\n') start = s + 1;

  // Eat the trailing newline left by removing a full line.
  if (jsonText[end] === '\n') end += 1;

  return jsonText.slice(0, start) + jsonText.slice(end);
}

// Does the document currently carry the exact verbs (any mode)? Used for the
// adapter's idempotency check on a known ad text.
export function spinnerVerbsContain(jsonText: string, verb: string): boolean {
  const region = findTopLevelKey(jsonText, SPINNER_VERBS_KEY);
  if (!region) return false;
  const slice = jsonText.slice(region.keyStart, region.valueEnd);
  try {
    const colon = slice.indexOf(':');
    const parsed = JSON.parse(slice.slice(colon + 1)) as SpinnerVerbsValue;
    return Array.isArray(parsed.verbs) && parsed.verbs.includes(verb);
  } catch {
    return false;
  }
}

// Does the document carry EXACTLY this verb set (same order), any mode? Used by
// the adapter's idempotency check when writing the FULL auction queue as the
// rotation set — so a re-sync with an unchanged queue is a true no-op, but a
// changed queue (added/removed/reordered campaign) triggers a rewrite.
export function spinnerVerbsEqual(jsonText: string, verbs: string[]): boolean {
  const region = findTopLevelKey(jsonText, SPINNER_VERBS_KEY);
  if (!region) return false;
  const slice = jsonText.slice(region.keyStart, region.valueEnd);
  try {
    const colon = slice.indexOf(':');
    const parsed = JSON.parse(slice.slice(colon + 1)) as SpinnerVerbsValue;
    if (!Array.isArray(parsed.verbs) || parsed.verbs.length !== verbs.length) return false;
    return parsed.verbs.every((v, i) => v === verbs[i]);
  } catch {
    return false;
  }
}

export function hasSpinnerVerbs(jsonText: string): boolean {
  return findTopLevelKey(jsonText, SPINNER_VERBS_KEY) !== null;
}

// ===========================================================================
// surface 4 — `claude-cli-statusline` (§3 #4): top-level `statusLine` field.
//
// Claude Code's statusLine schema is:
//   "statusLine": { "type": "command", "command": "<shell>", "padding": <n> }
// The command receives the session JSON on stdin and its STDOUT becomes the
// HUD line(s) Claude Code renders below the input box.
//
// CHAIN-CAPTURE (the load-bearing requirement): if the user ALREADY has a
// statusLine command, we must NOT clobber their HUD. Instead our injected
// command prints the single sponsored ad line FIRST, then runs THEIR original
// command (forwarding the same stdin) and stacks its output BELOW the ad line.
// On restore we put their original statusLine back byte-exact (full file
// restore from the backup the adapter holds), so this is fully reversible.
// ===========================================================================

export interface StatusLineValue {
  type: 'command';
  command: string;
  padding?: number;
}

// A stable, idempotent marker the chained command carries so we can (a) detect
// our own injection and (b) extract the user's wrapped command on a re-apply
// (chaining our chain would otherwise nest the ad line twice).
export const STATUSLINE_MARKER = '#__COADS_STATUSLINE__';

// Read the raw top-level `statusLine` value (parsed) or null if absent/invalid.
export function readStatusLine(jsonText: string): StatusLineValue | null {
  const region = findTopLevelKey(jsonText, STATUS_LINE_KEY);
  if (!region) return null;
  const slice = jsonText.slice(region.keyStart, region.valueEnd);
  try {
    const colon = slice.indexOf(':');
    const parsed = JSON.parse(slice.slice(colon + 1)) as StatusLineValue;
    if (parsed && typeof parsed.command === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

export function hasStatusLine(jsonText: string): boolean {
  return findTopLevelKey(jsonText, STATUS_LINE_KEY) !== null;
}

// Is the current statusLine OUR injection (carries the marker)?
export function statusLineIsCoads(jsonText: string): boolean {
  const sl = readStatusLine(jsonText);
  return !!sl && sl.command.indexOf(STATUSLINE_MARKER) !== -1;
}

// Extract the user's ORIGINAL command from one of our chained commands. Returns
// null when the current statusLine is not ours (or has no wrapped inner cmd).
// The inner command is stored verbatim after the `--- ` sentinel inside the
// marker comment so re-applies don't double-wrap.
const INNER_OPEN = '#__COADS_INNER_B64__:';
const INNER_CLOSE = ':__COADS_INNER_END__';

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}
function unb64(s: string): string {
  return Buffer.from(s, 'base64').toString('utf8');
}

export function extractChainedUserCommand(command: string): string | null {
  const i = command.indexOf(INNER_OPEN);
  if (i === -1) return null;
  const start = i + INNER_OPEN.length;
  const j = command.indexOf(INNER_CLOSE, start);
  if (j === -1) return null;
  const encoded = command.slice(start, j).trim();
  if (!encoded) return ''; // marker present but no inner command (none configured)
  try {
    return unb64(encoded);
  } catch {
    return null;
  }
}

// Build the chained shell command: print the ad line, then (if present) run the
// user's original command with the SAME stdin and stack its output below.
//
// Implementation detail: Claude Code invokes the command via the shell with the
// session JSON on stdin. We capture stdin once (`IN=$(cat)`), echo the ad line,
// then re-feed IN to the user's command so their HUD sees identical input. The
// user's original command is embedded base64-encoded inside a marker so a
// re-apply can unwrap it instead of nesting.
export function buildChainedCommand(adText: string, innerUserCommand: string | null): string {
  const inner = innerUserCommand ?? '';
  const adLine = adText.replace(/'/g, `'\\''`); // single-quote-safe for sh
  const tag = `${STATUSLINE_MARKER} ${INNER_OPEN}${inner ? b64(inner) : ''}${INNER_CLOSE}`;
  if (!inner) {
    // No user command to chain → just print the ad line.
    return `${tag}\nprintf '%s\\n' '${adLine}'`;
  }
  // Print the ad line, then run the user's command on the same stdin, stacking
  // its output BELOW. `IN=$(cat)` consumes stdin once; we replay it via here-string.
  return (
    `${tag}\n` +
    `IN=$(cat); printf '%s\\n' '${adLine}'; printf '%s' "$IN" | ( ${inner} )`
  );
}

// Upsert the top-level `statusLine` as OUR chained command (§3 surface 4).
// CHAIN-CAPTURE: preserves any existing user statusLine command by wrapping it.
//   • If the current statusLine is the USER's → wrap their command (chain).
//   • If the current statusLine is ALREADY OURS → unwrap the previously-captured
//     inner command and re-wrap with the new ad text (idempotent; no nesting).
//   • If absent → install a marker-only command that just prints the ad line.
// Preserves comments / whitespace / key order (single-member value replacement).
export function upsertStatusLine(jsonText: string, adText: string): string {
  const existing = readStatusLine(jsonText);

  let innerUserCommand: string | null = null;
  let padding: number | undefined;
  if (existing) {
    padding = existing.padding;
    if (existing.command.indexOf(STATUSLINE_MARKER) !== -1) {
      // Already ours → recover the user's original (may be '' = none).
      innerUserCommand = extractChainedUserCommand(existing.command);
    } else {
      // The user's own command → chain it.
      innerUserCommand = existing.command;
    }
  }

  const value: StatusLineValue = {
    type: 'command',
    command: buildChainedCommand(adText, innerUserCommand && innerUserCommand.length ? innerUserCommand : null),
  };
  if (typeof padding === 'number') value.padding = padding;

  return upsertTopLevelObject(jsonText, STATUS_LINE_KEY, value);
}

// Remove our `statusLine` injection. If the captured inner command exists,
// RESTORE the user's original statusLine (so their HUD survives a plain remove);
// otherwise remove the key entirely. (Full byte-exact rollback is handled by the
// adapter's file backup; this keeps text-level remove honest for non-backup paths.)
export function removeStatusLine(jsonText: string): string {
  const existing = readStatusLine(jsonText);
  if (!existing) return jsonText;
  if (existing.command.indexOf(STATUSLINE_MARKER) === -1) {
    // Not ours → leave the user's statusLine untouched.
    return jsonText;
  }
  const inner = extractChainedUserCommand(existing.command);
  if (inner && inner.length) {
    const value: StatusLineValue = { type: 'command', command: inner };
    if (typeof existing.padding === 'number') value.padding = existing.padding;
    return upsertTopLevelObject(jsonText, STATUS_LINE_KEY, value);
  }
  return removeTopLevelKey(jsonText, STATUS_LINE_KEY);
}

// Does the document carry OUR statusLine ad for the given text?
export function statusLineContains(jsonText: string, adText: string): boolean {
  const sl = readStatusLine(jsonText);
  if (!sl) return false;
  if (sl.command.indexOf(STATUSLINE_MARKER) === -1) return false;
  return sl.command.indexOf(adText.replace(/'/g, `'\\''`)) !== -1;
}

// ---------------------------------------------------------------------------
// Generic top-level object upsert / remove (shared by statusLine; spinnerVerbs
// keeps its own bespoke serializer for back-compat).
// ---------------------------------------------------------------------------

function serializeObjectValue(value: object): string {
  // JSON.stringify gives a deterministic, valid serialization. The statusLine
  // value is small; multi-line is unnecessary and a single line keeps the diff
  // minimal and the surrounding document untouched.
  return JSON.stringify(value);
}

export function upsertTopLevelObject(
  jsonText: string,
  key: string,
  value: object,
): string {
  const region = findTopLevelKey(jsonText, key);
  const indent = detectIndent(jsonText);
  const rendered = `"${key}": ${serializeObjectValue(value)}`;

  if (region) {
    return (
      jsonText.slice(0, region.keyStart) + rendered + jsonText.slice(region.valueEnd)
    );
  }

  const mask = maskCommentsAndStrings(jsonText);
  const braceIdx = mask.indexOf('{');
  if (braceIdx < 0) {
    return `{\n${indent}${rendered}\n}\n`;
  }
  const after = jsonText.slice(braceIdx + 1);
  const restMask = mask.slice(braceIdx + 1);
  const closeIdx = restMask.indexOf('}');
  const bodyMask = restMask.slice(0, closeIdx < 0 ? restMask.length : closeIdx);
  const isEmpty = bodyMask.trim() === '';

  if (isEmpty) {
    return (
      jsonText.slice(0, braceIdx + 1) +
      `\n${indent}${rendered}\n` +
      after.slice(closeIdx >= 0 ? closeIdx : after.length)
    );
  }
  return jsonText.slice(0, braceIdx + 1) + `\n${indent}${rendered},` + after;
}

export function removeTopLevelKey(jsonText: string, key: string): string {
  const region = findTopLevelKey(jsonText, key);
  if (!region) return jsonText;

  let start = region.keyStart;
  let end = region.valueEnd;
  const mask = maskCommentsAndStrings(jsonText);

  let j = end;
  while (j < jsonText.length && /[ \t]/.test(jsonText[j])) j++;
  if (mask[j] === ',') {
    end = j + 1;
  } else {
    let k = start - 1;
    while (k >= 0 && /\s/.test(jsonText[k])) k--;
    if (mask[k] === ',') start = k;
  }

  let s = start - 1;
  while (s >= 0 && (jsonText[s] === ' ' || jsonText[s] === '\t')) s--;
  if (jsonText[s] === '\n') start = s + 1;
  if (jsonText[end] === '\n') end += 1;

  return jsonText.slice(0, start) + jsonText.slice(end);
}

// ---------------------------------------------------------------------------
// Thin fs wrappers (byte-exact; never auto-target the live settings file)
// ---------------------------------------------------------------------------

export function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

export function writeText(filePath: string, text: string): void {
  fs.writeFileSync(filePath, text, 'utf8');
}
