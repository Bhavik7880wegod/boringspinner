// src/servingGate.ts — canPatch(): folds all "shall we write?" inputs.
//
// Phase 2: combine the user `enabled` flag, the kill posture, and surface
// compatibility into a single boolean. Signed-in gating is added in Phase 3
// (Phase 2 has no auth — demo/hardcoded ad serves regardless of sign-in).

export type KillPosture = 'clear' | 'confirmed' | 'offline';

export interface ServingInputs {
  enabled: boolean; // coads.enabled (user toggle / DebugController)
  killPosture: KillPosture; // from KillSwitchClient (§6.5)
  compatible: boolean; // adapter.preflight().compatible
  signedIn?: boolean; // Phase 3 — billable serving requires sign-in; demo does not
}

// Decide whether any patch writer may run (billable OR demo).
//
// Kill-switch semantics (§6.5):
//   - confirmed → do NOT write (caller restores + persists the gate)
//   - offline   → fail-closed: do NOT write new ads (hold current state)
//   - clear     → writes allowed if enabled + compatible
//
// NOTE: sign-in is NOT gated here — demo serves regardless of sign-in (§5.11).
// Use canServeBillable() to gate the billable (signed-in) path specifically.
export function canPatch(inputs: ServingInputs): boolean {
  if (!inputs.enabled) return false;
  if (!inputs.compatible) return false;
  if (inputs.killPosture !== 'clear') return false;
  return true;
}

// Billable serving (§5.11): everything canPatch requires PLUS being signed in.
export function canServeBillable(inputs: ServingInputs): boolean {
  return canPatch(inputs) && inputs.signedIn === true;
}

// Demo serving (§5.11): a signed-out user STILL sees real sponsored lines, so
// demo serves whenever the base gate is open — independent of sign-in.
export function canServeDemo(inputs: ServingInputs): boolean {
  return canPatch(inputs);
}

// Human-readable explanation for diagnostics / status surfaces.
export function whyNotPatch(inputs: ServingInputs): string | null {
  if (!inputs.enabled) return 'disabled by user';
  if (!inputs.compatible) return 'no compatible target';
  if (inputs.killPosture === 'confirmed') return 'killed by server';
  if (inputs.killPosture === 'offline') return 'offline (fail-closed)';
  return null;
}
