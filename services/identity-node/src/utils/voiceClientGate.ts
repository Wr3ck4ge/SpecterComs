/**
 * E2EV: minimum client version for voice.
 *
 * From SpecterComs 2.0.0 every voice room is an end-to-end encrypted relay
 * room (MLS-keyed, relay wire v3 — see web-portal/wasm-crypto/src/relay_audio.rs).
 * A pre-2.0.0 client would either send plaintext Opus into such a room or
 * hand the relay's ciphertext to its decoder, so voice tickets are refused to
 * any client that doesn't declare a version >= MIN_VOICE_CLIENT_VERSION.
 *
 * The declared version is self-reported and therefore only a compatibility
 * gate, not an authorization control (a modified client can lie, but a
 * member who can modify their client already holds the channel key). The
 * part that must not be bypassable — "no voice room is ever mixed again,
 * and no token minted before the gate existed is accepted" — is enforced by
 * media-rust from the signed ticket claims (voice_relay === true and
 * client_version >= its own minimum), which only this service can mint.
 */

/** Overridable for a staging server testing an unbumped build. */
export const MIN_VOICE_CLIENT_VERSION: string =
  (process.env.MIN_RELAY_CLIENT_VERSION || '').trim() || '2.0.0';

/** Stable error code; v2 clients match on it, older clients show `message`. */
export const CLIENT_UPGRADE_REQUIRED = 'CLIENT_UPGRADE_REQUIRED';

/**
 * Parses "MAJOR.MINOR.PATCH" (optional leading "v", any "-pre"/"+build"
 * suffix ignored). Returns null for anything else.
 */
export function parseClientVersion(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+].*)?$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** True when `declared` is a parseable version at or above the minimum. */
export function meetsVoiceMinimum(declared: unknown, minimum: string = MIN_VOICE_CLIENT_VERSION): boolean {
  const have = parseClientVersion(declared);
  const need = parseClientVersion(minimum);
  if (!have || !need) return false;
  return compareVersions(have, need) >= 0;
}

/**
 * The refusal body. `message` is what pre-2.0.0 clients display verbatim
 * (their CommLink logs "Connection failed: <message>"), so it carries the
 * whole instruction on its own.
 */
export function upgradeRequiredBody(minimum: string = MIN_VOICE_CLIENT_VERSION) {
  return {
    code: CLIENT_UPGRADE_REQUIRED,
    min_version: minimum,
    message: `Update SpecterComs to v${minimum} to use voice — voice is now end-to-end encrypted and this version can't join.`,
  };
}
