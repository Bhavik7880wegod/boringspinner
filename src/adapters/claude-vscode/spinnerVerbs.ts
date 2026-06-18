// src/adapters/claude-vscode/spinnerVerbs.ts — mirror the sponsored verb into VS
// Code user settings so the Claude Code CHAT PANEL (webview) shows it.
//
// WHY THIS EXISTS: the `claude` CLI reads the thinking-spinner verb from
// ~/.claude/settings.json (handled by the claude-cli adapter). The VS Code chat
// panel reads it from the VS Code user setting `claudeCode.spinnerVerbs`
// (getConfiguration('claudeCode').get('spinnerVerbs')) — a DIFFERENT source. So
// chat-panel users never saw the ad until we also write this. CC live-watches
// the key (affectsConfiguration → pushStateUpdate), so the panel updates without
// a reload. The key is not a registered VS Code configuration, so config.update()
// throws — we edit the user settings.json directly with the same comment-safe
// top-level upsert/remove used for ~/.claude/settings.json.

import {
  upsertTopLevelObject,
  removeTopLevelKey,
  readText,
  writeText,
} from '../claude-cli/settingsEdit';

export const VSCODE_SPINNER_VERBS_KEY = 'claudeCode.spinnerVerbs';

// Upsert `"claudeCode.spinnerVerbs": { "mode": "replace", "verbs": [adText] }`
// into the VS Code user settings.json at `settingsPath`. No-op when unchanged.
export function applyVscodeSpinnerVerb(settingsPath: string, adText: string): void {
  if (!adText) return;
  const current = readText(settingsPath) ?? '{}\n';
  const next = upsertTopLevelObject(current, VSCODE_SPINNER_VERBS_KEY, {
    mode: 'replace',
    verbs: [adText],
  });
  if (next !== current) writeText(settingsPath, next);
}

// Remove our spinnerVerbs key from the VS Code user settings.json, leaving every
// other byte untouched. No-op when absent or the file does not exist.
export function restoreVscodeSpinnerVerb(settingsPath: string): void {
  const current = readText(settingsPath);
  if (current == null) return;
  const next = removeTopLevelKey(current, VSCODE_SPINNER_VERBS_KEY);
  if (next !== current) writeText(settingsPath, next);
}
