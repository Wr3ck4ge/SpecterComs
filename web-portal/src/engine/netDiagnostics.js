// "Repair connection": the engine-side probes (runs in the hidden main
// window, the same WebView2 that carries voice). Pure classification and the
// report live in ./connectionRepair.js.
//
// What each check can and cannot prove:
//   api    GET <API>/health over HTTPS (TCP). Proves the server is reachable
//          at all; says nothing about UDP.
//   ticket POST /orgs/:id/media-ticket for a voice channel of the current
//          server. Proves auth + the version gate; gives the relay URL(s)
//          CommLink would use. Minting a ticket has no side effect.
//   wt     a WebTransport session to <media_url>/specter/netprobe from THIS
//          WebView2. The relay refuses that path (404) after the QUIC +
//          HTTP/3 handshake, so a fast rejection = UDP + QUIC work end to
//          end; a timeout = no handshake (UDP 443 / QUIC blocked somewhere).
//          It can't tell WHERE it's blocked (PC vs router vs ISP).
//   wtAlt  the same on alt_media_url, when the relay offers an alternate port.
//   wtNative  the same handshake from the native client (native_wt.rs), the
//          transport voice falls back to automatically when WebView2's fails.
//   local  native (netdiag.rs): the QuicAllowed policy (Edge/WebView2, HKLM
//          and HKCU) and the system proxy. Absent in older builds.
//   netprobe  the server-assisted test (POST/GET /diag/netprobe, netdiag.rs):
//          which UDP sizes and ports reached the relay, whether its signed
//          replies came back, a version check on UDP 443 and a native QUIC
//          handshake. Tells apart the causes in connectionRepair.classifyPath.
//          Skipped when rate-limited or on a server without it.
//   mls    per channel of every server: does this device hold the group, at
//          the server's epoch (read-only: GET group-info; no commits).
import { API_BASE_URL } from '../apiBase.js';
import { WT_TIMEOUT_MS } from './connectionRepair.js';
import { ensureIdentity, groupEpoch } from '../mlsSession.js';
import { NativeWebTransport } from './nativeWebTransport.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const inTauri = () => typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
const MAX_MLS_CHANNELS = 60;
const RELAY_REPORT_WAIT_MS = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Last diagnosis + repair report, included in "Submit diagnostics". */
let lastReport = null;
export const setLastNetReport = (r) => { lastReport = r ? { ...r, at: new Date().toISOString() } : null; };
export const getLastNetReport = () => lastReport;

export async function checkApi(fetchFn = fetch) {
  const t0 = now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetchFn(`${API_BASE_URL}/health`, { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(timer);
    return { ok: r.ok, ms: Math.round(now() - t0), error: r.ok ? null : `HTTP ${r.status}` };
  } catch (err) {
    return { ok: false, ms: Math.round(now() - t0), error: err?.name === 'AbortError' ? 'timed out' : err?.message || String(err) };
  }
}

/** One WebTransport handshake to <base>/specter/netprobe (see the header). */
export async function probeWebTransport(base, token = 'diag', timeoutMs = WT_TIMEOUT_MS + 2000) {
  if (!base) return { result: 'skipped', ms: null, error: null };
  if (typeof WebTransport === 'undefined') return { result: 'error', ms: 0, error: 'WebTransport not available' };
  const url = `${String(base).replace(/\/$/, '')}/specter/netprobe?token=${token}`;
  const t0 = now();
  let wt;
  try { wt = new WebTransport(url); } catch (err) { return { result: 'error', ms: 0, error: err?.message || String(err) }; }
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => res('timeout'), timeoutMs); });
  const outcome = await Promise.race([
    wt.ready.then(() => 'open', (err) => ({ err })),
    timeout,
  ]);
  clearTimeout(timer);
  const ms = Math.round(now() - t0);
  try { wt.close(); } catch { /* already closed */ }
  wt.closed?.catch?.(() => {});
  if (outcome === 'open') return { result: 'open', ms, error: null };
  if (outcome === 'timeout') return { result: 'timeout', ms, error: null };
  // Chromium reports both "server refused" and "no handshake" as an opaque
  // failure; the time it took is what tells them apart.
  return { result: ms >= WT_TIMEOUT_MS ? 'timeout' : 'rejected', ms, error: outcome.err?.message || null };
}

