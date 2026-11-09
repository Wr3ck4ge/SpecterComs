// "Repair connection": the pure half — classification, the alternate-port
// decision, the repair step runner and the plain-text report. No I/O here so
// all of it is unit-tested (connectionRepair.test.js). The impure half:
//   engine/netDiagnostics.js            runs the probes in the engine window
//   components/CommLink.jsx             classifies connect failures (connectIssue)
//   components/strip/RepairPanel.jsx    the Settings → Repair connection panel
//
// Why this exists: voice and video are WebTransport (HTTP/3 over QUIC, UDP)
// to the relay. Login, the API and MLS are HTTPS over TCP. A network or PC
// that blocks UDP 443 / QUIC therefore looks like "everything works except
// voice", and CommLink used to just time out 8 times and give up silently.

/** A WebTransport `ready` that takes this long and then fails = no handshake (timeout). */
export const WT_TIMEOUT_MS = 6_000;
/** Consecutive transport timeouts (with the API reachable) before we call it a QUIC block. */
export const QUIC_BLOCK_AFTER_TIMEOUTS = 2;
/** How long a "use the alternate port on this network" preference lasts. */
export const ALT_PREF_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const ALT_PREF_KEY = 'specter_media_alt_pref';

/**
 * One failed CommLink connect() attempt → 'ticket' (failed before the
 * transport: API / auth / version gate), 'timeout' (the QUIC/WebTransport
 * handshake never completed) or 'rejected' (the transport failed fast:
 * the server, or a local policy, refused it).
 */
export function classifyConnectFailure({ phase, elapsedMs = 0, message = '' } = {}) {
  if (phase !== 'transport') return 'ticket';
  if (elapsedMs >= WT_TIMEOUT_MS || /timed? ?out|timeout/i.test(String(message))) return 'timeout';
  return 'rejected';
}

/**
 * CommLink's connect issue for the strip (state.voice.connectIssue), or null.
 * timeouts: consecutive transport timeouts; apiReachable: the ticket fetch
 * (HTTPS) worked on those attempts; gaveUp: auto-reconnect stopped.
 */
export function connectIssueFrom({ timeouts = 0, apiReachable = false, gaveUp = false, lastKind = null, attempts = 0, via = 'main', altUntried = false } = {}) {
  const quic = apiReachable && timeouts >= QUIC_BLOCK_AFTER_TIMEOUTS;
  // The next attempt tries the alternate port: nothing to tell the user yet.
  if (altUntried && !gaveUp) return null;
  if (!quic && !gaveUp) return null;
  return {
    kind: quic ? 'quic_blocked' : 'connect_failed',
    gaveUp: Boolean(gaveUp),
    timeouts, attempts, lastKind, via,
    message: quic
      ? "Voice can't reach the server. Your network or security software may be blocking UDP port 443 (QUIC), which voice needs."
      : "Voice couldn't connect after several tries.",
  };
}

/**
 * Which media URL connect() uses. timeouts = { main, alt } consecutive
 * transport timeouts per URL; pref = a fresh alternate-port preference for
 * this network (readAltPref). Alt is used when the relay offers one and
 * either the preference says so (and alt hasn't started timing out too) or
 * the main port has timed out repeatedly.
 */
export function chooseMediaUrl({ mediaUrl, altMediaUrl = null, timeouts = {}, pref = null }) {
  const main = { url: mediaUrl, via: 'main' };
  if (!altMediaUrl) return { ...main, reason: 'no_alt' };
  const tMain = timeouts.main || 0;
  const tAlt = timeouts.alt || 0;
  if (tAlt >= QUIC_BLOCK_AFTER_TIMEOUTS && tAlt >= tMain) return { ...main, reason: 'alt_failing' };
  if (pref?.useAlt) return { url: altMediaUrl, via: 'alt', reason: 'network_pref' };
  if (tMain >= QUIC_BLOCK_AFTER_TIMEOUTS) return { url: altMediaUrl, via: 'alt', reason: 'main_timeouts' };
  return { ...main, reason: 'default' };
}

/** The UDP port of a media URL as a number (443 when the URL names none). */
export function portOfUrl(url) {
  try { return Number(new URL(url).port) || 443; } catch { return null; }
}

/** "Connected via alternate port 3478" / "Connected via port 443". */
export function describeVia(via, port) {
  if (!via) return '';
  return via === 'alt' ? `Connected via alternate port ${port ?? '?'}` : `Connected via port ${port ?? 443}`;
}

