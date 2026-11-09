/**
 * Server-assisted network diagnosis ("netprobe") for the desktop client's
 * Repair panel. See services/media-rust/src/netdiag.rs for the relay side and
 * the UDP wire format.
 *
 *   POST /diag/netprobe          (auth, 3 per 10 min per user)
 *     mints a single-use 16-byte token + 32-byte HMAC key (TTL 60 s), arms it
 *     on every relay (specter.cmd.netprobe.arm) and waits briefly for the
 *     relays' "armed" answers →
 *     { token, key, ttl_secs, expires_at, client_ip, targets: [{ node_id, public_url, ports }] }
 *   GET  /diag/netprobe/:token   (auth, owner only)
 *     → { token, expires_at, client_ip, targets, reports: [what each relay saw] }
 *
 * Relays answer on specter.diag.netprobe.<node_id> (their NATS user may
 * publish only its own suffix — natsSubjects.ts); a payload whose node_id
 * disagrees with the subject, or that names a token we didn't mint, is
 * dropped. Everything lives in memory and is gone a minute after expiry;
 * nothing is persisted. The key goes to the client so it can verify the
 * relay's UDP replies (HMAC) — it authenticates replies, it isn't a secret
 * from the user who asked.
 */
import crypto from 'crypto';
import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { connectNats, publishEvent } from '../config/nats.js';
import { scopedNodeId } from '../utils/natsSubjects.js';

export const NETPROBE_ARM_SUBJECT = 'specter.cmd.netprobe.arm';
export const NETPROBE_RESULT_BASE = 'specter.diag.netprobe';
export const NETPROBE_TTL_SECS = 60;
export const NETPROBE_RATE = { windowMs: 10 * 60_000, max: 3 };
const ARM_WAIT_MS = 1500;
const ARM_SETTLE_MS = 250;
const KEEP_AFTER_EXPIRY_MS = 60_000;
const MAX_PROBES = 2000;
const MAX_PACKETS = 64;
const MAX_HANDSHAKES = 8;

export interface ProbeTarget { node_id: string; public_url: string; ports: number[] }
export interface PacketSeen { port: number; size: number; seq: number; at_ms: number; src: string; replied: boolean }
export interface NodeReport {
  node_id: string;
  packets: PacketSeen[];
  replies_sent: number;
  dropped_over_cap: number;
  webtransport: Array<{ at_ms: number; src: string }>;
  client_ip_matched: boolean | null;
  final_report: boolean;
}
export interface ProbeEntry {
  token: string;
  key: string;
  userId: string;
  clientIp: string | null;
  createdAt: number;
  expiresAt: number;
  targets: Map<string, ProbeTarget>;
  reports: Map<string, NodeReport>;
}

const num = (v: unknown, max = Number.MAX_SAFE_INTEGER) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : 0);
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const ports = (v: unknown) => (Array.isArray(v) ? v.filter((p) => Number.isInteger(p) && p > 0 && p < 65536).slice(0, 4) : []);