/**
 * The same handshake from the native client (native_wt.rs) instead of
 * WebView2: tells "the network blocks QUIC" from "it blocks browser QUIC"
 * (the case the native fallback fixes). Token 'diag', so the relay's armed
 * netprobe counts only the WebView2 attempt. Tauri only.
 */
export async function probeNativeWebTransport(base, Native = NativeWebTransport) {
  if (!base || !inTauri()) return { result: 'skipped', ms: null, error: null };
  const url = `${String(base).replace(/\/$/, '')}/specter/netprobe?token=diag`;
  const t0 = now();
  const t = new Native(url);
  const outcome = await t.ready.then(() => 'open', (err) => ({ err }));
  const ms = Math.round(now() - t0);
  try { t.close(); } catch { /* closed */ }
  if (outcome === 'open') return { result: 'open', ms, error: null };
  const msg = outcome.err?.message || String(outcome.err);
  if (/rejected/i.test(msg)) return { result: 'rejected', ms, error: null };
  if (/timed out/i.test(msg)) return { result: 'timeout', ms, error: null };
  return { result: 'error', ms, error: msg };
}

async function localChecks() {
  if (!inTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const r = await invoke('netdiag_local_checks');
    return {
      quicDisabledBy: Array.isArray(r?.quic_disabled_by) ? r.quic_disabled_by : [],
      proxy: { enabled: Boolean(r?.proxy_enabled), server: r?.proxy_server || null, autoConfigUrl: r?.proxy_auto_config_url || null },
    };
  } catch { return null; } // older native build
}

/** The armed relay whose public_url is `mediaUrl` (else the first armed one). */
export function pickTarget(targets = [], mediaUrl) {
  const norm = (u) => String(u || '').replace(/\/$/, '');
  return targets.find((t) => norm(t.public_url) === norm(mediaUrl)) || targets[0] || null;
}

async function nativeProbe(args) {
  if (!inTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke('netdiag_probe', { args });
  } catch { return null; } // older native build
}

const hostAndPort = (url) => {
  try { const u = new URL(url); return { host: u.hostname, port: Number(u.port) || 443 }; } catch { return null; }
};

/**
 * The transport checks, run together so the relay sees them inside one
 * window. → { wt, wtAlt, netprobe }. Without a usable netprobe start the
 * native checks that need no token still run.
 */
async function transportChecks(api, mediaUrl, altMediaUrl) {
  const main = hostAndPort(mediaUrl);
  const alt = hostAndPort(altMediaUrl);
  const { data: start } = await Promise.resolve(api.startNetprobe?.()).catch(() => ({})) || {};
  const target = start?.token ? pickTarget(start.targets, mediaUrl) : null;
  const ports = target?.ports || [];
  const [wt, wtAlt, native, wtNative] = await Promise.all([
    probeWebTransport(mediaUrl, start?.token || 'diag'),
    probeWebTransport(altMediaUrl),
    main ? nativeProbe({
      host: main.host, main_port: main.port, quic_ports: alt ? [alt.port] : [], udp_ports: ports,
      token: start?.token || null, key: start?.key || null,
    }) : null,
    probeNativeWebTransport(mediaUrl).catch(() => ({ result: 'error', ms: null, error: 'probe failed' })),
  ]);
  let relay = null;
  if (start?.token) {
    await sleep(RELAY_REPORT_WAIT_MS); // the relay publishes changes every 300 ms
    const { data } = await api.getNetprobe(start.token);
    const r = (data?.reports || []).find((x) => x.node_id === target?.node_id) || null;
    if (r) relay = { packets: r.packets.map((p) => ({ port: p.port, size: p.size })), webtransport: r.webtransport.length, repliesSent: r.replies_sent, clientIpMatched: r.client_ip_matched };
  }
  const netprobe = start?.token || native ? {
    armed: ports.length > 0, ports, mainPort: main?.port ?? null, clientIp: start?.client_ip || null, native, relay,
  } : null;
  return { wt: confirmHandshake(wt, target, relay), wtAlt, wtNative, netprobe };
}

