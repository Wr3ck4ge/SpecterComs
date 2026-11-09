// Every WebTransport session the app opens goes through createTransport().
//
// In the desktop app, with nothing remembered for this network, it RACES:
//   t=0       WebView2 on the main URL and on the relay's alternate port
//   t=1.5 s   (nothing ready yet, or every WebView2 attempt already failed)
//             the native client (./nativeWebTransport.js → native_wt.rs)
//             on main + alternate as well
// The first `ready` wins; every loser is closed (a native loser still
// connecting is closed the moment its session exists, so no relay session or
// Tauri resource outlives the race). The winning (mode, port) is remembered
// per network with the alternate-port preference's TTL, and later sessions
// use it directly; if that fails they race again.
//
// One decision per network: concurrent first joins (voice + monitor channels
// + a subscribe) share ONE in-flight race. Only the first pays the wait; the
// others open their own session straight on its result.
//
// Zero user action: some networks block browser QUIC (WebView2's, phones')
// but let the native client's through, and nothing the user could do would
// fix it. Outside Tauri (the web build) this is plain `new WebTransport(url)`.
//
// Dev switches (reproduce a blocked user):
//   localStorage['specter.transport'] = 'native' | 'webview'   (this profile)
//   SPECTER_TRANSPORT=native|webview                           (env, via nwt_info)
// To make WebView2 itself fail the way it does for those users, launch with
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-quic
// (that env var replaces the app's own WebView2 args; dev use only).
import { NativeWebTransport } from './nativeWebTransport.js';

/** When native joins the race if WebView2 isn't ready yet. */
export const NATIVE_JOIN_AFTER_MS = 1_500;
/** A remembered WebView2 choice gets this long before re-racing. */
export const REMEMBERED_WEBVIEW_TIMEOUT_MS = 3_000;
/** Give up on the whole race after this (native has its own 6 s timeout). */
export const RACE_DEADLINE_MS = 10_000;
export const TRANSPORT_PREF_KEY = 'specter_transport_pref';
export const TRANSPORT_FORCE_KEY = 'specter.transport';
export const TRANSPORT_PREF_TTL_MS = 3 * 24 * 60 * 60 * 1000;

let sessionDecision = null; // { mode, slot } won this run (survives storage failures)
let inflight = null;        // Promise<{ mode, slot }> of the race in progress
let infoPromise = null;

const inTauri = () => typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);

/** host:port/path of a URL, never its query (tokens live there). */
export function redactUrl(url) {
  try { const u = new URL(url); return `${u.host}${u.pathname}`; } catch { return '?'; }
}
const portOf = (url) => { try { return Number(new URL(url).port) || 443; } catch { return '?'; } };

/** { mode: 'webview'|'native', slot: 'main'|'alt', until } or null. */
export function readTransportPref(storage, now = Date.now()) {
  try {
    const p = JSON.parse(storage?.getItem(TRANSPORT_PREF_KEY) || 'null');
    if (!p || (p.mode !== 'native' && p.mode !== 'webview') || typeof p.until !== 'number' || now > p.until) return null;
    return { mode: p.mode, slot: p.slot === 'alt' ? 'alt' : 'main', until: p.until };
  } catch { return null; }
}

/** Remember a winner (null clears). */
export function writeTransportPref(storage, decision, now = Date.now()) {
  try {
    if (!decision) { storage?.removeItem(TRANSPORT_PREF_KEY); return null; }
    const p = { mode: decision.mode, slot: decision.slot || 'main', until: now + TRANSPORT_PREF_TTL_MS };
    storage?.setItem(TRANSPORT_PREF_KEY, JSON.stringify(p));
    return p;
  } catch { return null; }
}

/** 'native' | 'webview' | null from the dev switches. */
export function forcedTransportMode(storage, envForced = null) {
  let v = null;
  try { v = storage?.getItem(TRANSPORT_FORCE_KEY) || null; } catch { /* no storage */ }
  if (v !== 'native' && v !== 'webview') v = null;
  return v || (envForced === 'native' || envForced === 'webview' ? envForced : null);
}

