import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import * as session from '../../auth/session.js';
import useTwoFactorLogin from '../../auth/useTwoFactorLogin.js'; // L3
import { api } from '../../api.js';
import StripView from './StripView';
import ChannelsCabinet, { UnreadPill, VoiceChannelPanel } from './ChannelsCabinet';
import useEngine from './useEngine';
import { CMD, RESYNC_COMMAND_TIMEOUT_MS, SLOW_COMMAND_TIMEOUT_MS, memberCommand, totalUnread } from '../../engine/bridge.js';
// P2A: full-work-area window, fluid channels pane, chat, voice bar buttons.
import { MAIN_WIDTH, StripFrame } from './StripSidePanel';
import StripChat from './StripChat';
import { OverlayTab, SharePicker } from './StripVoiceControls';
import { voiceSlots } from './voiceSlots'; // BAR2 (was VoiceBarButtons)
import useFluidExpand, { fluidSlotStyle } from './useFluidExpand';
import { useViewportHeight } from './stripOpsLayout';
// S10: operations data + the op panel above the ops/notifications cabinets.
import useStripOps from './useStripOps';
import OpPanel from './OpPanel';
import useOpPanelTarget from './useOpPanelTarget';
// P2C: Settings (engine-held settings via src/engine/settingsBridge.js) and
// Games (supported games → tools, wide tool panel). Heavy parts are lazy.
import { Suspense, lazy } from 'react';
import { setUser as setSessionUser } from '../../auth/tokenStore.js';
import useSettings from './useSettings';
import GamesCabinet from './GamesCabinet';
import FriendsCabinet from './FriendsCabinet';
// SV: the stream viewer (watch a sharer without the overlay).
import StripStreamViewer from './StripStreamViewer';
import { StreamsPanel, streamWatchSlots } from './streamSlots';
import { warmStreamListener } from './useStripStream';
// The server welcome panel (cabinet 'welcome'; see welcome/WelcomeCabinet.jsx).
import WelcomeCabinet from './welcome/WelcomeCabinet';
import { markWelcomeSeen, shouldAutoShowWelcome } from './welcome/welcomeModel';

const SettingsCabinet = lazy(() => import('./SettingsCabinet'));
import { repairSlot, encryptionSyncSlot, bugReplySlot } from './repairSlot'; // NET, S3
import useBugReportReplies from './useBugReportReplies';
// LIVE: the live-op notice beside the bar (from the engine's liveOps).
import LiveOpNotice from './LiveOpNotice';
import StatusBanner from './StatusBanner'; // L7
import useLiveNotices from './useLiveNotices';
import { ScVoiceActive } from '../icons/brand'; // BRAND

// The tray strip's container: session, servers, update state, the window
// region, and the Tauri events that tie the strip to Rust (strip.rs) and to
// the main window (the hidden engine).
//
// Events (all app-wide Tauri events):
//   strip-shown StripLayout     Rust → strip: docked and shown; the layout
//                               contract (edge, grow, expand, barRect,
//                               freeRect, workArea, scale — see strip.rs)
//   strip-hidden                Rust → strip: hidden (focus loss, tray click)
//   strip-collapsed             SV, Rust → strip: lost focus while pinned
//                               (stream viewer open): show only the viewer
//   strip-peeked StripLayout    LIVE, Rust → strip: shown collapsed and
//                               unfocused for a new live-op notice (strip_peek)
//   active-server-changed { orgId, source: 'strip' | 'main' }
//                               both ways between the strip and WarRoom
//   update-ready, auth-changed  existing (updater.rs, session.rs)
//   engine-*                    the strip↔engine bridge (src/engine/bridge.js,
//                               strip side in ./useEngine.js)
//
// The main window is not UI any more — only the hidden engine. Nothing here
// can show it (dev builds: tray menu "Show engine (dev)", see lib.rs).
//
// localStorage here is the strip's own (it runs in a separate WebView2
// profile, see strip.rs), not the main window's:
//   specter_strip_active_org   last server picked in the strip
//   specter_strip_hint_seen    the one-time "SpecterComs now lives here" hint
//   specter_strip_welcome_seen per user, per server: the welcome_updated_at
//                              last shown (welcome/welcomeModel.js)

const ACTIVE_ORG_KEY = 'specter_strip_active_org';
const HINT_SEEN_KEY = 'specter_strip_hint_seen';
const SIGNUP_URL = 'https://spectercoms.net/';
const ORGS_STALE_MS = 60_000; // strip-shown refetches /orgs/me (welcome_updated_at) when older
const REGION_PAD = 6; // px of shadow kept around each panel; matches the root's p-1.5
// P2A: extra width of the Channels cabinet when its pane is open, and the
// cabinet's minimum height then (clamped to the free side / work area).
const VOICE_PANE_W = 320;
const CHAT_PANE_W = 440;
const GAME_TOOL_W = 1000; // GAMEFIT: the hangar's full width, bar column included, when the screen has room
const VOICE_PANE_MIN_H = 360;
const CHAT_PANE_MIN_H = 560;

const inTauri = () => Boolean(window.__TAURI_INTERNALS__);

function readLocal(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, value); } catch { /* not fatal */ }
}

async function listenTauri(event, cb) {
  const { listen } = await import('@tauri-apps/api/event');
  return listen(event, cb);
}

// Subscribe to a Tauri event for the component's lifetime.
function useTauriEvent(event, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!inTauri()) return undefined;
    let unlisten = null;
    let stopped = false;
    listenTauri(event, (e) => ref.current(e.payload))
      .then((fn) => { if (stopped) fn(); else unlisten = fn; })
      .catch((err) => console.warn(`${event} listener failed:`, err));
    return () => { stopped = true; if (unlisten) unlisten(); };
  }, [event]);
}

// Clip the window to the panels (see strip.rs). Sent only when it changes.
let lastRegion = '';
function reportRegion() {
  if (!inTauri()) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // POLISH: panels kept mounted but put away (data-region-off: the strip is
  // collapsed to the stream viewer) and empty boxes aren't part of the region.
  const rects = [...document.querySelectorAll('[data-strip-region]')].filter((el) => !el.closest('[data-region-off]')).map((el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { w: 0, h: 0 };
    const x = Math.max(0, r.left - REGION_PAD);
    const y = Math.max(0, r.top - REGION_PAD);
    return {
      x, y,
      w: Math.min(vw, r.right + REGION_PAD) - x,
      h: Math.min(vh, r.bottom + REGION_PAD) - y,
    };
  }).filter((r) => r.w > 0 && r.h > 0);
  if (!rects.length) return;
  const key = JSON.stringify(rects.map((r) => [r.x, r.y, r.w, r.h].map(Math.round)));
  if (key === lastRegion) return;
  lastRegion = key;
  invoke('strip_set_region', { rects }).catch((err) => console.warn('strip_set_region failed:', err));
}

