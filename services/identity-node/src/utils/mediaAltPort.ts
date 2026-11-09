/**
 * Alternate WebTransport port per relay (media-rust WEBTRANSPORT_ALT_PORT),
 * learned from the optional heartbeat field `alt_port` (absent = none). Kept
 * in memory, keyed by the node's public_url: heartbeats arrive every few
 * seconds, so a restart re-learns it at once and no migration is needed.
 * The media-ticket response turns it into `alt_media_url` (same host, alt
 * port) for clients whose network blocks UDP 443 only.
 */
const STALE_MS = 30_000;
const altPorts = new Map<string, { port: number; at: number }>();

export function noteNodeAltPort(publicUrl: unknown, altPort: unknown, now = Date.now()): void {
  if (typeof publicUrl !== 'string' || !publicUrl) return;
  if (Number.isInteger(altPort) && (altPort as number) > 0 && (altPort as number) < 65536) {
    altPorts.set(publicUrl.replace(/\/$/, ''), { port: altPort as number, at: now });
  } else {
    altPorts.delete(publicUrl.replace(/\/$/, ''));
  }
}

/** `mediaUrl` with the relay's alternate port, or null when it has none (or it's stale). */
export function altMediaUrlFor(mediaUrl: unknown, now = Date.now()): string | null {
  if (typeof mediaUrl !== 'string' || !mediaUrl) return null;
  const e = altPorts.get(mediaUrl.replace(/\/$/, ''));
  if (!e || now - e.at > STALE_MS) return null;
  try {
    const u = new URL(mediaUrl);
    u.port = String(e.port);
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function _resetAltPortsForTests(): void { altPorts.clear(); }