export function _resetTransportFactoryForTests() { sessionDecision = null; inflight = null; infoPromise = null; }

async function envForcedMode(invoke) {
  if (!invoke) return null;
  if (!infoPromise) infoPromise = invoke('nwt_info').then((r) => r?.forced || null, () => null);
  return infoPromise;
}

/** Close a transport now, and again if it becomes ready later. */
function abandon(t) {
  if (!t) return;
  try { t.close(); } catch { /* not open */ }
  t.ready?.then?.(() => { try { t.close(); } catch { /* closed */ } }, () => {});
  t.closed?.catch?.(() => {});
}

function settleWithin(t, ms) {
  let timer;
  return Promise.race([
    t.ready.then(() => ({ ok: true }), (err) => ({ ok: false, err })),
    new Promise((res) => { timer = setTimeout(() => res({ ok: false, timedOut: true }), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The race. candidates: [{ slot, url }]. modes: which modes may run.
 * → Promise<{ transport, mode, slot, url }>, rejects when nothing connected.
 */
function race(candidates, { modes, make, nativeAfterMs, deadlineMs, say, label }) {
  return new Promise((resolve, reject) => {
    const attempts = [];
    let done = false;
    let nativeStarted = false;
    let nativeTimer = null;
    let deadline = null;
    const finish = (winner, err) => {
      if (done) return;
      done = true;
      clearTimeout(nativeTimer);
      clearTimeout(deadline);
      for (const a of attempts) if (a !== winner) abandon(a.t);
      if (winner) resolve({ transport: winner.t, mode: winner.mode, slot: winner.slot, url: winner.url });
      else reject(err);
    };
    const settledAll = () => attempts.length > 0 && attempts.every((a) => a.failed);
    const start = (mode, c) => {
      let t;
      try { t = make(mode, c.url); } catch (err) { attempts.push({ mode, ...c, failed: true, err }); return; }
      const a = { mode, ...c, t, failed: false, err: null };
      attempts.push(a);
      t.closed?.catch?.(() => {});
      t.ready.then(() => {
        if (done) { abandon(t); return; }
        finish(a);
      }, (err) => {
        a.failed = true; a.err = err;
        if (done) return;
        say(`${mode} failed port=${portOf(c.url)} label=${label}: ${err?.message || err}`);
        if (mode === 'webview' && !nativeStarted && attempts.filter((x) => x.mode === 'webview').every((x) => x.failed)) startNative();
        else if (settledAll() && (nativeStarted || !modes.includes('native'))) fail();
      });
    };
    const fail = () => {
      const wvPending = attempts.some((a) => a.mode === 'webview' && !a.failed);
      const wvTimedOut = wvPending || attempts.some((a) => a.mode === 'webview' && a.timedOut);
      const last = attempts.filter((a) => a.err).pop()?.err;
      const err = new Error(wvTimedOut || !last
        ? `WebTransport handshake timed out (${attempts.map((a) => `${a.mode}:${portOf(a.url)}`).join(', ')})`
        : `${last?.message || 'WebTransport failed'}`);
      err.webviewTimedOut = wvTimedOut;
      finish(null, err);
    };
    function startNative() {
      if (done) return;
      if (!modes.includes('native')) { if (settledAll()) fail(); return; }
      if (nativeStarted) return;
      nativeStarted = true;
      clearTimeout(nativeTimer);
      for (const c of candidates) start('native', c);
      if (settledAll()) fail();
    }
    if (modes.includes('webview')) {
      for (const c of candidates) start('webview', c);
      if (modes.includes('native')) nativeTimer = setTimeout(startNative, nativeAfterMs);
      if (!modes.includes('native') && settledAll()) fail();
    } else {
      startNative();
    }
    deadline = setTimeout(fail, deadlineMs);
  });
}

/**
 * → { transport, mode: 'webview'|'native', url, slot: 'main'|'alt', fellBack }, transport ready.
 * Throws when nothing connected (the message says "timed out" when no
 * handshake completed, which connectionRepair counts as a timeout).
 * opts: { altUrl, label, log, storage, deps: { WebTransport, NativeWebTransport, invoke, inTauri, now, nativeAfterMs, rememberedTimeoutMs, deadlineMs } }
 */
export async function createTransport(url, opts = {}) {
  const {
    altUrl = null, label = 'wt', log = null, storage = typeof localStorage !== 'undefined' ? localStorage : null,
    deps = {},
  } = opts;
  const WT = deps.WebTransport || globalThis.WebTransport;
  const Native = deps.NativeWebTransport || NativeWebTransport;
  const tauri = deps.inTauri ? deps.inTauri() : inTauri();
  const now = deps.now || Date.now;
  const say = (m) => { const line = `[transport] ${m}`; console.log(line); try { log?.(line); } catch { /* best-effort */ } };

  if (!tauri) {
    const t = new WT(url);
    return { transport: t, mode: 'webview', url, slot: 'main', fellBack: false };
  }

  let invoke = deps.invoke;
  if (!invoke) { try { ({ invoke } = await import('@tauri-apps/api/core')); } catch { invoke = null; } }
  const forced = forcedTransportMode(storage, await envForcedMode(invoke));
  const make = (mode, u) => (mode === 'native' ? new Native(u, deps.nativeDeps ? { deps: deps.nativeDeps } : {}) : new WT(u));
  const candidates = [{ slot: 'main', url }, ...(altUrl ? [{ slot: 'alt', url: altUrl }] : [])];
  const urlFor = (slot) => (slot === 'alt' && altUrl ? altUrl : url);
  const modes = forced ? [forced] : ['webview', 'native'];
  const ok = (r, reason, fellBack) => {
    say(`mode=${r.mode} port=${portOf(r.url)} label=${label} url=${redactUrl(r.url)} reason=${reason}`);
    return { transport: r.transport, mode: r.mode, url: r.url, slot: r.slot, fellBack };
  };

  // Another session is deciding for this network right now: use its answer.
  if (!forced && inflight) {
    try { await inflight; } catch { /* it failed: decide again below */ }
  }

  const remembered = sessionDecision || readTransportPref(storage, now());
  if (remembered && (!forced || forced === remembered.mode)) {
    const u = urlFor(remembered.slot);
    const t = make(remembered.mode, u);
    t.closed?.catch?.(() => {});
    const r = remembered.mode === 'webview'
      ? await settleWithin(t, deps.rememberedTimeoutMs ?? REMEMBERED_WEBVIEW_TIMEOUT_MS)
      : await t.ready.then(() => ({ ok: true }), (err) => ({ ok: false, err }));
    if (r.ok) return ok({ transport: t, mode: remembered.mode, slot: remembered.slot, url: u }, 'remembered', false);
    abandon(t);
    say(`remembered mode=${remembered.mode} port=${portOf(u)} label=${label} failed; racing again`);
    sessionDecision = null;
    writeTransportPref(storage, null);
  }

  const p = race(candidates, {
    modes, make, say, label,
    nativeAfterMs: deps.nativeAfterMs ?? NATIVE_JOIN_AFTER_MS,
    deadlineMs: deps.deadlineMs ?? RACE_DEADLINE_MS,
  });
  const decision = p.then((r) => ({ mode: r.mode, slot: r.slot }));
  decision.catch(() => {});
  if (!forced) {
    inflight = decision;
    decision.finally(() => { if (inflight === decision) inflight = null; }).catch(() => {});
  }
  const r = await p;
  if (!forced) {
    sessionDecision = { mode: r.mode, slot: r.slot };
    writeTransportPref(storage, sessionDecision, now());
  }
  return ok(r, forced ? 'forced' : 'race', r.mode === 'native' || r.slot === 'alt');
}