/** In-memory probe store + rate limiter. Clock injectable for tests. */
export function createNetprobeStore(now: () => number = Date.now) {
  const probes = new Map<string, ProbeEntry>();
  const starts = new Map<string, number[]>(); // userId -> start timestamps

  const sweep = () => {
    const t = now();
    for (const [k, p] of probes) if (t > p.expiresAt + KEEP_AFTER_EXPIRY_MS) probes.delete(k);
    for (const [u, list] of starts) {
      const recent = list.filter((x) => t - x < NETPROBE_RATE.windowMs);
      if (recent.length) starts.set(u, recent); else starts.delete(u);
    }
  };

  return {
    probes,
    /** true = this user may start another probe now (and it is counted). */
    allowStart(userId: string): boolean {
      sweep();
      const list = starts.get(userId) ?? [];
      if (list.length >= NETPROBE_RATE.max) return false;
      list.push(now());
      starts.set(userId, list);
      return true;
    },
    create(userId: string, clientIp: string | null): ProbeEntry | null {
      sweep();
      if (probes.size >= MAX_PROBES) return null;
      const entry: ProbeEntry = {
        token: crypto.randomBytes(16).toString('hex'),
        key: crypto.randomBytes(32).toString('hex'),
        userId, clientIp,
        createdAt: now(),
        expiresAt: now() + NETPROBE_TTL_SECS * 1000,
        targets: new Map(), reports: new Map(),
      };
      probes.set(entry.token, entry);
      return entry;
    },
    get(token: string): ProbeEntry | undefined { sweep(); return probes.get(token); },
    /**
     * One relay message (subject specter.diag.netprobe.<node_id>). Returns
     * why it was dropped, or 'ok'.
     */
    ingest(subject: string, payload: any): 'ok' | 'bad_subject' | 'node_mismatch' | 'unknown_token' | 'bad_type' {
      const nodeId = scopedNodeId(subject, NETPROBE_RESULT_BASE);
      if (typeof nodeId !== 'string') return 'bad_subject';
      if (!payload || payload.node_id !== nodeId) return 'node_mismatch';
      const p = probes.get(typeof payload.token === 'string' ? payload.token : '');
      if (!p) return 'unknown_token';
      if (payload.type !== 'armed' && payload.type !== 'report') return 'bad_type';
      p.targets.set(nodeId, { node_id: nodeId, public_url: str(payload.public_url), ports: ports(payload.ports) });
      if (payload.type === 'report') {
        p.reports.set(nodeId, {
          node_id: nodeId,
          packets: (Array.isArray(payload.packets) ? payload.packets : []).slice(0, MAX_PACKETS).map((r: any) => ({
            port: num(r?.port, 65535), size: num(r?.size, 65535), seq: num(r?.seq, 65535),
            at_ms: num(r?.at_ms), src: str(r?.src, 64), replied: r?.replied === true,
          })),
          replies_sent: num(payload.replies_sent),
          dropped_over_cap: num(payload.dropped_over_cap),
          webtransport: (Array.isArray(payload.webtransport) ? payload.webtransport : []).slice(0, MAX_HANDSHAKES)
            .map((h: any) => ({ at_ms: num(h?.at_ms), src: str(h?.src, 64) })),
          client_ip_matched: typeof payload.client_ip_matched === 'boolean' ? payload.client_ip_matched : null,
          final_report: payload.final_report === true,
        });
      }
      return 'ok';
    },
  };
}

export type NetprobeStore = ReturnType<typeof createNetprobeStore>;
export const netprobeStore = createNetprobeStore();

let listening: Promise<void> | null = null;
/** Subscribes (once) to every relay's netprobe answers. */
export function ensureNetprobeListener(store: NetprobeStore = netprobeStore): Promise<void> {
  if (!listening) {
    listening = (async () => {
      const nc = await connectNats();
      if (!nc) { listening = null; return; }
      const sub = nc.subscribe(`${NETPROBE_RESULT_BASE}.>`);
      (async () => {
        for await (const msg of sub) {
          let payload: any = null;
          try { payload = JSON.parse(new TextDecoder().decode(msg.data)); } catch { continue; }
          store.ingest(msg.subject, payload);
        }
      })().catch((err) => { console.error('[netprobe] listener stopped:', err); listening = null; });
    })();
  }
  return listening;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const publicView = (p: ProbeEntry) => ({
  token: p.token,
  expires_at: new Date(p.expiresAt).toISOString(),
  client_ip: p.clientIp,
  targets: [...p.targets.values()],
  reports: [...p.reports.values()],
});

/** POST /diag/netprobe */
export function makeStartNetprobe(store: NetprobeStore = netprobeStore, waitMs = ARM_WAIT_MS) {
  return async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!store.allowStart(userId)) {
      return res.status(429).json({ message: 'Network test already run recently. Try again in a few minutes.' });
    }
    const clientIp = typeof req.ip === 'string' ? req.ip.replace(/^::ffff:/, '') : null;
    const entry = store.create(userId, clientIp);
    if (!entry) return res.status(503).json({ message: 'Network test unavailable right now' });
    await ensureNetprobeListener(store).catch(() => {});
    await publishEvent('specter.cmd.netprobe.arm', { // = NETPROBE_ARM_SUBJECT (literal for the publish-site scanner)
      token: entry.token, key: entry.key, ttl_secs: NETPROBE_TTL_SECS, client_ip: clientIp,
    });
    // Wait for the relays' "armed" answers (first one, then a short settle).
    const deadline = Date.now() + waitMs;
    while (entry.targets.size === 0 && Date.now() < deadline) await sleep(50);
    if (entry.targets.size) await sleep(Math.min(ARM_SETTLE_MS, Math.max(0, deadline - Date.now())));
    return res.json({ ...publicView(entry), key: entry.key, ttl_secs: NETPROBE_TTL_SECS });
  };
}

/** GET /diag/netprobe/:token */
export function makeGetNetprobe(store: NetprobeStore = netprobeStore) {
  return (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    const token = String(req.params.token || '');
    const p = /^[0-9a-f]{32}$/.test(token) ? store.get(token) : undefined;
    // Not yours = not found (no token-existence oracle).
    if (!p || p.userId !== userId) return res.status(404).json({ message: 'Not found' });
    return res.json(publicView(p));
  };
}
