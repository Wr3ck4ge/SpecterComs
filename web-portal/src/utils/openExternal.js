// Open an http(s) link in the user's system browser — never inside the app's
// webview. In Tauri this goes through the opener plugin (the strip window's
// capability, src-tauri/capabilities/strip.json, allows http/https only);
// outside Tauri (dev preview) a new tab with no opener.
import { safeHref } from './safeMarkdown.js';

const inTauri = () => typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);

/** Resolves true when handed to the browser; false for a refused URL. Throws if the opener fails. */
export async function openExternal(url) {
  const href = safeHref(url);
  if (!href) return false;
  if (inTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(href);
  } else {
    window.open(href, '_blank', 'noopener,noreferrer');
  }
  return true;
}
