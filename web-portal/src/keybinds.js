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
  // Push-to-talk stays unbound by default: the default voice mode is
  // voice-activated, and silently claiming a key for a mode the user isn't in
  // would swallow that keypress from whatever has focus (a registered global
  // hotkey is exclusive — the foreground app never sees it).
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
