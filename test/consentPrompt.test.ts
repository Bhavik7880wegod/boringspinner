import { describe, it, expect } from 'vitest';
import { ensureConsent, hasConsented, CONSENT_MESSAGE, type ConsentMemento } from '../src/consent/prompt';

function memento(initial: Record<string, boolean> = {}): ConsentMemento {
  const store = { ...initial };
  return {
    get: (k) => store[k],
    update: async (k, v) => void (store[k] = v),
  };
}

describe('consent prompt — one-time gate (§14)', () => {
  it('prompts once, records acceptance, persists the flag', async () => {
    const state = memento();
    let recorded = false;
    let shown = '';
    const ok = await ensureConsent({
      state,
      showModal: async (m) => ((shown = m), true),
      record: async () => ((recorded = true), true),
    });
    expect(ok).toBe(true);
    expect(shown).toBe(CONSENT_MESSAGE);
    expect(recorded).toBe(true);
    expect(hasConsented(state)).toBe(true);
  });

  it('does NOT re-prompt once already accepted', async () => {
    const state = memento({ 'coads.consent.accepted': true });
    let shownCount = 0;
    const ok = await ensureConsent({
      state,
      showModal: async () => ((shownCount += 1), true),
    });
    expect(ok).toBe(true);
    expect(shownCount).toBe(0); // no prompt
  });

  it('declined → not persisted, returns false', async () => {
    const state = memento();
    const ok = await ensureConsent({ state, showModal: async () => false });
    expect(ok).toBe(false);
    expect(hasConsented(state)).toBe(false);
  });
});
