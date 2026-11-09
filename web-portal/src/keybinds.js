// Default global-shortcut bindings, shared by the settings UI (which shows and
// edits them) and WarRoom (which registers them). Both used to read localStorage
// with their own `|| ''` fallback, so a fresh install had no bindings at all
// until the user discovered the settings panel and set some.
//
// Values are accelerator strings in the registrar's own vocabulary: modifiers in
// Ctrl,Alt,Shift,Meta order followed by a KeyboardEvent.code. See ACCEL_KEY_CODES
// in SettingsUI.jsx for the full accepted set, and prettyKey() for how these are
// rendered to the user ("Alt+KeyE" shows as "Alt + E").
//
// Note ALT here matches *either* Alt key — the accelerator vocabulary has no
// left/right variant, and KeyboardEvent.altKey is true for both.
export const DEFAULT_KEYBINDS = {
  channelToggle: 'Alt+KeyQ',
  streamNext: 'Alt+KeyE',
  overlayPassthrough: 'Alt+KeyW',
  // Start/stop sharing the application you last had focused (your game),
  // window + that app's audio when "Share audio" is on. Owner's pick, 2026-11-08.
  shareApp: 'Alt+KeyS',
  // Push-to-talk stays unbound by default: the default voice mode is
  // voice-activated, and silently picking a talk key for the user — one that
  // also reaches whatever game has focus — is a surprise nobody wants. (The
  // raw-input sink observes keys without consuming them; see
  // createHotkeyController below.)
  ptt: '',
};

// Read a stored binding, falling back to the default only when the key has never
// been set. Deliberately `??` and not `||`: clearing a binding in the UI stores
// an empty string, and that is a real choice to have no binding — `||` would
// resurrect the default and make the clear button look broken.
export const storedKeybind = (storageKey, fallback) => {
  const v = localStorage.getItem(storageKey);
  return v ?? fallback;
};

// KeyboardEvent.code values that the OS global-shortcut registrar actually
// accepts as accelerator keys. Mirrors parse_key() in the global-hotkey crate —
// keep the two in step if that vocabulary ever changes. Anything outside this
// set (ContextMenu, IntlBackslash, the bare modifier codes) parses as an
// unsupported key and the registration throws, leaving a binding that looks set
// in the UI but does nothing. (Moved here from SettingsUI.jsx so the tray
// strip's settings cabinet records keys the same way.)
export const ACCEL_KEY_CODES = new Set([
  ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide',
  'NumpadDecimal', 'NumpadEnter', 'NumpadEqual', 'NumLock',
  'Backquote', 'Backslash', 'BracketLeft', 'BracketRight', 'Comma', 'Equal',
  'Minus', 'Period', 'Quote', 'Semicolon', 'Slash',
  'Backspace', 'CapsLock', 'Enter', 'Space', 'Tab', 'Delete', 'End', 'Home',
  'Insert', 'PageDown', 'PageUp', 'PrintScreen', 'ScrollLock', 'Pause',
  'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'Escape',
]);

// Turns a stored accelerator ("Ctrl+NumpadMultiply") into something readable
// ("Ctrl + Numpad *"). Display only — never feed this back to the registrar.
const PRETTY_KEY = {
  NumpadAdd: 'Numpad +', NumpadSubtract: 'Numpad -', NumpadMultiply: 'Numpad *',
  NumpadDivide: 'Numpad /', NumpadDecimal: 'Numpad .', NumpadEnter: 'Numpad Enter',
  NumpadEqual: 'Numpad =', Backquote: '`', Backslash: '\\', BracketLeft: '[',
  BracketRight: ']', Comma: ',', Equal: '=', Minus: '-', Period: '.',
  Quote: "'", Semicolon: ';', Slash: '/', ArrowDown: '↓', ArrowLeft: '←',
  ArrowRight: '→', ArrowUp: '↑', Escape: 'Esc', PageDown: 'PgDn', PageUp: 'PgUp',
};
export const prettyKey = (combo) =>
  !combo ? '' : combo.split('+').map((part) => {
    if (PRETTY_KEY[part]) return PRETTY_KEY[part];
    if (/^Key[A-Z]$/.test(part)) return part.slice(3);
    if (/^Digit\d$/.test(part)) return part.slice(5);
    if (/^Numpad\d$/.test(part)) return `Numpad ${part.slice(6)}`;
    return part;
  }).join(' + ');

/**
 * A keydown → accelerator string ("Ctrl+KeyA"), or:
 *   null       a bare modifier (keep waiting for the key that completes it)
 *   'invalid'  a key the registrar can't use as a global shortcut
 * Uses e.code, NOT e.key: the registrar's vocabulary is KeyboardEvent.code
 * (KeyA, Digit5, NumpadMultiply); e.key gives the printed character.
 */