/** The alternate-port preference, or null (none / expired / unreadable). */
export function readAltPref(storage, now = Date.now()) {
  try {
    const raw = storage?.getItem(ALT_PREF_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || typeof p.until !== 'number' || now > p.until) return null;
    return { useAlt: p.useAlt === true, publicIp: p.publicIp || null, until: p.until };
  } catch { return null; }
}

/**
 * Remember "use the alternate port" for this network. Keyed by the public IP
 * the netprobe reported when there is one (kept for the trace / report); the
 * TTL is what scopes it in practice, since connect() can't learn the public
 * IP without an extra request.
 */
export function writeAltPref(storage, { useAlt, publicIp = null }, now = Date.now()) {
  try {
    if (!useAlt) { storage?.removeItem(ALT_PREF_KEY); return null; }
    const p = { useAlt: true, publicIp, until: now + ALT_PREF_TTL_MS };
    storage?.setItem(ALT_PREF_KEY, JSON.stringify(p));
    return p;
  } catch { return null; }
}

// ── Where the path breaks (server-assisted probe) ───────────────────────

const PATH_VERDICTS = {
  udp_all_blocked: ['All UDP is being blocked',
    'None of the test packets reached the server, on any port, while normal web traffic works. Something is blocking UDP on this PC or at your router.',
    ['Try a phone hotspot: if voice works there, the block is your router or ISP; if not, it is this PC.',
      'Check your antivirus or security suite: firewall and "web shield" features can block UDP even when Windows Firewall is off.',
      'Turn off any VPN.',
      'Check your router for UDP, QUIC or gaming filters, and for security features such as "Active Armor" or "Advanced Security".']],
  udp443_blocked: ['UDP port 443 is blocked',
    'Test packets reach the server on other UDP ports but not on 443. Something blocks QUIC or UDP 443 specifically; other UDP traffic is fine.',
    ['Check your router for a "block QUIC" or "block UDP 443" setting.',
      'Antivirus web shields (Avast, AVG, Kaspersky, ESET, Bitdefender) often do this: turn that feature off or add SpecterComs as an exception.',
      'Try a phone hotspot to tell your network from this PC.']],
  mtu_blackhole: ['Large packets are being dropped',
    "Small test packets reach the server but packets of 1200 bytes or more don't. QUIC needs 1200-byte packets, so voice can't start. This usually comes from a VPN, a PPPoE connection or a cellular link.",
    ['Turn off any VPN.', 'Try a different network, such as a phone hotspot.', 'If this is your home connection, check the MTU setting on your router (it should normally be 1500, or 1492 for PPPoE).']],
  quic_dpi: ['QUIC is being blocked by inspection',
    'UDP port 443 itself works, but the QUIC handshake never finishes. Something on the path is recognising QUIC and stopping it.',
    ['Turn off the "web shield" or "HTTPS scanning" feature in your antivirus.', 'Turn off any VPN.', 'Try a phone hotspot to tell your network from this PC.']],
  // Not an error any more: the native transport (transportFactory.js) takes
  // over by itself. Seen on home networks whose router/ISP gateway drops
  // browser QUIC (phones on the same Wi-Fi fail too) but not ours.
  browser_quic_blocked: ['Your network blocks browser QUIC; using the native transport automatically',
    "QUIC connections the way browsers make them (Edge WebView2, phone browsers) don't get through on this network, but SpecterComs' own native connection does. Voice and video switch to the native connection by themselves, still end-to-end encrypted, so there's nothing you need to do.",
    ['Nothing to do. If you want browsers on this network to use HTTP/3 again, check your router for QUIC, UDP 443 or "advanced security" filtering.']],
  inbound_blocked: ['Replies from the server are being blocked',
    "Test packets reach the server, but its replies don't get back to this PC. Inbound UDP is being dropped by your router's NAT or firewall, or by security software.",
    ['Check your router and security software for inbound UDP filtering.', 'Restart your router.', 'Try a phone hotspot to tell your network from this PC.']],
};

/**
 * The classification table. np = diag.netprobe:
 *   armed      the relay accepted the token and has a diagnostic port
 *   mainPort   the relay's main UDP port
 *   native     netdiag_probe's result: { udp: [{ port, sent, replied, ... }],
 *              version: { sent, replied }, quic: [{ port, result }] }
 *   relay      what the relay saw: { packets: [{ port, size }], ... } | null
 * Returns a verdict (the same shape as classifyDiagnosis) or null when the
 * evidence doesn't single out one cause.
 */
