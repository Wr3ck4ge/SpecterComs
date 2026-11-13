// S5: "Reset encryption identity" — the pure parts (no React, MLS or Tauri),
// shared by mlsSession.resetEncryptionIdentity (engine), the settings bridge
// host and the strip's ResetIdentityPanel, and unit-tested on their own.

/** What the user types to confirm (case-insensitive, surrounding spaces ignored). */
export const RESET_CONFIRM_WORD = 'RESET';

export const isResetConfirmed = (text) => String(text ?? '').trim().toUpperCase() === RESET_CONFIRM_WORD;

/** How long the engine waits after replying before it reloads itself. */
export const RESET_RELOAD_DELAY_MS = 1_500;

/**
 * Runs steps in order: [{ id, label, run, optional? }]. A failing required
 * step stops the sequence and throws an Error naming it (err.step = its id,
 * err.done = ids that completed). A failing optional step is recorded in
 * `warnings` and the sequence goes on.
 * → { done: string[], warnings: string[], results: { [id]: value } }
 */
export async function runResetSteps(steps) {
  const done = [];
  const warnings = [];
  const results = {};
  for (const step of steps) {
    try {
      results[step.id] = await step.run();
      done.push(step.id);
    } catch (err) {
      const msg = err?.message || String(err);
      if (step.optional) {
        warnings.push(`${step.label}: ${msg}`);
        continue;
      }
      const e = new Error(`Reset stopped at "${step.label}": ${msg}`);
      e.step = step.id;
      e.done = done.slice();
      e.cause = err;
      throw e;
    }
  }
  return { done, warnings, results };
}

/**
 * The strip panel's state machine.
 * phase: 'idle' → (open) 'confirm' → (start, typed RESET) 'running' → 'done' | 'error'
 * state = { phase, text, error, result }
 */
export const RESET_PANEL_INITIAL = Object.freeze({ phase: 'idle', text: '', error: null, result: null });

export function resetPanelReducer(state, action) {
  switch (action.type) {
    case 'open':
      return state.phase === 'running' ? state : { ...RESET_PANEL_INITIAL, phase: 'confirm' };
    case 'cancel':
      return state.phase === 'running' ? state : RESET_PANEL_INITIAL;
    case 'type':
      return state.phase === 'confirm' ? { ...state, text: String(action.text ?? '') } : state;
    case 'start':
      return state.phase === 'confirm' && isResetConfirmed(state.text)
        ? { ...state, phase: 'running', error: null, result: null }
        : state;
    case 'succeeded':
      return state.phase === 'running' ? { ...state, phase: 'done', result: action.result ?? null } : state;
    case 'failed':
      return state.phase === 'running' ? { ...state, phase: 'error', error: String(action.error || 'Reset failed') } : state;
    default:
      return state;
  }
}
