/**
 * Wave 3 S7: per-device wire capabilities ("everyone can read it", design
 * docs/WAVE3_FORMAT_V2_FRANKING_DESIGN.md §5). A client advertises the formats
 * it can READ in the X-Specter-Wire-Caps header when it registers a device /
 * uploads a KeyPackage; the value lands in user_devices.wire_caps (migration
 * 000086). The mls/members endpoints return { device_id: caps } so a sender can
 * switch a conversation to v2 only when every leaf of its group can read it
 * (S8). Self-reported: a lying server/client can only cause drops or keep v1,
 * which S9's enforcement closes.
 */
import { pool } from '../config/db.js';

/** Bit 0: chat/DM envelope v2 + franking. */
export const WIRE_CAP_CHAT_V2 = 1 << 0;
/** Bit 1: screen-share frames v2. */
export const WIRE_CAP_SHARE_V2 = 1 << 1;
const WIRE_CAPS_MAX = 0xffff;

/** Header value → caps (absent or malformed → 0, i.e. a v1-only device). */
export function parseWireCapsHeader(v: unknown): number {
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== 'string' || !/^\d{1,5}$/.test(s.trim())) return 0;
  const n = Number(s.trim());
  return n >= 0 && n <= WIRE_CAPS_MAX ? n : 0;
}

let warned = false;
function warnOnce(where: string, err: unknown) {
  if (warned) return;
  warned = true;
  console.warn(`[wireCaps] ${where} failed (migration 000086 not applied yet?): ${(err as Error)?.message || err}`);
}

/** Stores a device's advertised caps. Best-effort: never fails the caller. */
export async function recordWireCaps(deviceId: string, userId: string, header: unknown): Promise<void> {
  try {
    await pool.query(
      'UPDATE user_devices SET wire_caps = $3 WHERE id = $1 AND user_id = $2',
      [deviceId, userId, parseWireCapsHeader(header)],
    );
  } catch (err) {
    warnOnce('recordWireCaps', err);
  }
}

/**
 * { device_id: wire_caps } for every active device of `userIds`. Advisory: on
 * any error it returns {} (every device counts as v1 — the safe default).
 */
export async function deviceCapsFor(userIds: string[]): Promise<Record<string, number>> {
  if (userIds.length === 0) return {};
  try {
    const r = await pool.query(
      `SELECT id, wire_caps FROM user_devices
       WHERE user_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
      [userIds],
    );
    const out: Record<string, number> = {};
    for (const row of r.rows) {
      if (row?.id) out[String(row.id)] = Number(row.wire_caps) || 0;
    }
    return out;
  } catch (err) {
    warnOnce('deviceCapsFor', err);
    return {};
  }
}