export function classifyPath(diag = {}) {
  const np = diag.netprobe;
  if (!np?.native) return null;
  const { native, relay, armed, mainPort } = np;
  const mainQuic = (native.quic || []).find((q) => q.port === mainPort);
  const versionOk = native.version?.replied === true;
  const wtReached = diag.wt?.result === 'open' || diag.wt?.result === 'rejected';
  const verdict = (kind) => {
    const [title, explanation, steps] = PATH_VERDICTS[kind];
    const auto = kind === 'browser_quic_blocked';
    return { kind, severity: auto ? 'warn' : 'error', title, explanation, steps, voiceReachable: auto };
  };

  const nativeWtReached = diag.wtNative?.result === 'open' || diag.wtNative?.result === 'rejected';
  if (mainQuic?.result === 'ok' || nativeWtReached) return wtReached ? null : verdict('browser_quic_blocked');
  if (versionOk && mainQuic) return verdict('quic_dpi');
  if (!armed || !relay) return null;

  const arrived = relay.packets || [];
  if (arrived.length === 0) return versionOk ? null : verdict('udp_all_blocked');
  const small = arrived.some((p) => p.size < 1200);
  const large = arrived.some((p) => p.size >= 1200);
  if (small && !large) return verdict('mtu_blackhole');
  const replies = (native.udp || []).reduce((n, u) => n + (u.replied?.length || 0), 0);
  if (replies === 0) return verdict('inbound_blocked');
  return versionOk ? null : verdict('udp443_blocked');
}

// ── Diagnosis classification ────────────────────────────────────────────

/**
 * diag (netDiagnostics.runDiagnosis):
 *   api      { ok, ms, error }                GET /health over HTTPS
 *   ticket   { ok, status, error, mediaUrl, altMediaUrl }
 *   wt       { result: 'open'|'rejected'|'timeout'|'error'|'skipped', ms, error }  main port
 *   wtAlt    same, alternate port (result 'skipped' when the relay has none)
 *   local    { quicDisabledBy: string[] , proxy: { enabled, server, autoConfigUrl } } | null
 *   mls      { checked, behind: [], missing: [], errors, keyPackage: 'present'|'missing'|'unknown' }
 * → { kind, title, explanation, steps: string[], severity: 'ok'|'warn'|'error', voiceReachable }
 */
