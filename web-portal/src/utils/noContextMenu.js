// NOINSPECT (owner 2026-11-13): no browser right-click menu (Back / Reload /
// Print / Inspect) in the app's windows. Text fields keep it for cut / copy /
// paste. The app's own right-click handlers (e.g. report a message) still run:
// they call preventDefault themselves; this only stops the WebView2 default.
// Release builds also ship without Tauri's `devtools` feature (Cargo.toml),
// so F12 / Ctrl+Shift+I open nothing.

const isEditable = (el) => {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return !el.readOnly && !el.disabled;
  if (tag === 'INPUT') {
    const t = (el.type || 'text').toLowerCase();
    return !el.readOnly && !el.disabled && ['text', 'search', 'url', 'email', 'tel', 'password', 'number'].includes(t);
  }
  return false;
};

export function blockDefaultContextMenu(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || import.meta.env?.DEV) return; // dev builds keep Inspect
  doc.addEventListener('contextmenu', (e) => {
    if (isEditable(e.target)) return;
    e.preventDefault();
  });
}

blockDefaultContextMenu();
