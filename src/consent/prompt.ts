// src/consent/prompt.ts — one-time consent dialog (§14 vendor disclosure).
//
// Shows a modal once per machine, records acceptance via ConsentClient, and
// persists a flag in globalState so it never re-prompts. The vscode dependency
// is injected (showModal / globalState) so the gate logic is unit-testable and
// the module loads under vitest.

import { dlog } from '../log';

const CONSENT_KEY = 'coads.consent.accepted';

export const CONSENT_MESSAGE =
  'BoringSpinner shows a single sponsored line in Claude Code / Codex wait states and ' +
  'reports anonymous view metrics (never your code or prompts). ' +
  'You keep 50% of ad revenue from your machine. Continue?';

// Minimal globalState shape (subset of vscode.Memento). Injected.
export interface ConsentMemento {
  get(key: string): boolean | undefined;
  update(key: string, value: boolean): Thenable<void> | Promise<void>;
}

export interface ConsentPromptDeps {
  state: ConsentMemento;
  // Returns true if the user accepted. In prod this is a vscode modal.
  showModal: (message: string) => Promise<boolean>;
  // Records acceptance server-side (ConsentClient.record).
  record?: (accepted: boolean) => Promise<boolean>;
}

// True if consent was already accepted (no prompt needed). Pure-ish (state read).
export function hasConsented(state: ConsentMemento): boolean {
  return state.get(CONSENT_KEY) === true;
}

// Show the one-time consent dialog if not already accepted. Returns the
// effective consent state (true once accepted). Idempotent.
export async function ensureConsent(deps: ConsentPromptDeps): Promise<boolean> {
  if (hasConsented(deps.state)) return true;
  const accepted = await deps.showModal(CONSENT_MESSAGE);
  if (accepted) {
    await deps.state.update(CONSENT_KEY, true);
    await deps.record?.(true);
    dlog('[consent] accepted + recorded');
  } else {
    dlog('[consent] declined');
  }
  return accepted;
}
