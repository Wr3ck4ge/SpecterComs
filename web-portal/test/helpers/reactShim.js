// Just enough of React's hook API to run a custom hook once, outside a
// renderer: no re-render, effects run synchronously after the "render", state
// setters apply (functional) updates to a holder the test can read. The
// engine hooks under test (useEventStream, useChannelChat) do their real work
// in effects and module-level refs, which is all the contract tests need.
// Used through vi.mock('react', () => import('./helpers/reactShim.js')).

let pendingEffects = [];
let cleanups = [];
export const stateLog = [];   // every useState holder, in call order

export function useRef(initial) { return { current: initial }; }
export function useCallback(fn) { return fn; }
export function useMemo(fn) { return fn(); }
export function useState(initial) {
  const holder = { value: typeof initial === 'function' ? initial() : initial };
  stateLog.push(holder);
  const set = (next) => { holder.value = typeof next === 'function' ? next(holder.value) : next; };
  return [holder.value, set];
}
export function useEffect(fn) { pendingEffects.push(fn); }
export const useLayoutEffect = useEffect;

/** Run `hook(props)` once, then its effects. → { result, unmount } */
export function renderHook(hook, props) {
  pendingEffects = [];
  const result = hook(props);
  const effects = pendingEffects;
  pendingEffects = [];
  const mine = [];
  for (const fn of effects) {
    const c = fn();
    if (typeof c === 'function') mine.push(c);
  }
  cleanups.push(...mine);
  return {
    result,
    unmount() { for (const c of mine.reverse()) c(); },
  };
}

export function resetShim() {
  for (const c of cleanups.reverse()) { try { c(); } catch { /* already torn down */ } }
  cleanups = [];
  pendingEffects = [];
  stateLog.length = 0;
}

export default { useRef, useCallback, useMemo, useState, useEffect, useLayoutEffect };