/**
 * A fast WebTransport failure normally means the relay's 404, i.e. the
 * handshake worked; but a local refusal or an ICMP error looks the same from
 * here. When the relay armed the token and reports no handshake, it never
 * arrived, so don't count it as reached.
 */
export function confirmHandshake(wt, target, relay) {
  if (wt?.result !== 'rejected' || !target || !relay || relay.webtransport > 0) return wt;
  return { ...wt, result: 'error', error: wt.error || 'failed before reaching the relay' };
}

async function firstVoiceChannel(api, orgId) {
  const { data } = await api.getChannels(orgId);
  const list = Array.isArray(data?.channels) ? data.channels : [];
  return { list, voice: list.find((c) => (c.channel_kind ?? 0) === 0) || null };
}

async function mlsHealth(api, userId, orgs) {
  const out = { checked: 0, behind: [], missing: [], errors: 0, keyPackage: 'unknown' };
  if (!userId) return out;
  try { await ensureIdentity(api, userId); } catch { out.errors += 1; return out; }
  try {
    const deviceId = localStorage.getItem(`specter_mls_device_id:${userId}`);
    const { data } = await api.getUserDeviceKeyPackages(userId);
    if (deviceId && Array.isArray(data?.devices)) out.keyPackage = data.devices.some((d) => d.device_id === deviceId) ? 'present' : 'missing';
  } catch { /* unknown */ }
  let budget = MAX_MLS_CHANNELS;
  for (const org of orgs) {
    if (budget <= 0) break;
    let list = [];
    try { ({ list } = await firstVoiceChannel(api, org.id)); } catch { out.errors += 1; continue; }
    for (const ch of list.slice(0, budget)) {
      budget -= 1;
      const { data, error } = await api.getChannelMlsGroupInfo(org.id, ch.id);
      if (!data) { if (error && !/403|forbidden|not on|member/i.test(String(error))) out.errors += 1; continue; } // 403: not on this group's list
      if (!data.exists) continue;
      out.checked += 1;
      const local = groupEpoch(ch.id);
      const entry = { orgId: org.id, server: org.callsign || org.name || org.id, channel: ch.name || ch.id, local, server_epoch: data.epoch };
      if (local == null) out.missing.push(entry);
      else if (local !== Number(data.epoch)) out.behind.push(entry);
    }
  }
  return out;
}

/**
 * The full diagnosis. orgs: [{ id, callsign }] (every server); orgId: the
 * current one (its voice channel is used for the ticket).
 */
export async function runDiagnosis({ api, userId, orgs = [], orgId, clientVersion = null, voice = null }) {
  const diag = { at: new Date().toISOString(), voice };
  const [apiRes, local] = await Promise.all([checkApi(), localChecks()]);
  diag.api = apiRes;
  diag.local = local;
  diag.ticket = { ok: false, status: 'skipped', error: 'No voice channel on this server', mediaUrl: null, altMediaUrl: null };
  if (apiRes.ok && orgId) {
    try {
      const { voice: ch } = await firstVoiceChannel(api, orgId);
      if (ch) {
        const { data, error } = await api.getOrgMediaTicket(orgId, ch.id, 'voice', null, clientVersion);
        diag.ticket = data?.ticket
          ? { ok: true, status: 200, error: null, mediaUrl: data.media_url || null, altMediaUrl: data.alt_media_url || null }
          : { ok: false, status: 'error', error: typeof error === 'string' ? error : 'Ticket refused', mediaUrl: null, altMediaUrl: null };
      }
    } catch (err) {
      diag.ticket = { ok: false, status: 'error', error: err?.message || String(err), mediaUrl: null, altMediaUrl: null };
    }
  }
  Object.assign(diag, diag.ticket.mediaUrl
    ? await transportChecks(api, diag.ticket.mediaUrl, diag.ticket.altMediaUrl)
    : { wt: { result: 'skipped', ms: null, error: null }, wtAlt: { result: 'skipped', ms: null, error: null }, netprobe: null });
  try { diag.mls = await mlsHealth(api, userId, orgs); } catch { diag.mls = null; }
  return diag;
}