export default function StripApp() {
  const [auth, setAuth] = useState('loading');
  const [grow, setGrow] = useState('up');
  // Which side panels open on (strip.rs picks the side with room; normally
  // left, since the strip sits by the tray).
  const [expand, setExpand] = useState('left');
  // P2A: the whole layout contract from strip.rs (null until it arrives).
  const [layout, setLayout] = useState(null);
  const [cabinet, setCabinet] = useState(null);
  // Channel row whose side panel is open beside the Channels cabinet:
  // null | { kind: 'voice' | 'text', id } (see ChannelsCabinet).
  const [focus, setFocus] = useState(null);
  // P2A: the screen-share picker: null | { loading, error, sources, starting, startError }
  const [picker, setPicker] = useState(null);
  const [instantClose, setInstantClose] = useState(false);

  const [loggedOutView, setLoggedOutView] = useState('login');
  const [form, setForm] = useState({ email: '', password: '' });
  const [loginState, setLoginState] = useState({ loading: false, error: null, notice: null });
  const tfa = useTwoFactorLogin(); // L3: login's code step
  const [forgotState, setForgotState] = useState({ loading: false, error: null, success: null });

  const [orgs, setOrgs] = useState([]);
  const [friendRequests, setFriendRequests] = useState(0); // incoming friend requests (bar badge)
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [orgsError, setOrgsError] = useState(null);
  const [activeOrgId, setActiveOrgId] = useState(() => readLocal(ACTIVE_ORG_KEY));

  const [update, setUpdate] = useState(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateError, setUpdateError] = useState(null);

  const [showHint, setShowHint] = useState(() => readLocal(HINT_SEEN_KEY) !== '1');
  const hintShownRef = useRef(false);

  // The strip↔engine bridge. Audio levels are only streamed while the
  // Channels cabinet is open — BAR2: or while the strip is showing and we're
  // in voice (the bar's speaker chip). barLevels is set further down, once
  // the engine state says whether we're in voice.
  const [stripVisible, setStripVisible] = useState(true); // BAR2
  const [barLevels, setBarLevels] = useState(false); // BAR2
  const [collapsed, setCollapsed] = useState(false); // SV: strip-collapsed (pinned, unfocused)
  // POLISH: hiding (or collapsing to the stream viewer) no longer closes the
  // cabinet / op panel / pane — the strip comes back exactly as it was — so
  // everything that costs something while on screen keys off this instead.
  const uiShown = stripVisible && !collapsed;
  const engine = useEngine({ enabled: auth === 'in', wantLevels: auth === 'in' && uiShown && (cabinet === 'channels' || barLevels) });

  // ── LIVE: live-op notice ───────────────────────────────────────────────
  // A new launch on any of my servers opens the notice beside the bar; with
  // the strip hidden it peeks the strip (shown collapsed, unfocused: only the
  // notice is in the region) unless Windows is in Do-not-disturb / a
  // full-screen game (strip.rs strip_peek). The notice does not pin the strip:
  // hiding the bar (focus loss, tray icon) hides the notice too.
  const stripVisibleRef = useRef(stripVisible);
  stripVisibleRef.current = stripVisible;
  const [peekSeq, setPeekSeq] = useState(0);
  const requestPeek = useCallback(() => {
    if (!inTauri() || stripVisibleRef.current) return;
    invoke('strip_peek', { checkOnly: true }).then((ok) => {
      if (!ok || stripVisibleRef.current) return;
      // Collapse first, so the region sent before the window shows is the
      // notice alone; the peek itself runs after that render (below).
      setCollapsed(true);
      setStripVisible(true);
      setPeekSeq((n) => n + 1);
    }).catch((err) => console.warn('strip_peek check failed:', err));
  }, []);
  useEffect(() => {
    if (!peekSeq || !inTauri()) return;
    lastRegion = '';
    reportRegion();
    invoke('strip_peek', {}).then((ok) => {
      if (!ok) { setStripVisible(false); setCollapsed(false); }
    }).catch((err) => console.warn('strip_peek failed:', err));
  }, [peekSeq]);
  // Open game tool: { game, tool: 'hangar' | 'editor', shipId } | null (P2C;
  // declared here because the notice yields to an open game tool).
  const [gameTool, setGameTool] = useState(null);
  const gameToolOpen = auth === 'in' && cabinet === 'games' && Boolean(gameTool);
  const liveNotices = useLiveNotices({
    liveOps: auth === 'in' ? engine.state.liveOps || [] : [],
    known: auth === 'in' && engine.connected,
    onScreen: auth === 'in' && stripVisible && !gameToolOpen,
    onAnnounce: requestPeek,
  });

  // ── P2C: Settings + Games ──────────────────────────────────────────────
  // p2cBusy holds the strip open while a native file dialog (avatar / intro
  // sound upload) has focus.
  const [p2cBusy, setP2cBusy] = useState(false);
  const settings = useSettings({ enabled: auth === 'in' && cabinet === 'settings' });
  const [stripUser, setStripUser] = useState(null);
  const [appVersion, setAppVersion] = useState('');
  const [pttLive, setPttLive] = useState(false);
  useEffect(() => {
    if (auth !== 'in') { setStripUser(null); return undefined; }
    let stale = false;
    Promise.resolve(session.currentUser()).then((u) => { if (!stale) setStripUser(u || null); }).catch(() => {});
    const stop = session.onAuthChanged(({ user }) => setStripUser(user || null));
    return () => { stale = true; stop(); };
  }, [auth]);
  useEffect(() => {
    if (!inTauri()) return;
    import('@tauri-apps/api/app').then(({ getVersion }) => getVersion()).then(setAppVersion).catch(() => {});
  }, []);
  useTauriEvent('specter://ptt-active', (p) => setPttLive(Boolean(p?.active)));
  useEffect(() => { if (cabinet !== 'games') setGameTool(null); }, [cabinet]);

  // ── Session ────────────────────────────────────────────────────────────
  useEffect(() => {
    let stale = false;
    session.restoreQuiet().then((user) => {
      if (!stale) setAuth((prev) => (prev === 'loading' ? (user ? 'in' : 'out') : prev));
    });
    const stop = session.onAuthChanged(({ user }) => {
      setAuth(user ? 'in' : 'out');
      if (!user) { setCabinet(null); setOrgs([]); }
    });
    return () => { stale = true; stop(); };
  }, []);

  // The page is up: on launch that's when Rust first shows the strip.
  useEffect(() => {
    if (!inTauri()) return;
    invoke('strip_layout').then((l) => {
      if (l?.grow) setGrow(l.grow);
      if (l?.expand) setExpand(l.expand);
      if (l?.barRect) setLayout(l);
    }).catch(() => {});
    invoke('strip_ready').catch((err) => console.warn('strip_ready failed:', err));
  }, []);

  // ── Operations (S10) ───────────────────────────────────────────────────
  const activeOrg = orgs.find((o) => o.id === activeOrgId) || null;
  // welcome_updated (SSE, via useStripOps' stream): note the server's new
  // welcome_updated_at — an open welcome pane refetches on it, and the pane
  // auto-shows again the next time the strip is opened onto that server.
  const onWelcomeUpdated = useCallback(({ org_id: orgId, updated_at: updatedAt }) => {
    setOrgs((list) => list.map((o) => (o.id === orgId ? { ...o, welcome_updated_at: updatedAt } : o)));
  }, []);
  const ops = useStripOps({ signedIn: auth === 'in', org: activeOrg, onWelcomeUpdated });
  const opTarget = useOpPanelTarget({ cabinet, activeOrgId });
  const opPanel = {
    ...opTarget,
    // P2B: StripView passes layoutFor(kind) — the wide panel's placement.
    render: (layoutFor) => (
      <OpPanel target={opTarget.target} setTarget={opTarget.setTarget} close={opTarget.close}
        ops={ops} orgs={orgs} activeOrgId={activeOrgId} layoutFor={layoutFor} visible={uiShown /* POLISH */} />
    ),
  };

  // Don't hide on focus loss while a form is mid-submit (or while a native
  // date/time picker popup is open — S10's planner).
  const busy = loginState.loading || forgotState.loading || ops.pickerBusy || p2cBusy; // P2C: p2cBusy
  useEffect(() => {
    if (inTauri()) invoke('strip_set_busy', { busy }).catch(() => {});
  }, [busy]);

  // ── Servers ────────────────────────────────────────────────────────────
  const orgsLoadedAtRef = useRef(0);
  const loadOrgs = useCallback(() => {
    setOrgsLoading(true);
    orgsLoadedAtRef.current = Date.now();
    return api.getMyOrgs().then(({ data, error }) => {
      setOrgsLoading(false);
      if (error) {
        console.warn('getMyOrgs failed:', error);
        setOrgsError(typeof error === 'string' ? error : 'Could not load servers');
        return;
      }
      const list = data?.orgs || [];
      setOrgs(list);
      setOrgsError(null);
      setActiveOrgId((cur) => (cur && list.some((o) => o.id === cur) ? cur : list[0]?.id ?? null));
    }).catch((err) => {
      console.error('getMyOrgs threw:', err);
      setOrgsLoading(false);
      setOrgsError('Could not load servers');
    });
  }, []);

  useEffect(() => { if (auth === 'in') loadOrgs(); }, [auth, loadOrgs]);

  useTauriEvent('active-server-changed', (p) => {
    if (!p?.orgId || p.source === 'strip') return;
    setActiveOrgId(p.orgId);
    writeLocal(ACTIVE_ORG_KEY, p.orgId);
  });

  const selectOrg = useCallback((org) => {
    setActiveOrgId(org.id);
    writeLocal(ACTIVE_ORG_KEY, org.id);
    setCabinet(null);
    requestWelcomeCheckRef.current(); // entering a server: its welcome, if unseen
    if (inTauri()) {
      import('@tauri-apps/api/event')
        .then(({ emit }) => emit('active-server-changed', { orgId: org.id, source: 'strip' }))
        .catch((err) => console.warn('active-server-changed emit failed:', err));
    }
  }, []);

  // ── Updates ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!inTauri()) return;
    invoke('updater_pending').then((p) => { if (p) setUpdate(p); }).catch(() => {});
  }, []);
  useTauriEvent('update-ready', (p) => { setUpdate(p); setUpdateError(null); });

  const installUpdate = () => {
    setUpdateInstalling(true);
    setUpdateError(null);
    invoke('install_update_and_restart').catch((err) => {
      setUpdateInstalling(false);
      setUpdateError(err?.message || String(err));
    });
  };

  // ── Window ─────────────────────────────────────────────────────────────
  useTauriEvent('strip-shown', (p) => {
    // Opened onto a server with nothing else up: its welcome, if unseen
    // (after a refetch of /orgs/me if that's stale, for welcome_updated_at
    // changes made while the strip was hidden and had no event stream).
    if (auth === 'in' && !cabinet) {
      if (Date.now() - orgsLoadedAtRef.current > ORGS_STALE_MS) {
        loadOrgs().finally(() => requestWelcomeCheckRef.current());
      } else requestWelcomeCheckRef.current();
    }
    if (p?.grow) setGrow(p.grow);
    if (p?.expand) setExpand(p.expand);
    if (p?.barRect) setLayout(p);
    lastRegion = '';
    reportRegion();
    engine.resync();
    setStripVisible(true); // BAR2
    setCollapsed(false); // SV
    // POLISH: reopen the viewer the strip was watching when it hid, if that
    // stream is still up.
    const resume = resumeViewerRef.current;
    resumeViewerRef.current = null;
    const v = engine.state.voice;
    if (resume && !viewerRef.current && v.channelId && v.sharers.includes(resume.callsign)) {
      openViewerRef.current(resume.callsign);
      if (resume.expanded) setViewerExpanded(true);
    }
  });
  // POLISH: hiding keeps the open cabinet, its sub-view, the pane, the op
  // panel and the share picker as they are (everything stays mounted in the
  // hidden window); only work that costs something while nobody's looking
  // stops: levels / chat-read (uiShown), the mic test, the stream itself.
  const stopWhileAway = () => {
    if (settings.mic.on) settings.setMicTest(false);
  };
  useTauriEvent('strip-hidden', () => {
    welcomeCheckRef.current = false;
    setCollapsed(false); // SV
    if (viewerRef.current) {
      // SV: nothing to watch it in — stop the stream, but remember it (POLISH).
      resumeViewerRef.current = { callsign: viewerRef.current.callsign, expanded: viewerExpandedRef.current };
      closeViewerRef.current();
    }
    setStripVisible(false); // BAR2: stop the bar's levels stream while hidden
    stopWhileAway();
    // The hint has been seen once the strip has been up with it.
    if (hintShownRef.current) { writeLocal(HINT_SEEN_KEY, '1'); setShowHint(false); }
  });
  // SV: lost focus while pinned — fold everything but the viewer away
  // (POLISH: kept mounted and put back on strip-shown, see StripView).
  useTauriEvent('strip-collapsed', () => {
    setCollapsed(true);
    stopWhileAway();
  });
  // LIVE: shown collapsed for a live-op notice (strip_peek). Usually already
  // set up by requestPeek; this also carries a new layout.
  useTauriEvent('strip-peeked', (p) => {
    if (p?.grow) setGrow(p.grow);
    if (p?.expand) setExpand(p.expand);
    if (p?.barRect) setLayout(p);
    setStripVisible(true);
    setCollapsed(true);
    lastRegion = '';
    reportRegion();
  });

  useLayoutEffect(() => { reportRegion(); });
  useEffect(() => {
    window.addEventListener('resize', reportRegion);
    return () => window.removeEventListener('resize', reportRegion);
  }, []);
  useEffect(() => { if (showHint) hintShownRef.current = true; }, [showHint]);

  const dismissHint = () => { writeLocal(HINT_SEEN_KEY, '1'); setShowHint(false); };

  const toggleCabinet = (id) => {
    setInstantClose(false);
    if (showHint) dismissHint();
    setCabinet((cur) => (cur === id ? null : id));
    setFocus(null);
    setPicker(null);
    if (id === 'server') loadOrgs();
  };
  const closeCabinet = () => { setInstantClose(false); setCabinet(null); setFocus(null); };

  // ── Engine (the hidden main window) ─────────────────────────────────────
  const engineSend = engine.send;
  const engineCommand = useCallback((type, args) => {
    if (type === CMD.STREAM_WATCH) { openViewerRef.current(args.callsign); return; } // SV: opens the viewer too
    engineSend(type, args).catch((err) => console.warn(`[bridge] ${type} failed: ${err.message}`));
  }, [engineSend]);
  const engineOrgId = engine.state.org?.id;
  const createChannel = useCallback(async ({ name, kind, minLevel = 0 }) => {
    if (!engineOrgId) return { error: 'No server selected' };
    const { error } = await api.createChannel(engineOrgId, { name, kind: kind === 'text' ? 1 : 0, visible_min_level: minLevel });
    if (!error) engineCommand(CMD.CHANNELS_REFRESH, {});
    return { error };
  }, [engineOrgId, engineCommand]);
  // Who can see a channel (admin authority: can_manage_channels).
  const updateChannel = useCallback(async (ch, body) => {
    if (!engineOrgId) return { error: 'No server selected' };
    const { error } = await api.updateChannel(engineOrgId, ch.id, body);
    if (!error) engineCommand(CMD.CHANNELS_REFRESH, {});
    return { error };
  }, [engineOrgId, engineCommand]);
  // L11: adult channels. Available = the server says this requester's region
  // allows them (nothing is shown otherwise); attest = my one-time 18+ confirm.
  const loadAdultAvailable = useCallback(async () => {
    if (!engineOrgId) return false;
    const { data } = await api.getChannels(engineOrgId);
    return data?.adult_available === true;
  }, [engineOrgId]);
  const attestAdult = useCallback(async () => {
    if (!engineOrgId) return { error: 'No server selected' };
    const { error } = await api.attestAdult(engineOrgId);
    if (!error) engineCommand(CMD.CHANNELS_REFRESH, {});
    return { error };
  }, [engineOrgId, engineCommand]);
  const loadRanks = useCallback(async () => {
    if (!engineOrgId) return [];
    const { data } = await api.getRoles(engineOrgId);
    return Array.isArray(data) ? data : [];
  }, [engineOrgId]);
  const deleteChannel = useCallback(async (ch) => {
    if (!engineOrgId) return { error: 'No server selected' };
    const { error } = await api.deleteChannel(engineOrgId, ch.id);
    if (!error) engineCommand(CMD.CHANNELS_REFRESH, {});
    return { error };
  }, [engineOrgId, engineCommand]);

  // ── P2A: fluid Channels pane (members / chat) ──────────────────────────
  // The pane closes if its channel disappears (deleted, server switch).
  // PM: a DM pane (focus kind 'dm') isn't a channel; it stands for itself.
  const focusChannel = !focus ? null
    : focus.kind === 'dm' ? { id: focus.id, name: focus.name || 'Direct message', kind: 'dm' }
    : engine.state.channels.find((c) => c.id === focus.id && c.kind === focus.kind) || null;
  useEffect(() => { if (focus && engine.connected && !focusChannel) setFocus(null); }, [focus, focusChannel, engine.connected]);
  const vh = useViewportHeight();
  const freeW = layout?.freeRect?.w ?? Infinity;
  const isChatPane = (ch) => ch?.kind === 'text' || ch?.kind === 'dm'; // PM
  const paneTarget = auth === 'in' && cabinet === 'channels' && focusChannel
    ? Math.max(0, Math.min(isChatPane(focusChannel) ? CHAT_PANE_W : VOICE_PANE_W, freeW))
    : 0;
  // GAMEFIT (owner 2026-11-13): an open game tool replaces the game list in
  // the Games cabinet and widens it the same way, never past the free side.
  const barW = layout?.barRect?.w || MAIN_WIDTH;
  const gameToolTarget = gameToolOpen ? Math.max(0, Math.min(GAME_TOOL_W - barW, freeW)) : 0;
  const fluid = useFluidExpand(paneTarget || gameToolTarget, reportRegion);
  // While the pane slides shut its channel has already been unfocused; keep
  // showing it until the slide finishes.
  const lastPaneRef = useRef(null);
  if (focusChannel && paneTarget) lastPaneRef.current = focusChannel;
  const paneChannel = focusChannel && paneTarget ? focusChannel : fluid.laid > 0 ? lastPaneRef.current : null;

  // Chat subscription: the engine streams the open text channel (engine-chat)
  // and keeps it read while it's open; null when the chat closes / strip hides.
  // POLISH: + uiShown — the chat stays open while hidden but isn't "read" then.
  const chatChannelId = auth === 'in' && uiShown && cabinet === 'channels' && focusChannel?.kind === 'text' ? focusChannel.id : null;
  useEffect(() => {
    if (auth !== 'in' || !engine.connected) return undefined;
    engineSend(CMD.TEXT_SELECT, { channelId: chatChannelId }).catch((err) => console.warn(`[bridge] text.select failed: ${err.message}`));
    return undefined;
  }, [auth, engine.connected, engine.epoch, chatChannelId, engineSend]);
  const sendChat = useCallback((channelId, text) => engineSend(CMD.CHAT_SEND, { channelId, text }, {
    timeoutMs: SLOW_COMMAND_TIMEOUT_MS,
    timeoutMessage: "SpecterComs didn't confirm the send. It may not have gone out; check before resending.",
  }), [engineSend]);
  // PM: the DM pane's subscription (engine-dm) and send — same rules as the
  // text chat above; the engine encrypts (MLS) and decrypts.
  // The Friends cabinet has the DM built in (owner 2026-11-08): Message opens
  // the conversation right there instead of jumping to the Channels cabinet.
  const [friendDm, setFriendDm] = useState(null); // { userId, callsign } | null
  useEffect(() => { if (auth !== 'in') setFriendDm(null); }, [auth]);
  const dmUserId = auth !== 'in' || !uiShown ? null
    : cabinet === 'channels' && focusChannel?.kind === 'dm' ? focusChannel.id
      : cabinet === 'friends' && friendDm ? friendDm.userId : null;
  useEffect(() => {
    if (auth !== 'in' || !engine.connected) return undefined;
    engineSend(...memberCommand.dmSelect(dmUserId)).catch((err) => console.warn(`[bridge] dm.select failed: ${err.message}`));
    return undefined;
  }, [auth, engine.connected, engine.epoch, dmUserId, engineSend]);
  const sendDmText = useCallback((userId, text) => engineSend(...memberCommand.dmSend(userId, text), {
    timeoutMs: SLOW_COMMAND_TIMEOUT_MS,
    timeoutMessage: "SpecterComs didn't confirm the send. It may not have gone out; check before resending.",
  }), [engineSend]);
  const openDm = useCallback(({ userId, callsign }) => setFocus({ kind: 'dm', id: userId, name: callsign }), []);

  // MR2: Settings → About & diagnostics "Resync encryption" (server.resyncEncryption).
  // { orgId, busy, ok, message } — kept here so the result outlives the cabinet.
  const [resync, setResync] = useState(null);
  const resyncEncryption = useCallback((orgId) => {
    if (!orgId) return;
    setResync({ orgId, busy: true, ok: true, message: null });
    engineSend(CMD.SERVER_RESYNC_ENCRYPTION, { orgId }, {
      timeoutMs: RESYNC_COMMAND_TIMEOUT_MS,
      timeoutMessage: 'Re-syncing is taking a while; it continues in the background.',
    }).then(
      (r) => setResync({ orgId, busy: false, ok: r?.ok !== false, message: r?.message || 'Encryption re-synced' }),
      (err) => setResync({ orgId, busy: false, ok: false, message: err?.message || 'Re-sync failed' }),
    );
  }, [engineSend]);

  let pane = null;
  if (paneChannel?.kind === 'dm') {
    pane = (
      <StripChat
        key={`dm:${paneChannel.id}`}
        kind="dm"
        channel={paneChannel}
        chat={engine.dm?.userId === paneChannel.id ? engine.dm : null}
        onSend={(text) => sendDmText(paneChannel.id, text)}
        onClose={() => setFocus(null)}
      />
    );
  } else if (paneChannel) {
    pane = paneChannel.kind === 'text' ? (
      <StripChat
        key={paneChannel.id}
        channel={paneChannel}
        chat={engine.chat?.channelId === paneChannel.id ? engine.chat : null}
        onSend={(text) => sendChat(paneChannel.id, text)}
        onClose={() => setFocus(null)}
      />
    ) : (
      <VoiceChannelPanel
        engine={engine}
        channel={paneChannel}
        onCommand={engineCommand}
        clearError={engine.clearError}
        onClose={() => setFocus(null)}
        onOpenDm={openDm /* PM */}
      />
    );
  }
  const channelsMaxHeight = Math.max(240, Math.min(680, vh - 110));
  // CH2: the voice channel the user backed out of to the channel list (null =
  // its joined view shows). Held here so it survives the strip hiding;
  // cleared on leave so the next join opens the joined view again.
  const [channelsBrowseFor, setChannelsBrowseFor] = useState(null);
  const voiceChannelId = engine.state.voice.channelId;
  useEffect(() => { if (!voiceChannelId) setChannelsBrowseFor(null); }, [voiceChannelId]);

  // ── Server welcome panel ───────────────────────────────────────────────
  // Auto-opens once per (user, server, welcome_updated_at) when the strip is
  // opened onto a server or a server is picked — never over the game
  // overlay, during the user's own share, with the stream viewer / share
  // picker up, or over another cabinet (welcomeModel.js). A check requested
  // before the org list / user is known waits for them.
  const welcomeCheckRef = useRef(false);
  const [welcomeTick, setWelcomeTick] = useState(0);
  const requestWelcomeCheckRef = useRef(() => {});
  requestWelcomeCheckRef.current = () => { welcomeCheckRef.current = true; setWelcomeTick((t) => t + 1); };
  const userId = stripUser?.id || null;
  // Incoming friend requests for the bar badge: known without opening the
  // Friends cabinet (which keeps the count current while it is open).
  useEffect(() => {
    if (auth !== 'in' || !userId || !uiShown) return undefined;
    let stale = false;
    api.getFriends().then(({ data }) => {
      if (stale || !data?.friends) return;
      setFriendRequests(data.friends.filter((f) => Number(f.status) === 0 && f.initiated_by !== userId).length);
    }).catch(() => {});
    return () => { stale = true; };
  }, [auth, userId, uiShown]);
  // Logging in / a restored session counts as opening the strip onto the
  // server (the launch strip-shown can arrive before auth settles).
  useEffect(() => { if (auth === 'in') requestWelcomeCheckRef.current(); }, [auth]);
  useEffect(() => {
    if (!welcomeCheckRef.current || auth !== 'in' || !uiShown) return;
    if (!activeOrg || !userId) return; // still loading: keep the request
    welcomeCheckRef.current = false;
    const show = shouldAutoShowWelcome({
      org: activeOrg,
      userId,
      blockers: {
        overlayOpen: engine.state.overlay.open,
        sharing: engine.state.voice.sharing,
        viewerOpen: Boolean(viewer),
        pickerOpen: Boolean(picker),
        cabinetOpen: Boolean(cabinet),
      },
    });
    if (show) { setInstantClose(false); setCabinet('welcome'); }
  });
  // Shown = seen at that updated_at (auto-opened or opened by hand).
  const welcomeOrgId = activeOrg?.id;
  const welcomeAt = activeOrg?.welcome_updated_at || null;
  useEffect(() => {
    if (cabinet === 'welcome' && uiShown && userId && welcomeOrgId && welcomeAt) markWelcomeSeen(userId, welcomeOrgId, welcomeAt);
  }, [cabinet, uiShown, userId, welcomeOrgId, welcomeAt]);
  const onWelcomeSaved = useCallback((updatedAt) => {
    if (!updatedAt || !welcomeOrgId) return;
    setOrgs((list) => list.map((o) => (o.id === welcomeOrgId ? { ...o, welcome_updated_at: updatedAt } : o)));
  }, [welcomeOrgId]);

  const renderCabinet = (id, { onClose }) => (id === 'channels' ? (
    <ChannelsCabinet
      engine={engine}
      onCommand={engineCommand}
      clearError={engine.clearError}
      focus={focus}
      onFocus={setFocus}
      onCreateChannel={createChannel}
      onDeleteChannel={deleteChannel}
      onUpdateChannel={updateChannel}
      onLoadRanks={loadRanks}
      onLoadAdultAvailable={loadAdultAvailable}
      onAttestAdult={attestAdult}
      onClose={onClose}
      pane={pane}
      paneWidth={fluid.laid}
      expand={expand}
      maxHeight={channelsMaxHeight}
      paneMinHeight={isChatPane(paneChannel) ? CHAT_PANE_MIN_H : VOICE_PANE_MIN_H}
      browseFor={channelsBrowseFor /* CH2 */}
      onBrowseFor={setChannelsBrowseFor}
    />
  ) : null);

  // ── P2A: voice controls on the bar + screen-share picker ───────────────
  const inVoice = auth === 'in' && Boolean(engine.state.voice.channelId);
  // C2: the Streams panel (bar chip → who's sharing → where to watch).
  const [streamsOpen, setStreamsOpen] = useState(false);
  const closeStreams = useCallback(() => setStreamsOpen(false), []);
  useEffect(() => { if (!inVoice) { setPicker(null); setStreamsOpen(false); } }, [inVoice]);
  useEffect(() => { setBarLevels(inVoice && stripVisible); }, [inVoice, stripVisible]); // BAR2
  const loadSources = useCallback(() => {
    setPicker((p) => ({ sources: [], ...p, loading: true, error: null }));
    engineSend(CMD.SHARE_LIST_SOURCES, {}, { timeoutMs: SLOW_COMMAND_TIMEOUT_MS }).then(
      (r) => setPicker((p) => p && { ...p, loading: false, sources: r?.sources || [] }),
      (err) => setPicker((p) => p && { ...p, loading: false, error: err.message }),
    );
  }, [engineSend]);
  const onShareClick = () => {
    if (engine.state.voice.sharing) { engineCommand(CMD.SHARE_STOP, {}); return; }
    if (picker) { setPicker(null); return; }
    setCabinet(null);
    setFocus(null);
    setStreamsOpen(false); // C2: one stacked panel at a time
    setPicker({ loading: true, error: null, sources: [] });
    loadSources();
  };
  const startShare = (source) => {
    setPicker((p) => p && { ...p, starting: true, startError: null });
    engineSend(CMD.SHARE_START, { sourceId: source.id, name: source.name }, { timeoutMs: SLOW_COMMAND_TIMEOUT_MS }).then(
      () => setPicker(null),
      (err) => setPicker((p) => p && { ...p, starting: false, startError: err.message }),
    );
  };
  // BAR2: speaker / Stream / Overlay as slots in the bar's upper row.
  const barSlots = auth === 'in' ? voiceSlots({
    engine,
    pickerOpen: Boolean(picker),
    transmitting: pttLive,
    onOpenChannels: () => { if (cabinet !== 'channels') toggleCabinet('channels'); },
    onToggleOverlay: () => engineCommand(engine.state.overlay.open ? CMD.OVERLAY_CLOSE : CMD.OVERLAY_OPEN, {}),
    onShareClick,
  }) : [];
  const sharePickerPanel = picker && inVoice ? (
    <SharePicker
      list={picker}
      starting={Boolean(picker.starting)}
      startError={picker.startError}
      onRefresh={loadSources}
      onStart={startShare}
      onClose={() => setPicker(null)}
      maxHeight={Math.max(260, Math.min(560, vh - 110))}
      shareAudio={engine.state.voice.shareAudio /* SA */}
      onShareAudioChange={(enabled) => engineCommand(CMD.SHARE_SET_AUDIO, { enabled })}
    />
  ) : null;
  // ── SV: stream viewer ──────────────────────────────────────────────────
  // viewer: { callsign, error } | null — the sharer the strip is watching.
  // Opened by Watch (Channels joined view / the bar's watch chip); the engine
  // then relays that stream to us (state.voice.viewer === 'strip'). It follows
  // the engine: adopts a strip-owned stream after a page reload, closes when
  // the stream is handed to the overlay or voice ends. While open the strip
  // is pinned (strip.rs): focus loss collapses it to the viewer instead of
  // hiding it.
  const [viewer, setViewer] = useState(null);
  const [viewerExpanded, setViewerExpanded] = useState(false);
  const viewerRef = useRef(null);
  viewerRef.current = viewer;
  const viewerExpandedRef = useRef(false); // POLISH: for resuming after a hide
  viewerExpandedRef.current = viewerExpanded;
  const resumeViewerRef = useRef(null); // POLISH: { callsign, expanded } stopped by strip-hidden
  const viewerClosingRef = useRef(false); // stream.stop sent; don't re-adopt until the engine agrees
  const sv = engine.state.voice;
  useEffect(() => { if (auth === 'in') warmStreamListener(); }, [auth]);
  useEffect(() => {
    if (!engine.connected) return;
    if (!sv.channelId) { setViewer(null); return; }
    // The stream ended (the sharer stopped or left): collapse the viewer
    // instead of leaving a frozen last frame up (owner, 2026-11-08). The
    // engine clears watchTarget for the same reason (reconcileWatchTarget).
    const watching = viewerRef.current?.callsign;
    if (watching && !(sv.sharers || []).includes(watching)) {
      viewerClosingRef.current = false;
      setViewer(null);
      return;
    }
    if (sv.viewer === 'strip' && sv.watchTarget) {
      if (viewerClosingRef.current) return;
      setViewer((cur) => (cur?.callsign === sv.watchTarget ? cur : { callsign: sv.watchTarget, error: null }));
    } else {
      viewerClosingRef.current = false;
      if (sv.viewer === 'overlay') setViewer(null); // handed to the overlay
    }
  }, [engine.connected, sv.channelId, sv.viewer, sv.watchTarget, sv.sharers]);
  const viewerOpen = Boolean(viewer);
  useEffect(() => {
    if (!viewerOpen) setViewerExpanded(false);
  }, [viewerOpen]);
  // SV: pinned only while the stream viewer is up. A live-op notice does NOT
  // pin (owner, 2026-11-08): hiding the bar must hide the notice tab with it.
  // A new launch still peeks the hidden strip on its own (requestPeek).
  const pinned = viewerOpen;
  useEffect(() => {
    if (inTauri()) invoke('strip_set_pinned', { pinned }).catch((err) => console.warn('strip_set_pinned failed:', err));
  }, [pinned]);
  const openViewer = (callsign) => {
    viewerClosingRef.current = false;
    setViewer({ callsign, error: null });
    engineSend(CMD.STREAM_WATCH, { callsign }).catch((err) => setViewer((cur) => (cur?.callsign === callsign ? { ...cur, error: err.message } : cur)));
  };
  const closeViewer = () => {
    viewerClosingRef.current = true;
    setViewer(null);
    engineCommand(CMD.STREAM_STOP, {});
  };
  const openViewerRef = useRef(openViewer);
  openViewerRef.current = openViewer;
  const closeViewerRef = useRef(closeViewer);
  closeViewerRef.current = closeViewer;
  // C2: watch `callsign` at a WATCH_DESTINATIONS entry. 'bar' is the strip's
  // own viewer; any other destination takes the stream away from it (the
  // engine hands it over), so the viewer closes once that succeeds.
  // Resolves when started, rejects with the reason.
  const watchAt = (callsign, dest) => {
    if (dest.id === 'bar') { openViewer(callsign); return Promise.resolve(); }
    return engineSend(dest.cmd, { callsign }).then(() => {
      setViewer((cur) => (cur ? null : cur));
    });
  };
  const viewerSwitch = (dest) => {
    const callsign = viewer?.callsign;
    if (!callsign) return;
    watchAt(callsign, dest).catch((err) => setViewer((cur) => (cur?.callsign === callsign ? { ...cur, error: err.message } : cur)));
  };
  const streamsPanel = streamsOpen && inVoice && !sharePickerPanel ? (
    <StreamsPanel
      engine={engine}
      onPick={watchAt}
      onClose={closeStreams}
      maxHeight={Math.max(200, Math.min(420, vh - 110))}
    />
  ) : null;
  const stackPanel = sharePickerPanel || streamsPanel;
  const retryViewer = () => {
    const callsign = viewer?.callsign;
    if (!callsign) return;
    setViewer((cur) => cur && { ...cur, error: null });
    engineSend(CMD.STREAM_WATCH, { callsign, restart: true })
      .catch((err) => setViewer((cur) => (cur?.callsign === callsign ? { ...cur, error: err.message } : cur)));
  };
  const streamViewer = viewer && inVoice ? (ctx) => (
    <StripStreamViewer
      key={viewer.callsign}
      callsign={viewer.callsign}
      voice={sv}
      channelName={sv.channelName}
      {...ctx}
      expanded={viewerExpanded}
      onToggleExpand={() => setViewerExpanded((x) => !x)}
      overlayOk={engine.state.caps.overlay}
      error={viewer.error}
      onSwitch={viewerSwitch}
      onClose={closeViewer}
      onRetry={retryViewer}
      onShow={() => { closeCabinet(); setPicker(null); }}
      onShareAudio={(change) => engineCommand(CMD.SHARE_AUDIO_SET_VOLUME, { callsign: viewer.callsign, ...change }) /* SA */}
    />
  ) : null;
  // NET: voice failed to connect (classified by CommLink): a quiet chip on the
  // bar that opens Settings on the Repair panel.
  const [settingsSection, setSettingsSection] = useState(null);
  const bugReplies = useBugReportReplies(auth === 'in');
  useEffect(() => { if (cabinet !== 'settings') setSettingsSection(null); }, [cabinet]);
  // Repair connection lives under About & diagnostics.
  const openRepair = () => { setSettingsSection({ id: 'about', at: Date.now() }); if (cabinet !== 'settings') toggleCabinet('settings'); };
  // L3: a server-owner action refused with TWO_FACTOR_REQUIRED -> open
  // Settings → Account, where the two-factor setup lives.
  useEffect(() => {
    const onRequired = () => { setSettingsSection({ id: 'account', at: Date.now() }); if (cabinet !== 'settings') toggleCabinet('settings'); };
    window.addEventListener('specter:two-factor-required', onRequired);
    return () => window.removeEventListener('specter:two-factor-required', onRequired);
  });
  if (auth === 'in' && engine.connected && engine.state.voice.connectIssue) barSlots.push(repairSlot(engine.state.voice.connectIssue, openRepair));
  // The owner replied to a bug report: Settings → About & diagnostics → Your reports.
  if (auth === 'in' && bugReplies.unread > 0) barSlots.push(bugReplySlot(bugReplies.unread, openRepair));
  // S3: stuck MLS group(s) → suggest Resync encryption (same Settings section).
  const mlsStuck = engine.state.mls?.stuck;
  if (auth === 'in' && engine.connected && Array.isArray(mlsStuck) && mlsStuck.length) barSlots.push(encryptionSyncSlot(mlsStuck, openRepair, engine.state.mls?.repairing));
  barSlots.push(...(auth === 'in' ? streamWatchSlots({
    engine, viewerOpen,
    panelOpen: Boolean(streamsPanel),
    onToggle: () => {
      if (streamsOpen) { setStreamsOpen(false); return; }
      setCabinet(null);
      setFocus(null);
      setPicker(null);
      setStreamsOpen(true);
    },
  }) : []));

  const unreadTotal = auth === 'in' ? totalUnread(engine.state) : 0;
  const channelsBadge = unreadTotal > 0 ? {
    label: `${unreadTotal} unread`,
    element: <UnreadPill count={unreadTotal} className="pointer-events-none absolute -top-1 -right-1 !h-[17px] !min-w-[17px] !px-1 !text-[10px] border-2 border-specter-brand-ink" />,
  } : null;

  // P2C: Settings and Games cabinets.
  const renderP2CCabinet = (id, { onClose, maxHeight }) => {
    if (id === 'settings') {
      return (
        <Suspense fallback={<p className="px-4 py-4 text-ui-sm text-specter-text-subtle">Loading settings…</p>}>
          <SettingsCabinet
            settings={settings}
            user={stripUser}
            appVersion={appVersion}
            pttLive={pttLive}
            onUserChange={(u) => { setStripUser(u); setSessionUser(u).catch((err) => console.warn('setUser failed:', err)); }}
            onLogout={() => session.logout()}
            onSetBusy={setP2cBusy}
            onCheckUpdate={inTauri() ? () => invoke('updater_check_now') : null}
            engine={engine /* NET: the Repair panel */}
            openSection={settingsSection}
            resyncOrg={activeOrg /* MR2: Resync encryption, under About & diagnostics */}
            resync={resync}
            onResyncEncryption={auth === 'in' && engine.connected ? resyncEncryption : null}
            bugReplies={auth === 'in' ? bugReplies : null}
            maxHeight={maxHeight}
            onClose={onClose}
          />
        </Suspense>
      );
    }
    if (id === 'welcome') {
      return (
        <WelcomeCabinet
          org={activeOrg}
          orgIndex={Math.max(0, orgs.findIndex((o) => o.id === activeOrgId))}
          reloadKey={activeOrg?.welcome_updated_at || null}
          onSaved={onWelcomeSaved}
          onClose={onClose}
          maxHeight={maxHeight}
        />
      );
    }
    if (id === 'friends') {
      if (friendDm) {
        return (
          <div className="flex flex-col" style={{ height: Math.min(maxHeight, 520) }}>
            <StripChat
              key={`friend-dm:${friendDm.userId}`}
              kind="dm"
              channel={{ id: friendDm.userId, name: friendDm.callsign || 'Direct message', kind: 'dm' }}
              chat={engine.dm?.userId === friendDm.userId ? engine.dm : null}
              onSend={(text) => sendDmText(friendDm.userId, text)}
              onBack={() => setFriendDm(null)}
              onClose={() => { setFriendDm(null); onClose(); }}
            />
          </div>
        );
      }
      return (
        <FriendsCabinet
          userId={userId}
          onClose={onClose}
          maxHeight={maxHeight}
          onRequestsChange={setFriendRequests}
          onMessage={(p) => setFriendDm(p)}
        />
      );
    }
    if (id === 'games') {
      return (
        <GamesCabinet
          activeTool={gameTool}
          onOpenTool={(game, tool) => setGameTool({ game, tool, shipId: null })}
          onToolChange={setGameTool}
          onCloseTool={() => setGameTool(null)}
          onClose={onClose}
          maxHeight={maxHeight}
        />
      );
    }
    return null;
  };
  const renderCabinetAll = (id, args) => renderCabinet(id, args) ?? renderP2CCabinet(id, args);


  // ── LIVE: the notice's actions ─────────────────────────────────────────
  // Join: open the strip on the op's server with the Channels cabinet (the op
  // tree), and join my group's channel once the engine has that server's
  // channels — my group (the "Your group" channel) or my assignment's
  // channel, if I may join it; otherwise the op tree is left for me to pick.
  // View: the op panel, like the old LIVE chip / the Notifications cabinet.
  const [liveJoin, setLiveJoin] = useState(null); // { op, assignment, at }
  const joinLiveOp = (op) => {
    liveNotices.collapse();
    if (inTauri()) invoke('strip_show').catch(() => {});
    if (op.orgId !== activeOrgId) {
      const org = orgs.find((o) => o.id === op.orgId);
      if (org) selectOrg(org);
    }
    setInstantClose(false);
    setFocus(null);
    setPicker(null);
    setCabinet('channels');
    setLiveJoin({ op, assignment: liveNotices.assignment, at: Date.now() });
  };
  useEffect(() => {
    if (!liveJoin) return undefined;
    const { op, assignment } = liveJoin;
    const st = engine.state;
    if (engine.connected && st.org?.id === op.orgId) {
      const chans = st.channels.filter((c) => c.eventId === op.eventId && c.kind === 'voice');
      if (chans.length) {
        const target = chans.find((c) => c.mine && c.canJoin)
          || (assignment?.channelId ? chans.find((c) => c.id === assignment.channelId && c.canJoin) : null)
          || null;
        if (target && st.voice.channelId !== target.id) engineCommand(CMD.VOICE_JOIN, { channelId: target.id });
        setLiveJoin(null);
        return undefined;
      }
    }
    const t = setTimeout(() => setLiveJoin(null), Math.max(0, 10_000 - (Date.now() - liveJoin.at)));
    return () => clearTimeout(t);
  }, [liveJoin, engine.connected, engine.state, engineCommand]);
  const viewLiveOp = (op) => {
    liveNotices.collapse();
    if (inTauri()) invoke('strip_show').catch(() => {});
    setInstantClose(false);
    setFocus(null);
    setPicker(null);
    setCabinet(op.orgId === activeOrgId ? 'operations' : 'notifications');
    const t = opTarget.target;
    if (!t || t.eventId !== op.eventId || t.closing) opTarget.open(op.event, op.orgId);
  };
  const liveNotice = auth === 'in' && !gameToolOpen ? ({ bar, vw }) => (
    <LiveOpNotice notices={liveNotices} bar={bar} vw={vw} engineState={engine.state}
      joining={Boolean(liveJoin)} onJoin={joinLiveOp} onView={viewLiveOp} />
  ) : null;

  // ── Logged out ─────────────────────────────────────────────────────────
  const onLoginSubmit = async (e) => {
    e.preventDefault();
    setLoginState({ loading: true, error: null, notice: null });
    if (tfa.active) {
      const { error } = await tfa.submit();
      if (error) { setLoginState({ loading: false, error, notice: null }); return; }
      setLoginState({ loading: false, error: null, notice: null });
      setAuth('in');
      return;
    }
    const { error, code, masked_email, twoFactor } = await session.login({ email: form.email, password: form.password });
    if (twoFactor) {
      setForm((f) => ({ ...f, password: '' }));
      setLoginState({ loading: false, error: null, notice: null });
      tfa.begin(twoFactor.challenge);
      return;
    }
    if (code === 'EMAIL_NOT_VERIFIED') {
      setLoginState({ loading: false, error: session.verifyInboxMessage(masked_email), notice: null, unverified: true });
      return;
    }
    if (error) { setLoginState({ loading: false, error, notice: null }); return; }
    // auth-changed "login" switches this view (and wakes the engine window).
    setLoginState({ loading: false, error: null, notice: null });
    setForm((f) => ({ ...f, password: '' }));
    setAuth('in');
  };

  const onResendVerification = async () => {
    setLoginState((s) => ({ ...s, loading: true }));
    const { error } = await session.resendVerification({ email: form.email, password: form.password });
    setLoginState((s) => ({ ...s, loading: false, resendNote: error || 'If that matches an account awaiting verification, a new email is on its way.' }));
  };

  const onForgotSubmit = async (e) => {
    e.preventDefault();
    setForgotState({ loading: true, error: null, success: null });
    const { error } = await session.forgotPassword(form.email);
    if (error) { setForgotState({ loading: false, error, success: null }); return; }
    setForgotState({ loading: false, error: null, success: 'If an account with that email exists, a reset link has been sent.' });
  };

  const openSignup = async () => {
    try {
      if (inTauri()) {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(SIGNUP_URL);
      } else {
        window.open(SIGNUP_URL, '_blank', 'noopener');
      }
    } catch (err) {
      setLoginState((s) => ({ ...s, error: `Couldn't open the browser: ${err?.message || err}` }));
    }
  };

  const main = (
    <StripView
      grow={grow}
      auth={auth}
      loggedOutView={loggedOutView}
      login={{
        email: form.email,
        password: form.password,
        onEmailChange: (e) => setForm((f) => ({ ...f, email: e.target.value })),
        onPasswordChange: (e) => setForm((f) => ({ ...f, password: e.target.value })),
        onSubmit: onLoginSubmit,
        ...loginState,
        onResendVerification: loginState.unverified ? onResendVerification : undefined,
        onForgotPassword: () => { setForgotState({ loading: false, error: null, success: null }); setLoggedOutView('forgot'); },
        onCreateAccount: openSignup,
        twoFactor: tfa.twoFactor && { ...tfa.twoFactor, onCancel: () => { tfa.cancel(); setLoginState({ loading: false, error: null, notice: null }); } },
      }}
      forgot={{
        email: form.email,
        onEmailChange: (e) => setForm((f) => ({ ...f, email: e.target.value })),
        onSubmit: onForgotSubmit,
        ...forgotState,
        onBack: () => setLoggedOutView('login'),
      }}
      orgs={orgs}
      activeOrgId={activeOrgId}
      orgsLoading={orgsLoading}
      orgsError={orgsError}
      onSelectOrg={selectOrg}
      onOpenWelcome={auth === 'in' ? () => toggleCabinet('welcome') : null}
      userId={userId}
      friendRequests={friendRequests}
      onRefreshOrgs={loadOrgs}
      cabinet={cabinet}
      instantClose={instantClose}
      onToggleCabinet={toggleCabinet}
      onCloseCabinet={closeCabinet}
      update={update}
      updateInstalling={updateInstalling}
      updateError={updateError}
      onInstallUpdate={installUpdate}
      showHint={showHint}
      onDismissHint={dismissHint}
      onRegionChange={reportRegion}
      renderCabinet={renderCabinetAll /* P2C */}
      ops={auth === 'in' ? ops : null}
      opPanel={opPanel}
      barSlots={barSlots /* BAR2 */}
      channelsBadge={channelsBadge}
      channelsIcon={inVoice ? ScVoiceActive : null /* BRAND: the Channels tile while in voice */}
      stackPanel={stackPanel}
      cabinetSlotStyle={fluidSlotStyle(fluid, expand)}
      onCabinetSlotTransitionEnd={fluid.onTransitionEnd}
      streamViewer={streamViewer /* SV */}
      collapsed={collapsed /* SV */}
      liveNotice={liveNotice /* LIVE */}
      overlayTab={auth === 'in' && engine.connected && engine.state.voice.channelId
        ? ({ grow: g, onRegionChange: rc }) => (
          <OverlayTab engine={engine} grow={g} onRegionChange={rc}
            onClick={() => engineCommand(engine.state.overlay.open ? CMD.OVERLAY_CLOSE : CMD.OVERLAY_OPEN, {})} />
        ) : null /* OVERLAYTAB */}
    />
  );
  return <StripFrame layout={layout} grow={grow} expand={expand}>{main}<StatusBanner grow={grow} /></StripFrame>;
}
