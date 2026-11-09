/**
 * E2EV: this client's version, sent as `client_version` with every voice
 * media-ticket request. identity-node refuses voice tickets to clients below
 * MIN_RELAY_CLIENT_VERSION (2.0.0) — voice is end-to-end encrypted relay voice
 * only, which older clients can't speak — and signs the version into the
 * ticket for media-rust to re-check.
 *
 * Desktop: Tauri's getVersion() (tauri.conf.json). Browser build: the
 * package.json version baked in by vite.config.js (__SPECTER_CLIENT_VERSION__).
 * Both must be bumped together at release.
 */

let cached = null;

export async function getClientVersion() {
  if (cached) return cached;
  let v = '';
  try {
    if (typeof window !== 'undefined' && (window.__TAURI_INTERNALS__ || window.__TAURI__)) {
      const { getVersion } = await import('@tauri-apps/api/app');
      v = await getVersion();
    }
  } catch { /* fall through to the build-time version */ }
  if (!v) {
    // eslint-disable-next-line no-undef
    v = typeof __SPECTER_CLIENT_VERSION__ !== 'undefined' ? __SPECTER_CLIENT_VERSION__ : '';
  }
  cached = v || '0.0.0';
  return cached;
}

/** Matches identity-node's CLIENT_UPGRADE_REQUIRED refusal (voiceClientGate.ts). */
export const UPGRADE_REQUIRED_PREFIX = 'Update SpecterComs to';

/**
 * True when a media-ticket error is the server's version-gate refusal.
 * fetchWithAuth surfaces only the response `message`, which identity-node
 * starts with UPGRADE_REQUIRED_PREFIX (it's also what pre-2.0.0 clients show).
 */
export function isUpgradeRequiredError(message) {
  return typeof message === 'string' && message.startsWith(UPGRADE_REQUIRED_PREFIX);
}
