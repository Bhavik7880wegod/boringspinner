import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyVscodeSpinnerVerb,
  restoreVscodeSpinnerVerb,
} from '../src/adapters/claude-vscode/spinnerVerbs';

// The Claude Code CHAT PANEL reads the spinner verb from VS Code user settings
// (claudeCode.spinnerVerbs), not ~/.claude/settings.json. These tests verify we
// upsert/remove that key against a real settings.json without disturbing it.
describe('VS Code chat-panel spinnerVerbs surface', () => {
  let dir: string;
  let p: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coads-vsc-'));
    p = path.join(dir, 'settings.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('upserts claudeCode.spinnerVerbs, preserving other keys', () => {
    fs.writeFileSync(p, '{\n    "claudeCode.preferredLocation": "panel"\n}\n');
    applyVscodeSpinnerVerb(p, 'Sponsored: Demo Brand');
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(parsed['claudeCode.preferredLocation']).toBe('panel');
    expect(parsed['claudeCode.spinnerVerbs']).toEqual({
      mode: 'replace',
      verbs: ['Sponsored: Demo Brand'],
    });
  });

  it('creates settings.json when absent', () => {
    applyVscodeSpinnerVerb(p, 'Sponsored: Linear');
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))['claudeCode.spinnerVerbs'].verbs).toEqual([
      'Sponsored: Linear',
    ]);
  });

  it('restore removes only our key, leaving others intact', () => {
    fs.writeFileSync(p, '{\n    "claudeCode.preferredLocation": "panel"\n}\n');
    applyVscodeSpinnerVerb(p, 'Ad');
    restoreVscodeSpinnerVerb(p);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(parsed['claudeCode.spinnerVerbs']).toBeUndefined();
    expect(parsed['claudeCode.preferredLocation']).toBe('panel');
  });

  it('updates the verb when the served ad changes (rotation)', () => {
    applyVscodeSpinnerVerb(p, 'First Ad');
    applyVscodeSpinnerVerb(p, 'Second Ad');
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))['claudeCode.spinnerVerbs'].verbs).toEqual([
      'Second Ad',
    ]);
  });
});
