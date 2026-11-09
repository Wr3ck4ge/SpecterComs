// What counts as a hardware id for ban purposes.
//
// The only real hardware id is the desktop client's get_hwid (web-portal
// src-tauri lib.rs): a lowercase hex SHA-256 over a salted machine
// fingerprint, i.e. exactly 64 [0-9a-f] characters. Anything else a client
// sends — the old shared 'browser-fallback-hwid' literal that every browser
// login used, or any per-browser id — identifies no machine. Storing it on
// users.hwid makes the HWID data meaningless, and putting it in hardware_bans
// would lock out every user who sends the same value, so login/register
// neither record nor ban-check it, and the admin ban path never bans it.
const HARDWARE_ID_RE = /^[0-9a-f]{64}$/;

export function isHardwareId(hwid: unknown): hwid is string {
  return typeof hwid === 'string' && HARDWARE_ID_RE.test(hwid);
}

/** The hwid to record / ban-check, or null when the value isn't a hardware id. */
export function hardwareIdOrNull(hwid: unknown): string | null {
  return isHardwareId(hwid) ? hwid : null;
}