export function comboFromKeyEvent(e) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
  if (!ACCEL_KEY_CODES.has(e.code)) return 'invalid';
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(e.code);
  return parts.join('+');
}

// ── Global hotkey wiring (WarRoom) ──────────────────────────────────────────
//
// Two mechanisms can deliver global hotkeys:
//
//  native  hotkeys.rs, a Raw Input sink (RIDEV_INPUTSINK). Works while a game
//          that registers its own raw input with RIDEV_NOHOTKEYS (Star
//          Citizen, …) is focused, which RegisterHotKey does not. It OBSERVES
//          keys rather than consuming them, so the focused app also sees the
//          keypress — standard for PTT, worth knowing for Alt+W etc.
//  plugin  tauri-plugin-global-shortcut (RegisterHotKey). Fallback for builds
//          without the native commands, or if the sink failed to start.
//
// Exactly one is ever active: a native success clears every plugin
// registration, and the plugin is only used after the native command failed
// (in which case the sink delivers nothing).

// Binding name → the app event its press triggers. 'ptt' is special: both
// edges are forwarded as specter://ptt-active { active }.
export const HOTKEY_ACTION_EVENTS = {
  channelToggle: 'specter://cycle-freq',
  streamNext: 'specter://cycle-stream',
  overlayPassthrough: 'specter://overlay-passthrough',
  shareApp: 'specter://share-app',
};

// Safety net for the one-shot actions: at most one fire per action per
// window. Belt and braces on top of the press/release dedupe — guards against
// a mechanism that reports spurious Pressed/Released pairs on auto-repeat
// (seen with RegisterHotKey while a game held focus: Alt+E cycled through
// every stream). PTT is exempt; it needs both edges, promptly.
export const HOTKEY_COOLDOWN_MS = 250;

/** gate(key) → true at most once per `ms` per key. */
export function createCooldownGate(ms = HOTKEY_COOLDOWN_MS, now = () => Date.now()) {
  const last = new Map();
  return (key) => {
    const t = now();
    const prev = last.get(key);
    if (prev !== undefined && t - prev < ms) return false;
    last.set(key, t);
    return true;
  };
}

// Module-level, so it is shared by every listener in this window: the
// receiving side of specter://cycle-stream / cycle-freq gates on it too, which
// also neutralises a leaked duplicate listener or a second emitter.
export const oneShotListenerGate = createCooldownGate();

// localStorage keys whose change (from another window) requires a rebind.
export const HOTKEY_STORAGE_KEYS = [
  'specter_ptt_key', 'specter_channel_toggle_key', 'specter_voice_mode',
  'specter_stream_next_key', 'specter_overlay_passthrough_key', 'specter_share_app_key',
];

/** The current { name: combo } map; '' = unbound. PTT only in PTT mode. */
export function readHotkeyBindings(storage = localStorage) {
  const get = (k, fallback) => storage.getItem(k) ?? fallback;
  const voiceMode = storage.getItem('specter_voice_mode') || 'push-to-talk';
  return {
    ptt: voiceMode === 'push-to-talk' ? (storage.getItem('specter_ptt_key') || '') : '',
    channelToggle: get('specter_channel_toggle_key', DEFAULT_KEYBINDS.channelToggle),
    streamNext: get('specter_stream_next_key', DEFAULT_KEYBINDS.streamNext),
    overlayPassthrough: get('specter_overlay_passthrough_key', DEFAULT_KEYBINDS.overlayPassthrough),
    shareApp: get('specter_share_app_key', DEFAULT_KEYBINDS.shareApp),
  };
}

// The global-shortcut plugin spells two modifiers differently.
const toPluginAccel = (k) => k.replace(/\bCtrl\b/g, 'Control').replace(/\bMeta\b/g, 'Super');

/**
 * Owns the global hotkey registration for one WarRoom lifetime.
 *
 *   invoke(cmd, args)     Tauri invoke
 *   listen(event, cb)     Tauri listen → Promise<unlisten>
 *   loadPlugin()          → Promise<{ register, unregisterAll }>
 *   onAction(name, down)  deduped edges: one true per press, one false per
 *                         release, never repeats (Windows auto-repeats
 *                         WM_HOTKEY while a key is held)
 *
 * apply(bindings) → Promise<'native' | 'plugin' | 'disposed'>. Calls are
 * serialised, so a burst of storage events can't interleave registrations.
 */
