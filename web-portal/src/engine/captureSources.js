// Native capture sources for the strip's screen-share picker (P2A). The
// engine lists them with the same Rust command CommLink's own picker uses
// (capture_list_sources) and hands them to the strip over the bridge
// (share.listSources). Thumbnails come from Rust as raw BGRA (≈230 KB each in
// base64); they're re-encoded to small JPEG data URLs here so the bridge
// payload stays small (the strip's CSP allows data: images).

/** Native (Windows Tauri) capture is what the strip picker drives. */
export function nativeCaptureAvailable() {
  if (typeof window === 'undefined' || !window.__TAURI__) return false;
  if (!navigator.userAgent.toLowerCase().includes('windows')) return false;
  try {
    // CommLink's troubleshooting switch to the browser picker; that one can't
    // be driven from the strip (its dialog would open in the hidden engine).
    return localStorage.getItem('specter_capture_mode') !== 'browser-fallback';
  } catch {
    return true;
  }
}

function thumbToDataUrl(source) {
  const { thumb_b64: b64, thumb_width: w, thumb_height: h } = source;
  if (!b64 || !w || !h) return null;
  try {
    const raw = atob(b64);
    const rgba = new Uint8ClampedArray(w * h * 4);
    const n = Math.min(raw.length, rgba.length);
    for (let i = 0; i + 3 < n; i += 4) {
      rgba[i] = raw.charCodeAt(i + 2);     // R ← B
      rgba[i + 1] = raw.charCodeAt(i + 1); // G
      rgba[i + 2] = raw.charCodeAt(i);     // B ← R
      rgba[i + 3] = 255;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
}

/** → [{ id, name, kind, thumb, width, height }] for share.listSources. */
export async function listCaptureSourcesForStrip() {
  const sources = await window.__TAURI__.core.invoke('capture_list_sources');
  return (sources || []).map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind === 'window' ? 'window' : 'monitor',
    thumb: thumbToDataUrl(s),
    width: s.source_width || null,
    height: s.source_height || null,
  }));
}