export function classifyDiagnosis(diag = {}) {
  const { api, ticket, wt, wtAlt, local, mls } = diag;
  const reached = (r) => r?.result === 'open' || r?.result === 'rejected';
  const policy = local?.quicDisabledBy || [];
  const out = (kind, severity, title, explanation, steps = [], voiceReachable = false) =>
    ({ kind, severity, title, explanation, steps, voiceReachable });

  if (api && !api.ok) {
    return out('api_unreachable', 'error', "Can't reach SpecterComs",
      'The app could not reach the SpecterComs server over HTTPS at all, so this is not a voice-only problem.',
      ['Check that this PC is online (open any website).', 'Turn off any VPN or proxy and try again.', 'If other sites work, the server may be down; try again in a few minutes.']);
  }
  if (ticket && !ticket.ok && ticket.status !== 'skipped') {
    return out('ticket_failed', 'error', 'The server refused a voice session',
      `Asking the server for a voice session failed${ticket.error ? `: ${ticket.error}` : ''}. Your network is not the problem here.`,
      ['If it says to update, install the latest version.', 'Sign out and back in, then try again.', 'Submit diagnostics so the team can look at it.']);
  }
  const np = diag.netprobe;
  const nativeOk = reached(diag.wtNative)
    || (np?.native?.quic || []).some((q) => q.port === np.mainPort && q.result === 'ok');
  if (policy.length && !reached(wt) && nativeOk) {
    // The policy only reaches the browser engine; the native transport takes over.
    return {
      ...out('quic_policy', 'warn', 'QUIC is turned off for the browser engine; voice works around it',
        `A policy on this PC (${policy.join(', ')} = 0) turns QUIC off inside Edge/WebView2, but SpecterComs' own native connection is not affected. Voice and video use it automatically, still end-to-end encrypted, so there's nothing you need to do.`,
        ['Nothing to do. To remove the policy anyway, delete the "QuicAllowed" value under the key named above (on a work or school PC, ask IT).'], true),
      workedAround: true,
    };
  }
  if (policy.length && !reached(wt)) {
    return out('quic_policy', 'error', 'QUIC is turned off by a Windows policy',
      `Voice can't reach the server because QUIC (which voice needs) is disabled by a policy on this PC: ${policy.join(', ')} is set to 0.`,
      ['Ask whoever manages this PC to remove that policy, or delete the "QuicAllowed" value in the Registry Editor under the key named above.',
        'Restart SpecterComs afterwards.',
        'On a work or school PC this is usually set on purpose; use a personal PC or ask IT.']);
  }
  const path = classifyPath(diag);
  if (wt?.result === 'timeout' && reached(wtAlt)) {
    return {
      ...out('quic_443_blocked_alt_ok', 'warn', 'Port 443 is blocked; the alternate port works',
        "Your network blocks UDP port 443 (QUIC) but lets the relay's alternate port through. Voice uses the alternate port on this network, so there's nothing you need to do.",
        ['To fix it for good, allow UDP 443 / QUIC in your router or security software.'], true),
      path: path?.kind || null,
    };
  }
  if (!reached(wt) && reached(diag.wtNative)) {
    const [title, explanation, steps] = PATH_VERDICTS.browser_quic_blocked;
    return { ...out('browser_quic_blocked', 'warn', title, explanation, steps, true), path: path?.kind || null };
  }
  if (path && !reached(wt)) return path;
  if (wt?.result === 'timeout') {
    return out('quic_blocked', 'error', "Voice can't reach the server",
      'Your network or security software blocks UDP port 443 (QUIC), which voice needs. Websites still work because they fall back to TCP; voice cannot.',
      [
        'Try a phone hotspot: if voice works there, the block is on your network/router; if not, it is on this PC.',
        'Antivirus "web shield" / "HTTPS scanning" features (Avast, AVG, Kaspersky, ESET, Bitdefender) often block QUIC. Turn that feature off, or add SpecterComs as an exception.',
        'Turn off any VPN.',
        'Check your router for a "block QUIC" / "block UDP 443" option (some parental-control and gaming routers have one).',
        proxyHint(local),
      ].filter(Boolean));
  }
  if (wt?.result === 'error' || wt?.result === 'rejected' && wt?.ms != null && wt.ms < 20) {
    return out('wt_local_error', 'warn', 'WebTransport failed on this PC',
      `The voice transport failed immediately${wt?.error ? ` (${wt.error})` : ''}, which usually means something on this PC refused it before it reached the network.`,
      ['Restart SpecterComs.', 'Check security software and any Edge/WebView2 policies.', proxyHint(local)].filter(Boolean), false);
  }
  const mlsBad = mls && ((mls.behind?.length || 0) + (mls.missing?.length || 0) > 0 || mls.keyPackage === 'missing');
  if (mlsBad) {
    return out('encryption', 'warn', 'Voice can connect, but encryption needs a resync',
      `${(mls.behind?.length || 0) + (mls.missing?.length || 0)} channel key${(mls.behind?.length || 0) + (mls.missing?.length || 0) === 1 ? '' : 's'} on this PC ${mls.keyPackage === 'missing' ? "and this device's key registration " : ''}are out of date. Repair re-syncs them.`,
      ['Press Repair.'], true);
  }
  return out('ok', 'ok', 'Connection looks healthy',
    'The server, the voice transport and encryption all checked out.', [], true);
}

function proxyHint(local) {
  const p = local?.proxy;
  if (!p?.enabled && !p?.autoConfigUrl) return null;
  return `A system proxy is set (${p.server || p.autoConfigUrl}). Proxies can't carry voice (UDP); if voice fails, try without it.`;
}

// ── Repair runner ───────────────────────────────────────────────────────

/**
 * Runs steps in order: [{ id, label, run: async () => ({ ok, message, skipped? }) }].
 * onProgress(results) after every change; results are
 * { id, label, status: 'pending'|'running'|'ok'|'fail'|'skipped', message }.
 * A throwing step is a 'fail' with its message; later steps still run unless
 * the step returned { stop: true }.
 */
export async function runRepairSteps(steps, onProgress = () => {}) {
  const results = steps.map((s) => ({ id: s.id, label: s.label, status: 'pending', message: '' }));
  const emit = () => onProgress(results.map((r) => ({ ...r })));
  emit();
  for (let i = 0; i < steps.length; i++) {
    results[i].status = 'running';
    emit();
    let r;
    try {
      r = (await steps[i].run()) || { ok: true, message: '' };
    } catch (err) {
      r = { ok: false, message: err?.message || String(err) };
    }
    results[i].status = r.skipped ? 'skipped' : r.ok ? 'ok' : 'fail';
    results[i].message = r.message || '';
    emit();
    if (r.stop) {
      for (let j = i + 1; j < steps.length; j++) { results[j].status = 'skipped'; results[j].message = 'Not run'; }
      emit();
      break;
    }
  }
  return results.map((r) => ({ ...r }));
}

// ── Report ──────────────────────────────────────────────────────────────