export function createHotkeyController({
  invoke, listen, loadPlugin, onAction, log = console,
  cooldownMs = HOTKEY_COOLDOWN_MS, now = () => Date.now(),
}) {
  const down = {};
  // One-shot presses swallowed by the cooldown; their release is swallowed too.
  const suppressed = {};
  const gate = createCooldownGate(cooldownMs, now);
  let mode = null;
  let disposed = false;
  let unlisten = null;
  let listenerReady = null;
  let queue = Promise.resolve();
  // Bindings the native sink accepted: Rust dispatches their one-shot action
  // events itself, so onAction must not fire them a second time.
  let nativeBindings = new Set();

  const edge = (name, pressed) => {
    if (!!down[name] === pressed) return;
    down[name] = pressed;
    if (name !== 'ptt') {
      if (pressed && !gate(name)) { suppressed[name] = true; return; }
      if (!pressed && suppressed[name]) { suppressed[name] = false; return; }
    }
    onAction(name, pressed);
  };
  // A rebind or teardown can drop a binding mid-press; its release would
  // never arrive, leaving PTT stuck on (and, with the dedupe above, the next
  // real press swallowed). Release locally first; a late release from the
  // old binding is then a no-op.
  const releaseHeld = () => {
    for (const name of Object.keys(down)) if (down[name]) edge(name, false);
  };

  const ensureListener = () => {
    if (!listenerReady) {
      listenerReady = listen('specter://hotkey', (ev) => {
        const p = ev?.payload;
        if (mode === 'native' && p && typeof p.name === 'string') edge(p.name, !!p.pressed);
      }).then((fn) => {
        if (disposed) fn(); else unlisten = fn;
      });
    }
    return listenerReady;
  };

  const unregisterPlugin = async () => {
    try {
      const { unregisterAll } = await loadPlugin();
      await unregisterAll();
    } catch (e) { log.warn('global-shortcut unregisterAll failed:', e); }
  };

  const doApply = async (bindings) => {
    if (disposed) return 'disposed';
    releaseHeld();
    try {
      // Listener first, so the first edge after the bind can't be missed.
      await ensureListener();
      // Set before the invoke: the sink can emit an edge before the invoke's
      // reply arrives, and the listener only forwards in native mode.
      const prev = mode;
      mode = 'native';
      let res;
      try {
        res = await invoke('hotkeys_set_bindings', { bindings });
      } catch (e) { mode = prev; throw e; }
      nativeBindings = new Set(res?.accepted || []);
      const rejected = res?.rejected || [];
      for (const [name, err] of rejected) log.warn(`hotkey ${name} rejected:`, err);
      // Clear anything the plugin holds (an earlier fallback, a previous
      // per-binding fallback, or a webview reload — plugin registrations live
      // in Rust and outlive the page).
      if (prev !== 'native' || rejected.length) await unregisterPlugin();
      // A binding the native sink can't parse falls back to the plugin on its
      // own, instead of silently not working (2.0.10/2.0.11 rejected legacy
      // "Alt+W"-style combos this way and every hotkey went dead).
      if (rejected.length) {
        const { register } = await loadPlugin();
        for (const [name] of rejected) {
          const combo = bindings[name];
          if (!combo || disposed) continue;
          try {
            await register(toPluginAccel(combo), (ev) => edge(name, ev.state === 'Pressed'));
          } catch (e) { log.warn(`${name} shortcut register failed:`, e); }
        }
      }
      return 'native';
    } catch (e) {
      if (mode !== 'plugin') log.warn('native hotkeys unavailable, falling back to global-shortcut:', e);
    }
    if (disposed) return 'disposed';
    mode = 'plugin';
    nativeBindings = new Set();
    const { register, unregisterAll } = await loadPlugin();
    await unregisterAll();
    for (const [name, combo] of Object.entries(bindings)) {
      if (!combo || disposed) continue;
      try {
        await register(toPluginAccel(combo), (ev) => edge(name, ev.state === 'Pressed'));
      } catch (e) { log.warn(`${name} shortcut register failed:`, e); }
    }
    return disposed ? 'disposed' : 'plugin';
  };

  return {
    get mode() { return mode; },
    get nativeBindings() { return nativeBindings; },
    apply(bindings) {
      const run = queue.then(() => doApply(bindings));
      queue = run.catch(() => {});
      return run;
    },
    dispose() {
      const run = queue.then(async () => {
        disposed = true;
        releaseHeld();
        if (mode === 'native') {
          try { await invoke('hotkeys_set_bindings', { bindings: {} }); } catch { /* sink gone */ }
        }
        if (mode === 'plugin') await unregisterPlugin();
        unlisten?.();
        unlisten = null;
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}