function netprobeLines(np) {
  const L = [`  Server-assisted test: ${np.armed ? `armed, ports ${(np.ports || []).join(', ')}` : 'relay has no diagnostic port'}${np.clientIp ? `, public IP ${np.clientIp}` : ''}`];
  const n = np.native;
  if (n) {
    (n.udp || []).forEach((u) => L.push(`    UDP ${u.port}: sent ${(u.sent || []).join('/') || 'none'}, verified replies ${(u.replied || []).join('/') || 'none'}${u.refused ? ', refused' : ''}${u.send_errors?.length ? `, errors ${u.send_errors.join('; ')}` : ''}`));
    if (n.version) L.push(`    UDP ${n.version.port} version check: ${n.version.replied ? 'answered' : 'no answer'}${n.version.refused ? ', refused' : ''}`);
    (n.quic || []).forEach((q) => L.push(`    Native QUIC ${q.port}: ${q.result} after ${q.ms} ms${q.detail ? ` (${q.detail})` : ''}`));
    L.push(`    Don't-fragment bit: ${n.dont_fragment ? 'set' : 'not set'}`);
  }
  if (np.relay) {
    const seen = (np.relay.packets || []).map((p) => `${p.port}:${p.size}`);
    L.push(`    Relay saw: ${[...new Set(seen)].join(', ') || 'no packets'}; WebTransport handshakes ${np.relay.webtransport ?? 0}`);
  }
  return L;
}

const fmtWt = (r) => (!r ? 'not run' : r.result === 'skipped' ? 'not offered'
  : `${r.result}${r.ms != null ? ` after ${r.ms} ms` : ''}${r.error ? ` (${r.error})` : ''}`);

/** The plain-text "Copy report" / submitted-diagnostics text. */
export function formatReport({ diag = {}, verdict = null, steps = [], appVersion = '', at = new Date() } = {}) {
  const v = verdict || classifyDiagnosis(diag);
  const L = [];
  L.push(`SpecterComs connection report ${appVersion ? `(v${appVersion}) ` : ''}${at.toISOString()}`);
  L.push(`Result: ${v.title} [${v.kind}]`);
  L.push(v.explanation);
  if (v.steps?.length) { L.push('What to try:'); v.steps.forEach((s) => L.push(`  - ${s}`)); }
  L.push('');
  L.push('Checks:');
  L.push(`  API (HTTPS): ${diag.api ? (diag.api.ok ? `ok, ${diag.api.ms} ms` : `FAILED ${diag.api.error || ''}`) : 'not run'}`);
  L.push(`  Voice ticket: ${diag.ticket ? (diag.ticket.ok ? `ok (${diag.ticket.mediaUrl}${diag.ticket.altMediaUrl ? `, alt ${diag.ticket.altMediaUrl}` : ''})` : `FAILED ${diag.ticket.error || diag.ticket.status || ''}`) : 'not run'}`);
  L.push(`  QUIC/WebTransport, main port: ${fmtWt(diag.wt)}`);
  L.push(`  QUIC/WebTransport, alternate port: ${fmtWt(diag.wtAlt)}`);
  if (diag.wtNative) L.push(`  Native WebTransport (fallback), main port: ${fmtWt(diag.wtNative)}`);
  if (diag.local) {
    L.push(`  QUIC policy: ${diag.local.quicDisabledBy?.length ? `DISABLED by ${diag.local.quicDisabledBy.join(', ')}` : 'not disabled'}`);
    const p = diag.local.proxy || {};
    L.push(`  System proxy: ${p.enabled ? p.server || 'on' : 'off'}${p.autoConfigUrl ? `, PAC ${p.autoConfigUrl}` : ''}`);
  } else {
    L.push('  QUIC policy / proxy: not available in this build');
  }
  if (diag.mls) {
    L.push(`  Encryption: ${diag.mls.checked} channels checked, ${diag.mls.behind?.length || 0} behind, ${diag.mls.missing?.length || 0} not joined, ${diag.mls.errors || 0} errors; device key ${diag.mls.keyPackage}`);
  }
  if (diag.netprobe) L.push(...netprobeLines(diag.netprobe));
  if (diag.voice) L.push(`  Voice: ${diag.voice.status || 'idle'}${diag.voice.via ? ` via ${diag.voice.via === 'alt' ? 'alternate port' : 'port 443'}` : ''}${diag.voice.transport === 'native' ? ', native transport' : ''}${diag.voice.connectIssue ? `, issue ${diag.voice.connectIssue.kind}` : ''}`);
  if (steps.length) {
    L.push('');
    L.push('Repair:');
    steps.forEach((s) => L.push(`  [${s.status === 'ok' ? 'OK' : s.status === 'fail' ? 'FAIL' : s.status.toUpperCase()}] ${s.label}${s.message ? `: ${s.message}` : ''}`));
  }
  return L.join('\n');
}
