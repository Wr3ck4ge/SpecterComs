// WarRoom.jsx — Tauri-exclusive Mission Control / War Room Dashboard
// Matches the SpecterComs "Aether Comms" concept: War Room sidebar, Active Operation
// calendar, Live Manifest tier roster, Soundboard, and Direct Messages panel.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { DEFAULT_KEYBINDS, storedKeybind } from '../keybinds';
import { api, UPLOADS_BASE_URL } from '../api';
import CommLink from './CommLink';
import SettingsUI from './SettingsUI';
import OrgSettings from './OrgSettings';
import OperationPlanner, { GroupPlanner } from './OperationPlanner';
import ShipEditor from './ShipEditor';
import ServerHome from './ServerHome';
import OpsCalendarPanel from './OpsCalendarPanel';
import HexBadge from './HexBadge';
import { COLOR_MAP, getOrgColor } from '../utils/orgColors';
import { Badge, Button, IconButton, Input } from './ui';
import { cx, focusRing, glassPanel } from './ui/styles';
import {
  CalendarDays, Check, ChevronDown, Eye, Hash, Layers, LogOut, Mic, MicOff, MonitorPlay, MonitorUp, MonitorX,
  PhoneOff, Play, Plus, Settings, Square, Trash2, Volume2, VolumeX, Wallet,
} from 'lucide-react';
import useEventStream from '../useEventStream';
import useMonitorChannel from '../useMonitorChannel';
import { notifyGroupKeyChange } from '../voiceRelayAudio';
import useEngineBridgeHost from '../engine/useEngineBridgeHost';
import { CMD, EV, STRIP_WINDOW, bridgeEmit, buildChatRows, buildEngineState, buildLevelsFrame } from '../engine/bridge';
// P2A: channel chat logic (headless, shared by TextChat and the strip), unread
// counts, and the strip's screen-share source list.
import useChannelChat, {
  channelChatRelayRef, channelChatResyncRef, channelChatSyncRequestRef, channelChatSyncResponseRef,
  channelChatOrgSyncRequestRef, startOrgSync, forgetOrgs, resyncOrgEncryption, // MR2
  dmChatRelayRef, dmChatSyncRequestRef, dmChatSyncResponseRef, requestDmCatchUp, subscribeChatRows, // MR2: DMs
} from '../engine/useChannelChat';
import { UNREAD_CHANGED_EVENT, countRelay, loadUnread, markRead as markUnreadRead, saveUnread } from '../engine/unreadStore';
import { listCaptureSourcesForStrip, nativeCaptureAvailable } from '../engine/captureSources';
import useSettingsBridgeHost from '../engine/useSettingsBridgeHost'; // P2C
import UserProfileModal from './UserProfileModal';
import BillingPanel, { BILLING_UI_ENABLED } from './BillingPanel';
import { getDmMessages } from '../messageStore';
import {
  ensureDmGroup, encryptDm, notePendingSent, handleDmCommit, handleDmWelcome,
  handleChannelCommit, handleChannelWelcome,
  ensureEventGroup, handleEventGroupCommit, handleEventGroupWelcome,
  ensureChannelGroup, // EVMLS
} from '../mlsSession';
import { barColor, fmtBytes, fmtTime, fmtDayLabel as fmtDate } from '../utils/format';
import { getOpsBadge, msUntilNextOpsChange } from '../utils/opsEvents';
import { canEditOp, canLaunchOp, canScheduleOps, canViewOpsCalendar } from '../utils/opsPermissions';
import holoProjector from '../assets/holo-projector.png';
import holoRoom from '../assets/holo-room.png';

// ── Module-level relay refs ───────────────────────────────────────────────────
// The chat engine (engine/useChannelChat.js) sets these; useEventStream calls
// them on message_relay (channel and, with context 'dm', DM — P2A / MR2).
const _textChatRelayRef  = channelChatRelayRef;
const _dmCabinetRelayRef = dmChatRelayRef;
// Peer backfill sync — see messageStore.js / messageController.ts /
// dmController.ts. Channels: sync_request (legacy) / org_sync_request /
// sync_response. DMs (MR2): dm_sync_request / dm_sync_response — before
// 2.0.1 these were wired to the CHANNEL events, which never carry a
// conversation_id, so DM backfill had never run.
const _textChatSyncRequestRef  = channelChatSyncRequestRef;
const _textChatSyncResponseRef = channelChatSyncResponseRef;
const _dmCabinetSyncRequestRef  = dmChatSyncRequestRef;
const _dmCabinetSyncResponseRef = dmChatSyncResponseRef;
// Re-triggers the channel's "ask peers what I'm missing" request on every
// fresh SSE connection (initial connect + every reconnect), not just once on
// channel open — see the `connected` handler below.
const _textChatResyncRef = channelChatResyncRef;
const LAST_SELECTED_ORG_KEY = 'specter_last_selected_org_id';

// ── HUD ambient components ────────────────────────────────────────────────

function AudioWaveform({ level, speaking }) {
  const canvasRef = React.useRef(null);
  const levelRef  = React.useRef(level);
  const speakRef  = React.useRef(speaking);
  const histRef   = React.useRef(Array(48).fill(0));
  const rafRef    = React.useRef(null);
  const frameRef  = React.useRef(0);

  React.useEffect(() => { levelRef.current = level; },    [level]);
  React.useEffect(() => { speakRef.current = speaking; }, [speaking]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      if (++frameRef.current % 4 !== 0) return;
      const W = canvas.width, H = canvas.height;
      const spk = speakRef.current;
      const lvl = levelRef.current;
      histRef.current.shift();
      histRef.current.push(spk ? lvl / 100 : 0);
      ctx.clearRect(0, 0, W, H);
      const bars = histRef.current;
      const bw = W / bars.length;
      for (let i = 0; i < bars.length; i++) {
        const a = bars[i];
        if (a > 0) {
          const bh = Math.max(2, a * H * 0.85);
          ctx.fillStyle = `rgba(6,182,212,${(0.35 + a * 0.6).toFixed(2)})`;
          ctx.fillRect(i * bw + 0.5, (H - bh) / 2, bw - 1, bh);
        } else {
          ctx.fillStyle = 'rgba(6,182,212,0.1)';
          ctx.fillRect(i * bw + 0.5, H / 2 - 0.5, bw - 1, 1);
        }
      }
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={192}
      height={28}
      style={{ display: 'block', width: '100%', height: 28 }}
    />
  );
}

// ── Diagnostic trace logging (debrief/reconnect-storm investigation) ────────
// Writes to setup_errors.log via the same client_log command used elsewhere,
// so the trace survives even if the renderer later hangs/freezes — visible in
// a Submit Diagnostics report. Falls back to console.log outside Tauri.
function traceLog(msg) {
  const line = `[trace] ${msg}`;
  if (window.__TAURI__) {
    import('@tauri-apps/api/core').then(({ invoke }) => invoke('client_log', { msg: line })).catch(() => {});
  } else {
    console.log(line);
  }
}

// ── Status / timezone helpers ────────────────────────────────────────────────

const TIMEZONE_FALLBACK = ['UTC','America/New_York','America/Chicago','America/Denver','America/Los_Angeles','Europe/London','Europe/Paris','Europe/Berlin','Asia/Tokyo','Asia/Shanghai','Asia/Kolkata','Australia/Sydney','Pacific/Auckland'];
function getSupportedTimezones() {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return TIMEZONE_FALLBACK; }
}
const statusLabel = (s) => {
  if (s === 1) return { text: 'Away',   color: '#facc15', dot: '#facc15' };
  if (s === 2) return { text: 'Busy',   color: '#f87171', dot: '#f87171' };
  if (s === 3) return { text: 'Invis',  color: '#94a3b8', dot: '#94a3b8' };
               return { text: 'Online', color: '#4ade80', dot: '#4ade80' };
};

// ── Profile Cabinet ──────────────────────────────────────────────────────────

function ProfileCabinet({ user, friends, onSelectFriend, onOpenSettings }) {
  const isTauri = Boolean(window.__TAURI__);
  const [profileExpanded, setProfileExpanded] = useState(false);
  const [timezone,        setTimezone]        = useState(user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [saving,          setSaving]          = useState(false);
  const [saved,           setSaved]           = useState(false);
  const [saveErr,         setSaveErr]         = useState(null);
  const [introSoundStatus, setIntroSoundStatus] = useState('idle'); // idle | uploading | ok | err
  const [introSoundMsg,    setIntroSoundMsg]    = useState('');
  const [hasIntroSound,    setHasIntroSound]    = useState(Boolean(user?.intro_sound_path));
  const [avatarStatus,     setAvatarStatus]     = useState('idle'); // idle | uploading | ok | err
  const [avatarMsg,        setAvatarMsg]        = useState('');
  const introFileRef = useRef(null);
  const avatarFileRef = useRef(null);
  const isPremium = (user?.subscription_tier ?? 0) >= 1;
  const timezones = getSupportedTimezones();

  const S = {
    label:   { fontSize: 11, color: '#0e7490', letterSpacing: '0.3em', marginBottom: 4 },
    input:   { width: '100%', background: '#041018', border: '1px solid #0e2233', borderRadius: 3, padding: '4px 8px', fontSize: 13, color: '#e5e7eb', outline: 'none', fontFamily: 'monospace' },
    btnDim:  { fontSize: 11, padding: '5px 0', borderRadius: 3, letterSpacing: '0.15em', background: 'transparent', border: '1px solid #0e2233', color: '#9ca3af', cursor: 'pointer' },
    btnCyan: { fontSize: 11, padding: '5px 0', borderRadius: 3, letterSpacing: '0.15em', background: '#041e2e', border: '1px solid #0891b2', color: '#22d3ee', cursor: 'pointer' },
  };

  const handleSave = async () => {
    setSaving(true); setSaveErr(null);
    const { error } = await api.updateProfile({ timezone });
    setSaving(false);
    if (error) { setSaveErr(error); return; }
    try {
      const stored = JSON.parse(localStorage.getItem('specter_user') || '{}');
      localStorage.setItem('specter_user', JSON.stringify({ ...stored, timezone }));
    } catch {}
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const handleAvatarUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarStatus('uploading');
    setAvatarMsg('');
    const formData = new FormData();
    formData.append('image', file);
    const { data, error } = await api.uploadAvatar(formData);
    if (error) {
      setAvatarStatus('err');
      setAvatarMsg(error);
    } else {
      setAvatarStatus('ok');
      setAvatarMsg('Avatar updated.');
      try {
        const stored = JSON.parse(localStorage.getItem('specter_user') || '{}');
        localStorage.setItem('specter_user', JSON.stringify({ ...stored, avatar_url: data.avatar_url }));
      } catch {}
    }
    if (avatarFileRef.current) avatarFileRef.current.value = '';
  };

  const handleIntroSoundUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIntroSoundStatus('uploading');
    setIntroSoundMsg('');
    const formData = new FormData();
    formData.append('audio', file);
    const { data, error } = await api.uploadIntroSound(formData);
    if (error) {
      setIntroSoundStatus('err');
      setIntroSoundMsg(error);
    } else {
      setIntroSoundStatus('ok');
      setIntroSoundMsg('Intro sound uploaded.');
      setHasIntroSound(true);
    }
    // Reset input so the same file can be re-selected
    if (introFileRef.current) introFileRef.current.value = '';
  };

  const handleDeleteIntroSound = async () => {
    const { error } = await api.deleteIntroSound();
    if (!error) {
      setHasIntroSound(false);
      setIntroSoundStatus('idle');
      setIntroSoundMsg('Intro sound removed.');
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Cabinet label */}
      <div style={{ padding: '8px 14px 6px', borderBottom: '1px solid #0e2233', fontSize: 11, color: '#0e7490', letterSpacing: '0.35em', flexShrink: 0 }}>
        PROFILE &amp; CONTACTS
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* ── Profile row ── */}
        <div style={{ borderBottom: '1px solid #0e2233' }}>
          <button
            onClick={() => setProfileExpanded(e => !e)}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors"
            style={{ background: profileExpanded ? '#040c17' : 'transparent' }}
            onMouseEnter={e => { if (!profileExpanded) e.currentTarget.style.background = '#050d17'; }}
            onMouseLeave={e => { if (!profileExpanded) e.currentTarget.style.background = 'transparent'; }}
          >
            <HexBadge letter={(user?.callsign || 'U')[0]} colorKey="cyan" size={34} active imageUrl={user?.avatar_url ? `${UPLOADS_BASE_URL}${user.avatar_url}` : null} />
            <div className="flex-1 min-w-0">
              <div style={{ fontSize: 13, fontWeight: 'bold', color: '#67e8f9' }}>{user?.callsign}</div>
              {user?.global_tag && <div style={{ fontSize: 13, color: '#0e7490' }}>[{user.global_tag}]</div>}
              <div style={{ fontSize: 13, color: '#4ade80', letterSpacing: '0.15em' }}>● ONLINE</div>
            </div>
            <span style={{ fontSize: 13, color: '#0e7490' }}>{profileExpanded ? '▲' : '▼'}</span>
          </button>

          {profileExpanded && (
            <div style={{ padding: '4px 14px 14px', borderTop: '1px solid #0a1522', background: '#030812' }} className="space-y-3">
              <div>
                <div style={S.label}>TIMEZONE</div>
                <select value={timezone} onChange={e => setTimezone(e.target.value)} style={{ ...S.input, padding: '5px 8px' }}>
                  {timezones.map(tz => <option key={tz} value={tz}>{tz}</option>)}
                </select>
              </div>
              <div>
                <div style={S.label}>AVATAR</div>
                <input ref={avatarFileRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" style={{ display: 'none' }} onChange={handleAvatarUpload} />
                <button
                  onClick={() => avatarFileRef.current?.click()}
                  disabled={avatarStatus === 'uploading'}
                  style={{ ...S.btnCyan, width: '100%', opacity: avatarStatus === 'uploading' ? 0.5 : 1 }}
                >
                  {avatarStatus === 'uploading' ? 'UPLOADING...' : user?.avatar_url ? 'REPLACE AVATAR' : 'UPLOAD AVATAR'}
                </button>
                {avatarMsg && (
                  <div style={{ fontSize: 10, color: avatarStatus === 'err' ? '#f87171' : '#4ade80', marginTop: 3 }}>{avatarMsg}</div>
                )}
                <div style={{ fontSize: 10, color: '#4b6278', marginTop: 3 }}>jpg/png/gif/webp, max 2 MB</div>
              </div>
              {/* ── Intro Sound (premium only) ── */}
              {isPremium ? (
                <div>
                  <div style={{ ...S.label, display: 'flex', alignItems: 'center', gap: 6 }}>
                    INTRO SOUND
                    <span style={{ fontSize: 9, background: '#0e7490', color: '#e5e7eb', borderRadius: 2, padding: '1px 5px', letterSpacing: '0.2em' }}>PREMIUM</span>
                  </div>
                  <input
                    ref={introFileRef}
                    type="file"
                    accept="audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/webm"
                    style={{ display: 'none' }}
                    onChange={handleIntroSoundUpload}
                  />
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => introFileRef.current?.click()}
                      disabled={introSoundStatus === 'uploading'}
                      style={{ ...S.btnCyan, flex: 1, opacity: introSoundStatus === 'uploading' ? 0.5 : 1 }}
                    >
                      {introSoundStatus === 'uploading' ? 'UPLOADING...' : hasIntroSound ? 'REPLACE SOUND' : 'UPLOAD SOUND'}
                    </button>
                    {hasIntroSound && (
                      <button
                        onClick={handleDeleteIntroSound}
                        style={{ ...S.btnDim, padding: '4px 8px', flex: 'none' }}
                        onMouseEnter={e => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.borderColor = '#7f1d1d'; }}
                        onMouseLeave={e => { e.currentTarget.style.color = '#9ca3af'; e.currentTarget.style.borderColor = '#0e2233'; }}
                      >✕</button>
                    )}
                  </div>
                  {introSoundMsg && (
                    <div style={{ fontSize: 13, color: introSoundStatus === 'err' ? '#f87171' : '#4ade80', marginTop: 3 }}>
                      {introSoundMsg}
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: '#4b6278', marginTop: 3 }}>
                    Plays for others when you join a channel. Max 5 MB (mp3/wav/ogg).
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 10, color: '#4b6278', padding: '6px 0 2px', borderTop: '1px solid #0a1522' }}>
                  ♦ Upgrade to Premium to set a custom join intro sound.
                </div>
              )}
              {saveErr && <div style={{ fontSize: 13, color: '#f87171' }}>{saveErr}</div>}
              {saved   && <div style={{ fontSize: 13, color: '#4ade80' }}>Profile saved.</div>}
              <div className="flex gap-1.5">
                <button onClick={handleSave} disabled={saving} style={{ ...S.btnCyan, flex: 1, opacity: saving ? 0.5 : 1 }}>
                  {saving ? 'SAVING...' : 'SAVE PROFILE'}
                </button>
                <button onClick={onOpenSettings} style={{ ...S.btnDim, flex: 1 }}
                  onMouseEnter={e => { e.currentTarget.style.color = '#22d3ee'; e.currentTarget.style.borderColor = '#0e7490'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = '#9ca3af'; e.currentTarget.style.borderColor = '#0e2233'; }}
                >SETTINGS</button>
              </div>
            </div>
          )}
        </div>

        {/* ── Contacts list ── */}
        <div>
          <div style={{ padding: '8px 14px 4px', fontSize: 11, color: '#0e7490', letterSpacing: '0.35em' }}>CONTACTS</div>
          {friends.length === 0 && (
            <div style={{ padding: '14px', fontSize: 13, color: '#94a3b8', textAlign: 'center' }}>No contacts yet</div>
          )}
          {friends.map(f => {
            const pres = statusLabel(f.presence_status);
            return (
              <button
                key={f.id}
                onClick={() => onSelectFriend(f)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors"
                style={{ borderBottom: '1px solid #0a131c' }}
                onMouseEnter={e => e.currentTarget.style.background = '#050d17'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <HexBadge letter={(f.callsign || '?')[0]} colorKey="blue" size={26} />
                  <div style={{ position: 'absolute', bottom: -1, right: -1, width: 8, height: 8, borderRadius: '50%', background: pres.dot, border: '1.5px solid #030a13' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="truncate" style={{ fontSize: 13, color: '#d1d5db', fontWeight: 'bold' }}>{f.callsign}</div>
                  <div className="truncate" style={{ fontSize: 13, color: '#64748b' }}>[{f.global_tag}]</div>
                </div>
                <span style={{ fontSize: 13, color: pres.color }}>{pres.text}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── DM Cabinet ───────────────────────────────────────────────────────────────

function DmCabinet({ friend, onBack, currentUserId }) {
  const [messages,    setMessages]    = React.useState([]);
  const [input,       setInput]       = React.useState('');
  const [loading,     setLoading]     = React.useState(true);
  const [sendError,   setSendError]   = React.useState(null);
  const inFlightRef = React.useRef(false);
  const bottomRef   = React.useRef(null);

  // Deterministic, order-independent conversation ID
  const convId = React.useMemo(() => {
    if (!currentUserId || !friend?.user_id) return null;
    return [currentUserId, friend.user_id].sort().join('-');
  }, [currentUserId, friend?.user_id]);

  // ── Rows from the local store, reloaded on every change ───────────────────
  // MR2: the chat engine (engine/useChannelChat.js) receives, decrypts and
  // stores every DM — live relays, retries of pending rows, the partner's
  // backfill — whether or not this cabinet is open; this only renders.
  React.useEffect(() => {
    if (!convId) { setLoading(false); return undefined; }
    let cancelled = false;
    let timer = null;
    setMessages([]);
    setLoading(true);
    const load = () => {
      getDmMessages(convId).then(msgs => {
        if (!cancelled) {
          setMessages(msgs ?? []);
          setLoading(false);
        }
      }).catch(() => { if (!cancelled) setLoading(false); });
    };
    load();
    const unsubscribe = subscribeChatRows(convId, () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; load(); }, 30);
    });
    return () => { cancelled = true; if (timer) clearTimeout(timer); unsubscribe(); };
  }, [convId]);

  // ── Ask the other participant for anything missing from our local history ─
  React.useEffect(() => {
    if (!convId || !friend?.user_id) return;
    requestDmCatchUp(friend.user_id).catch(() => {});
  }, [convId, friend?.user_id]);

  // ── Scroll to bottom on new messages ─────────────────────────────────────
  React.useEffect(() => {
    if (!loading) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, loading]);

  const handleSend = async () => {
    const content = input.trim();
    if (!content || inFlightRef.current) return;
    inFlightRef.current = true;
    setInput('');
    setSendError(null);
    try {
      await ensureDmGroup(api, currentUserId, friend.user_id, convId);
      const ciphertext = await encryptDm(api, currentUserId, convId, content);
      notePendingSent(convId, content);
      // api.js's fetchWithAuth resolves {data, error} rather than throwing on
      // a failed request, so a failed send (expired token, network drop) must
      // be checked explicitly — see the identical fix in the channel chat's
      // handleSend above.
      const { error: sendApiError } = await api.sendDmMessage(friend.user_id, ciphertext);
      if (sendApiError) throw new Error(sendApiError);
    } catch (err) {
      console.error('[DM] send failed:', err);
      setInput(content);
      setSendError(err?.message || 'Message failed to send — try again.');
    }
    inFlightRef.current = false;
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // Group messages by date
  let lastDate = null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3 py-2.5" style={{ borderBottom: '1px solid #0e2233', flexShrink: 0 }}>
        <button onClick={onBack}
          style={{ fontSize: 13, color: '#0e7490', cursor: 'pointer', letterSpacing: '0.15em', background: 'none', border: 'none' }}
          onMouseEnter={e => e.currentTarget.style.color = '#22d3ee'}
          onMouseLeave={e => e.currentTarget.style.color = '#0e7490'}
        >← BACK</button>
        <div style={{ flex: 1, height: 1, background: '#0e2233' }} />
        <HexBadge letter={(friend.callsign || '?')[0]} colorKey="blue" size={22} />
        <span style={{ fontSize: 13, color: '#67e8f9', fontWeight: 'bold' }}>{friend.callsign}</span>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto" style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {loading && <div style={{ textAlign: 'center', color: '#0e7490', fontSize: 13, marginTop: 20 }}>LOADING...</div>}
        {!loading && messages.length === 0 && (
          <div style={{ textAlign: 'center', color: '#0e7490', fontSize: 13, marginTop: 30, letterSpacing: '0.15em' }}>
            No messages yet — say hi to {friend.callsign}
          </div>
        )}

        {messages.map((msg) => {
          const mine = msg.sender_id === currentUserId;
          const msgDate = fmtDate(msg.timestamp);
          const showDivider = msgDate !== lastDate;
          lastDate = msgDate;
          return (
            <React.Fragment key={msg.id}>
              {showDivider && (
                <div style={{ textAlign: 'center', color: '#0e7490', fontSize: 10, margin: '8px 0 4px', letterSpacing: '0.15em' }}>
                  — {msgDate} —
                </div>
              )}
              <div style={{
                display: 'flex', flexDirection: mine ? 'row-reverse' : 'row',
                alignItems: 'flex-end', gap: 6, marginBottom: 2,
              }}>
                <div style={{
                  maxWidth: '80%', padding: '6px 10px', borderRadius: mine ? '8px 8px 2px 8px' : '8px 8px 8px 2px',
                  background: mine ? '#0c2a3a' : '#060e1a',
                  border: `1px solid ${mine ? '#0891b2' : '#0e2233'}`,
                  fontSize: 13, color: mine ? '#e0f2fe' : '#e5e7eb', lineHeight: 1.5,
                  wordBreak: 'break-word',
                }}>
                  {/* A row with no `plaintext` key at all predates E2E — encrypted_content
                      was genuinely plaintext back then, so show it as-is. A row where
                      plaintext is explicitly null means it can't be read yet (MR2: pending). */}
                  {msg.plaintext !== undefined ? (msg.plaintext ?? 'Waiting for key…') : msg.encrypted_content}
                  <span style={{ display: 'block', fontSize: 9, color: '#0e7490', marginTop: 2, textAlign: mine ? 'right' : 'left' }}>
                    {fmtTime(msg.timestamp)}
                  </span>
                </div>
              </div>
            </React.Fragment>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      {sendError && (
        <div style={{ padding: '4px 16px', fontSize: 11, color: '#f87171', background: '#1a0505', borderTop: '1px solid #3b0a0a' }}>
          {sendError}
        </div>
      )}
      <div style={{ padding: '8px', borderTop: '1px solid #0e2233', flexShrink: 0, display: 'flex', gap: 6 }}>
        <input
          value={input}
          onChange={e => { setInput(e.target.value); if (sendError) setSendError(null); }}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${friend.callsign}...`}
          maxLength={4000}
          style={{
            flex: 1, background: '#041018', border: '1px solid #0e2233', borderRadius: 3,
            padding: '6px 10px', fontSize: 13, color: '#e5e7eb', outline: 'none', fontFamily: 'monospace',
          }}
          onFocus={e => e.target.style.borderColor = '#0891b2'}
          onBlur={e => e.target.style.borderColor = '#0e2233'}
        />
        <button
          onClick={handleSend}
          disabled={!input.trim()}
          style={{
            fontSize: 13, padding: '6px 10px', borderRadius: 3, letterSpacing: '0.1em',
            background: '#041e2e', border: '1px solid #0891b2', color: '#22d3ee',
            cursor: input.trim() ? 'pointer' : 'not-allowed', flexShrink: 0,
            opacity: input.trim() ? 1 : 0.4,
          }}
        >
          ▶
        </button>
      </div>
    </div>
  );
}

// ── Connection quality indicator — Discord-style signal bars, driven by
// CommLink's rolling drop/reconnect count over the last 60s (see
// recomputeConnectionQuality in CommLink.jsx). Purely a visibility aid: it
// doesn't change any behavior itself, but turns "is my connection actually
// flaky right now" into something visible at a glance, for the user and for
// anyone helping them debug a report of choppy audio/video, instead of a
// question that requires pulling server logs.
const CONNECTION_QUALITY_META = {
  excellent: { bars: 4, color: '#22c55e', label: 'Excellent connection' },
  good:      { bars: 3, color: '#22c55e', label: 'Good connection — one recent drop' },
  fair:      { bars: 2, color: '#eab308', label: 'Fair connection — a few recent drops' },
  poor:      { bars: 1, color: '#ef4444', label: 'Poor connection — reconnecting frequently' },
};

function ConnectionQualityBars({ quality }) {
  const meta = CONNECTION_QUALITY_META[quality] || CONNECTION_QUALITY_META.excellent;
  return (
    <div
      title={meta.label}
      style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 10, cursor: 'default' }}
    >
      {[0, 1, 2, 3].map(i => (
        <div
          key={i}
          style={{
            width: 3,
            height: 3 + i * 2.3,
            borderRadius: 1,
            background: i < meta.bars ? meta.color : '#1e3a5f',
            transition: 'background 0.3s',
          }}
        />
      ))}
    </div>
  );
}

function EventGroupCompModal({ org, event, user, members, canEditEvent, canLaunchEvent, onLaunchEvent, onClose, onOpenEdit, onEventUpdated }) {
  const isOpenAccess = (event?.access_mode || 'open') === 'open';

  const start = new Date(event.start_time);
  const end = event.end_time ? new Date(event.end_time) : null;

  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        style={{
          width: 'min(1160px, 96vw)',
          maxHeight: '90vh',
          overflow: 'hidden',
          background: '#040c17',
          border: '1px solid #0e2233',
          boxShadow: '0 16px 48px rgba(0,0,0,0.65)',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: '12px 14px', borderBottom: '1px solid #0e2233', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div>
            <div style={{ fontSize: 11, color: '#0e7490', letterSpacing: '0.2em' }}>GROUP COMP</div>
            <div style={{ fontSize: 15, color: '#e5e7eb', fontWeight: 'bold' }}>{event.name}</div>
            <div style={{ fontSize: 11, color: '#0891b2' }}>
              {start.toLocaleString()}
              {end ? ` — ${end.toLocaleString()}` : ''}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          {canLaunchEvent?.(event) && !event.launched && onLaunchEvent && (
            <button
              onClick={async () => { await onLaunchEvent(event); onClose(); }}
              style={{ fontSize: 11, padding: '5px 10px', borderRadius: 3, border: '1px solid #16a34a', background: '#0c2a1a', color: '#4ade80', letterSpacing: '0.15em', cursor: 'pointer' }}
            >
              ⚡ LAUNCH EVENT
            </button>
          )}
          {canEditEvent && (
            <button
              onClick={onOpenEdit}
              style={{ fontSize: 11, padding: '5px 10px', borderRadius: 3, border: '1px solid #0891b2', background: '#041e2e', color: '#22d3ee', letterSpacing: '0.15em', cursor: 'pointer' }}
            >
              EDIT EVENT
            </button>
          )}
          <button
            onClick={onClose}
            style={{ fontSize: 18, color: '#0e7490', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: '10px 14px', borderBottom: '1px solid #0e2233', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, letterSpacing: '0.15em', color: isOpenAccess ? '#22d3ee' : '#fde047', border: `1px solid ${isOpenAccess ? '#0891b2' : '#ca8a04'}`, borderRadius: 3, padding: '2px 8px' }}>
            {isOpenAccess ? 'OPEN JOIN' : 'RESTRICTED'}
          </span>
        </div>

        {/* Same tree layout as the editor (OperationPlanner) — canEdit=false renders
            it read-only with JOIN/LEAVE buttons per node instead of edit controls. */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
          <GroupPlanner
            orgId={org.id}
            eventId={event.id}
            members={members || []}
            isLaunched={!!event.launched}
            canEdit={false}
            user={user}
            accessMode={event.access_mode || 'open'}
            game={event.game || 'none'}
          />
        </div>
      </div>
    </div>
  );
}

// ── Soundboard ───────────────────────────────────────────────────────────────

const SOUND_BUTTONS = [
  { label: 'MOVE OUT', icon: '▶▶' },
  { label: 'BREACH',   icon: '⚡' },
  { label: 'HOLD',     icon: '⏸' },
  { label: 'RALLY',    icon: '↩' },
  { label: 'FLANK',    icon: '↗' },
  { label: 'COVER',    icon: '⛊' },
  { label: 'CONTACT',  icon: '⚠' },
  { label: 'CLEAR',    icon: '✓' },
  { label: 'EXTRACT',  icon: '⬆' },
];

function Soundboard() {
  const [active, setActive] = useState(null);

  const press = (label) => {
    setActive(label);
    setTimeout(() => setActive(null), 600);
  };

  return (
    <div className="grid grid-cols-3 gap-1.5 p-3">
      {SOUND_BUTTONS.map(s => (
        <button
          key={s.label}
          onClick={() => press(s.label)}
          className="flex flex-col items-center gap-0.5 py-2 rounded transition-all"
          style={{
            background: active === s.label ? '#0c3a4a' : '#070d14',
            border: `1px solid ${active === s.label ? '#0891b2' : '#0e2030'}`,
            boxShadow: active === s.label ? '0 0 8px rgba(6,182,212,0.4)' : 'none',
          }}
        >
          <span className="text-sm leading-none">{s.icon}</span>
          <span className="text-xs text-white/50 tracking-wider font-mono">{s.label}</span>
        </button>
      ))}
    </div>
  );
}

// ── Tier helpers ─────────────────────────────────────────────────────────────

// ── Text Chat Panel ──────────────────────────────────────────────────────────

// URL regex for detecting hyperlinks in message content
const URL_REGEX = /(https?:\/\/[^\s<]+)/i;

function MessageContent({ text }) {
  const [pendingUrl, setPendingUrl] = useState(null);

  if (!text) return null;

  const parts = text.split(URL_REGEX);
  return (
    <>
      {parts.map((part, i) =>
        URL_REGEX.test(part) ? (
          <span
            key={i}
            onClick={() => setPendingUrl(part)}
            style={{ color: '#22d3ee', textDecoration: 'underline', cursor: 'pointer' }}
          >
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
      {pendingUrl && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
          onClick={() => setPendingUrl(null)}
        >
          <div
            className="bg-[#0a1520] border border-[#0e7490] rounded-lg p-5 max-w-md w-full mx-4 font-mono"
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontSize: 13, color: '#f59e0b', letterSpacing: '0.2em', marginBottom: 8 }}>
              ⚠ EXTERNAL LINK WARNING
            </div>
            <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 12 }}>
              You are about to open an external link in your browser. Only proceed if you trust this URL.
            </div>
            <div style={{
              fontSize: 13, color: '#22d3ee', background: '#041018', border: '1px solid #0e2233',
              borderRadius: 3, padding: '6px 10px', wordBreak: 'break-all', marginBottom: 16,
            }}>
              {pendingUrl}
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setPendingUrl(null)}
                style={{
                  fontSize: 13, padding: '5px 14px', borderRadius: 3,
                  background: '#1a1a2e', border: '1px solid #374151', color: '#cbd5e1',
                  cursor: 'pointer', letterSpacing: '0.1em',
                }}
              >
                CANCEL
              </button>
              <button
                onClick={() => { window.open(pendingUrl, '_blank', 'noopener,noreferrer'); setPendingUrl(null); }}
                style={{
                  fontSize: 13, padding: '5px 14px', borderRadius: 3,
                  background: '#0e4a5a', border: '1px solid #0891b2', color: '#67e8f9',
                  cursor: 'pointer', letterSpacing: '0.1em',
                }}
              >
                OPEN IN BROWSER
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// P2A: the chat logic (history, relay decrypt, peer backfill, send) lives in
// engine/useChannelChat.js; WarRoom owns the one instance and passes it in
// as `chat`, so the strip and this (dev-only engine UI) view share it.
function TextChat({ chat, channel }) {
  const { messages, loading } = chat;
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [expandedImg, setExpandedImg] = useState(null);
  const [reportModal, setReportModal] = useState(null); // { msg }
  const endRef = useRef(null);

  // ── Auto-scroll on new messages ───────────────────────────────────────────
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || !channel?.id) return;
    setInput('');
    setSendError(null);
    setSending(true);
    try {
      await chat.send(text, channel);
    } catch (err) {
      // A failure here means the message never went out (see useChannelChat's
      // send) — restore the text so nothing typed is lost, and surface it.
      console.error('[TextChat] send failed:', err);
      setInput(text);
      setSendError(err?.message || 'Message failed to send — try again.');
    }
    setSending(false);
  };

  const resolveImageUrl = (url) => {
    if (!url) return null;
    if (url.startsWith('http')) return url;
    const base = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) || 'http://localhost:8082';
    return `${base}${url}`;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Channel header */}
      <div className="flex items-center gap-2 px-4 py-2 flex-shrink-0" style={{ borderBottom: '1px solid #0e2233', background: '#040c17' }}>
        <span style={{ fontSize: 13, color: '#22d3ee', fontWeight: 'bold' }}>#</span>
        <span style={{ fontSize: 13, color: '#e5e7eb', fontWeight: 'bold', letterSpacing: '0.1em' }}>
          {channel.name.toUpperCase()}
        </span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1" style={{ background: '#040c17' }}>
        {loading && messages.length === 0 && (
          <div style={{ fontSize: 13, color: '#94a3b8', textAlign: 'center', paddingTop: 40, letterSpacing: '0.2em' }}>
            Loading messages...
          </div>
        )}
        {!loading && messages.length === 0 && (
          <div style={{ fontSize: 13, color: '#94a3b8', textAlign: 'center', paddingTop: 40 }}>
            No messages yet. Start the conversation.
          </div>
        )}
        {messages.map(msg => (
          <div
            key={msg.id}
            className="group flex gap-2 py-1.5 hover:bg-white/[0.02] rounded px-1 -mx-1 transition-colors"
            onContextMenu={e => { e.preventDefault(); setReportModal({ msg }); }}
          >
            <span style={{ fontSize: 10, color: '#0e7490', flexShrink: 0, marginTop: 2, fontFamily: 'monospace' }}>
              {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
            <span style={{ fontSize: 13, color: '#0891b2', flexShrink: 0, fontWeight: 'bold', fontFamily: 'monospace' }}>
              {msg.callsign || 'Unknown'}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* A row with no `plaintext` key at all predates E2E — encrypted_content
                  was genuinely plaintext back then, so show it as-is. A row where
                  plaintext is explicitly null means it can't be read yet (MR2: pending —
                  retried on key changes, replaced by a peer's backfill). */}
              {msg.plaintext === null && (
                <span style={{ fontSize: 12, color: '#64748b', fontStyle: 'italic' }}>Waiting for key…</span>
              )}
              {(msg.plaintext !== undefined ? msg.plaintext : msg.encrypted_content) != null && (
                <span style={{ fontSize: 13, color: '#e5e7eb', wordBreak: 'break-word', fontFamily: 'monospace' }}>
                  <MessageContent text={msg.plaintext !== undefined ? (msg.plaintext ?? '[unable to decrypt]') : msg.encrypted_content} />
                </span>
              )}
              {msg.image_url && (
                <img
                  src={resolveImageUrl(msg.image_url)}
                  alt="attachment"
                  onClick={() => setExpandedImg(resolveImageUrl(msg.image_url))}
                  className="mt-1 rounded border border-[#0e2233] cursor-pointer hover:border-[#0891b2] transition-colors"
                  style={{ maxWidth: 320, maxHeight: 240, objectFit: 'contain' }}
                />
              )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Expanded image viewer */}
      {expandedImg && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 cursor-pointer"
          onClick={() => setExpandedImg(null)}
        >
          <img src={expandedImg} alt="expanded" style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: 4 }} />
        </div>
      )}

      {/* Report modal */}
      {reportModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={() => setReportModal(null)}>
          <div
            className="bg-[#0a1520] border border-[#0e7490] rounded-lg p-5 max-w-md w-full mx-4 font-mono"
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontSize: 13, color: '#f59e0b', letterSpacing: '0.2em', marginBottom: 8 }}>⚠ REPORT TO SYSTEM ADMIN</div>
            <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 10 }}>
              You are about to submit this message content to the system administrator.
              The content below will be visible to admins. Only proceed if you believe this message violates the rules.
            </div>
            <div style={{ fontSize: 13, color: '#e5e7eb', background: '#041018', border: '1px solid #0e2233', borderRadius: 3, padding: '8px 10px', marginBottom: 14, wordBreak: 'break-all', maxHeight: 120, overflow: 'auto' }}>
              {reportModal.msg.plaintext !== undefined
                ? (reportModal.msg.plaintext ?? '[unable to decrypt]')
                : reportModal.msg.encrypted_content}
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setReportModal(null)}
                style={{ fontSize: 13, padding: '5px 14px', borderRadius: 3, background: '#1a1a2e', border: '1px solid #374151', color: '#cbd5e1', cursor: 'pointer', letterSpacing: '0.1em' }}
              >CANCEL</button>
              <button
                onClick={async () => {
                  const msg = reportModal.msg;
                  setReportModal(null);
                  const iv  = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2,'0')).join('');
                  const tag = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2,'0')).join('');
                  // Reports need to stay readable by admins reviewing them, so this
                  // submits the resolved plaintext (see the render logic above) —
                  // submitting msg.encrypted_content here would hand admins ciphertext
                  // they have no way to decrypt.
                  await api.sendAbuseReport({
                    accused_id:        msg.sender_id,
                    channel_id:        msg.channel_id,
                    reported_at:       msg.timestamp,
                    encrypted_content: msg.plaintext !== undefined ? (msg.plaintext ?? '[unable to decrypt]') : msg.encrypted_content,
                    encryption_iv:     iv,
                    encryption_tag:    tag,
                  });
                }}
                style={{ fontSize: 13, padding: '5px 14px', borderRadius: 3, background: '#3b0a0a', border: '1px solid #b91c1c', color: '#fca5a5', cursor: 'pointer', letterSpacing: '0.1em' }}
              >SUBMIT REPORT</button>
            </div>
          </div>
        </div>
      )}

      {/* Input */}
      {sendError && (
        <div style={{ padding: '4px 16px', fontSize: 11, color: '#f87171', background: '#1a0505', borderTop: '1px solid #3b0a0a' }}>
          {sendError}
        </div>
      )}
      <form
        onSubmit={handleSend}
        className="flex gap-2 px-4 py-2 flex-shrink-0 items-center"
        style={{ borderTop: '1px solid #0e2233', background: '#030a13' }}
      >
        <input
          value={input}
          onChange={e => { setInput(e.target.value); if (sendError) setSendError(null); }}
          placeholder={`Message #${channel.name}`}
          maxLength={4000}
          style={{
            flex: 1, background: '#041018', border: '1px solid #0e2233',
            borderRadius: 3, padding: '6px 10px', fontSize: 13, color: '#e5e7eb',
            outline: 'none', fontFamily: 'monospace',
          }}
          onFocus={e => e.target.style.borderColor = '#0891b2'}
          onBlur={e => e.target.style.borderColor = '#0e2233'}
        />
        <button
          type="submit"
          disabled={!input.trim() || sending}
          style={{
            fontSize: 13, padding: '6px 14px', borderRadius: 3,
            background: '#0e4a5a', border: '1px solid #0891b2',
            color: '#67e8f9', cursor: 'pointer', letterSpacing: '0.1em',
            opacity: (!input.trim() || sending) ? 0.4 : 1,
          }}
        >
          {sending ? '...' : 'SEND'}
        </button>
      </form>
    </div>
  );
}

// ── Game Overlay (compact HUD for in-game use) ──────────────────────────────

function GameOverlay({ voiceRoster, localSpeaking, activeSharers, watchTarget, user, onExitOverlay, onWatchStream, videoCanvasRef, localAudioLevel, remoteLevels, streamConnected, voiceChannelName, embedded = false }) {
  const overlayRef = React.useRef(null);

  // Auto-resize the Tauri window to fit content height as it changes
  React.useEffect(() => {
    if (embedded) return;
    if (!window.__TAURI__) return;
    const el = overlayRef.current;
    if (!el) return;
    let rafId = null;
    const ro = new ResizeObserver((entries) => {
      if (rafId) return;
      rafId = requestAnimationFrame(async () => {
        rafId = null;
        const height = Math.ceil(entries[0].contentRect.height) + 2;
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const { LogicalSize } = await import('@tauri-apps/api/dpi');
          await getCurrentWindow().setSize(new LogicalSize(200, height));
        } catch {}
      });
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (rafId) cancelAnimationFrame(rafId); };
  }, [embedded]);

  // Find the currently active REMOTE speaker (self gets a TX chip instead)
  const localCallsign = user?.callsign || user?.username;
  const now = Date.now();
  const activeSpeaker = (() => {
    for (const r of voiceRoster) {
      if (r === localCallsign) continue;
      const e = remoteLevels?.[r];
      if (e && (now - e.ts) < 400 && e.level > 15) return r;
    }
    return null;
  })();

  // Shared semi-opaque pill style — only these elements are visible against the game
  const pill = { background: 'rgba(3,10,19,0.82)', backdropFilter: 'blur(6px)', border: '1px solid rgba(8,145,178,0.18)' };

  return (
    <div
      ref={overlayRef}
      className="font-mono select-none"
      style={{
        width: 200,
        background: 'transparent',
        WebkitAppRegion: embedded ? 'no-drag' : 'drag',
        padding: 4,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      {/* ── Exit button ── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={onExitOverlay}
          style={{
            ...pill,
            fontSize: 9, color: '#0e7490',
            borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
            WebkitAppRegion: 'no-drag',
            letterSpacing: '0.12em',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = '#ef4444'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.4)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = '#0e7490'; e.currentTarget.style.borderColor = 'rgba(8,145,178,0.18)'; }}
          title="Exit overlay"
        >
          ✕ EXIT
        </button>
      </div>

      {/* ── TX chip — shown when local user is transmitting ── */}
      {localSpeaking && (
        <div style={{
          ...pill,
          border: '1px solid rgba(34,211,238,0.5)',
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '4px 10px',
          borderRadius: 20,
        }}>
          <span style={{ fontSize: 7, color: '#22d3ee', textShadow: '0 0 8px rgba(34,211,238,0.9)', flexShrink: 0 }}>◉</span>
          <span style={{ fontSize: 13, color: '#22d3ee', fontFamily: 'monospace', letterSpacing: '0.06em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            TX{voiceChannelName ? ` → ${voiceChannelName}` : ''}
          </span>
        </div>
      )}

      {/* ── Active remote speaker chip — always rendered to reserve layout space ── */}
      <div style={{
        ...pill,
        border: '1px solid rgba(34,197,94,0.35)',
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '4px 10px',
        borderRadius: 20,
        visibility: activeSpeaker ? 'visible' : 'hidden',
      }}>
        <span style={{ fontSize: 7, color: '#22c55e', textShadow: '0 0 8px rgba(34,197,94,0.9)', flexShrink: 0 }}>◉</span>
        <div style={{ overflow: 'hidden', minWidth: 0 }}>
          <div style={{ fontSize: 13, color: '#22c55e', fontFamily: 'monospace', letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {activeSpeaker || '\u00A0'}
          </div>
          {voiceChannelName && (
            <div style={{ fontSize: 9, color: '#065f46', letterSpacing: '0.1em', whiteSpace: 'nowrap' }}>{voiceChannelName}</div>
          )}
        </div>
      </div>

      {/* ── Stream picker chips ── */}
      {activeSharers && activeSharers.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {activeSharers.map(cs => {
            const isWatching = watchTarget === cs;
            return (
              <div key={cs} style={{
                ...pill,
                border: `1px solid ${isWatching ? 'rgba(34,197,94,0.35)' : 'rgba(8,145,178,0.18)'}`,
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '3px 4px 3px 8px',
                borderRadius: 12,
              }}>
                <span style={{ fontSize: 10, color: '#0e7490', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  📺 {cs}
                </span>
                <button
                  onClick={() => onWatchStream(cs)}
                  style={{
                    fontSize: 9, padding: '2px 7px', flexShrink: 0,
                    color: isWatching ? '#22c55e' : '#22d3ee',
                    background: isWatching ? 'rgba(34,197,94,0.12)' : 'rgba(8,145,178,0.1)',
                    border: `1px solid ${isWatching ? 'rgba(34,197,94,0.4)' : 'rgba(8,145,178,0.28)'}`,
                    borderRadius: 3, cursor: 'pointer',
                    WebkitAppRegion: 'no-drag',
                  }}
                  onMouseEnter={e => { if (!isWatching) e.currentTarget.style.borderColor = 'rgba(8,145,178,0.6)'; }}
                  onMouseLeave={e => { if (!isWatching) e.currentTarget.style.borderColor = 'rgba(8,145,178,0.28)'; }}
                >
                  {isWatching ? '◉' : '▶'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Stream canvas ── */}
      {watchTarget && (
        <div style={{
          background: 'rgba(2,8,16,0.92)',
          border: '1px solid rgba(8,145,178,0.22)',
          borderRadius: 4,
          overflow: 'hidden',
          position: 'relative',
        }}>
          {/* Fixed-height 16:9 container (192px wide inner × 108px tall) */}
          <div style={{ width: '100%', height: 108, position: 'relative' }}>
            <canvas
              ref={videoCanvasRef}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
            />
            {!streamConnected && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex',
                alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
              }}>
                <span style={{ fontSize: 9, color: '#0e7490', letterSpacing: '0.15em' }}>CONNECTING...</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── End Operation Modal ───────────────────────────────────────────────────────
function EndOperationModal({ event, org, onClose, onEnded }) {
  const [mode, setMode] = React.useState('lobby');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);

  const handleEnd = async () => {
    setLoading(true);
    setError(null);
    const { error: err } = await api.endOperation(org.id, event.id, mode);
    setLoading(false);
    if (err) { setError(err); return; }
    onEnded(mode);
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(2,8,16,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: '#060e1a', border: '1px solid #7f1d1d', borderRadius: 6, width: 400, padding: 24, boxShadow: '0 0 40px rgba(220,38,38,0.3)' }}>
        <div style={{ fontSize: 11, color: '#f87171', letterSpacing: '0.35em', marginBottom: 8 }}>END OPERATION</div>
        <div style={{ fontSize: 15, fontWeight: 'bold', color: '#e5e7eb', marginBottom: 16 }}>{event.name}</div>

        <div style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
          Choose how to close out the operation for all connected personnel.
        </div>

        {/* Mode selector */}
        {[
          { value: 'lobby',   label: 'RETURN TO LOBBY', desc: 'Move all personnel to the first public channel. Event channels will be removed.' },
          { value: 'debrief', label: 'PULL TO DEBRIEF', desc: 'Auto-create a debrief channel, move all personnel there, then remove event channels.' },
        ].map(opt => (
          <div
            key={opt.value}
            onClick={() => setMode(opt.value)}
            style={{
              padding: '10px 12px', borderRadius: 4, marginBottom: 8, cursor: 'pointer',
              background: mode === opt.value ? '#1c0a0a' : '#040c17',
              border: `1px solid ${mode === opt.value ? '#991b1b' : '#0e2233'}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
                border: `2px solid ${mode === opt.value ? '#ef4444' : '#374151'}`,
                background: mode === opt.value ? '#ef4444' : 'transparent',
              }} />
              <span style={{ fontSize: 13, color: mode === opt.value ? '#fca5a5' : '#cbd5e1', letterSpacing: '0.2em', fontWeight: 'bold' }}>
                {opt.label}
              </span>
            </div>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 4, paddingLeft: 20 }}>{opt.desc}</div>
          </div>
        ))}

        {error && <div style={{ fontSize: 13, color: '#f87171', marginBottom: 10 }}>{error}</div>}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            style={{ fontSize: 13, padding: '6px 16px', borderRadius: 3, background: 'transparent', border: '1px solid #0e2233', color: '#64748b', cursor: 'pointer', letterSpacing: '0.15em' }}
          >CANCEL</button>
          <button
            onClick={handleEnd}
            disabled={loading}
            style={{
              fontSize: 13, padding: '6px 16px', borderRadius: 3, letterSpacing: '0.15em',
              background: loading ? '#3b0000' : '#7f1d1d', border: '1px solid #991b1b',
              color: '#fca5a5', cursor: loading ? 'not-allowed' : 'pointer', fontWeight: 'bold',
            }}
          >
            {loading ? 'ENDING...' : 'CONFIRM END'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Monitor Channel Instance ─────────────────────────────────────────────────
// Wrapper component so each monitored channel gets its own hook instance.
// useMonitorChannel is headless (no UI of its own), so onStatusChange is how
// the parent finds out this passive connection is actually live — without it
// there's no local confirmation that you're still present in a backgrounded
// channel, even though the server and other users already see you there.
function MonitorChannelInstance({ org, channel, volume, onStatusChange }) {
  const { roster, currentSpeaker, connected } = useMonitorChannel({ org, channel, volume, enabled: true });
  useEffect(() => {
    onStatusChange?.(channel.id, { connected, roster, currentSpeaker, name: channel.name });
  }, [channel.id, channel.name, connected, roster, currentSpeaker, onStatusChange]);
  useEffect(() => {
    return () => onStatusChange?.(channel.id, null);
  }, [channel.id, onStatusChange]);
  return null;
}

// ── Main WarRoom Component ───────────────────────────────────────────────────

export default function WarRoom({ user, onLogout, initialConnectOrgId, forceSettingsOpen, onSettingsPromptShown }) {
  const [orgs,               setOrgs]               = useState([]);
  const [selectedOrg,        setSelectedOrg]        = useState(null);
  const [events,             setEvents]             = useState([]);
  const [members,            setMembers]            = useState([]);
  const [channels,           setChannels]           = useState([]);
  const [activeChannel,      setActiveChannel]      = useState(null);  // currently viewed channel (text or voice)
  const [voiceChannel,       setVoiceChannel]       = useState(null);  // currently connected voice channel (independent)
  const [inComms,            setInComms]            = useState(false);
  const [showSettings,       setShowSettings]       = useState(false);

  // First-launch-of-a-new-version prompt (see App.jsx) — open once, then tell
  // the parent so it doesn't re-fire if this component remounts.
  useEffect(() => {
    if (forceSettingsOpen) {
      setShowSettings(true);
      onSettingsPromptShown?.();
    }
  }, [forceSettingsOpen]);

  // Mouse parallax — drives --look-x/--look-y CSS vars used by the projection
  // depth system in index.css (background shifts opposite to mouse, panels stay
  // fixed, creating a sense that the UI is floating above the projection field).
  useEffect(() => {
    const handleParallax = (e) => {
      const x = (e.clientX / window.innerWidth  - 0.5).toFixed(3);
      const y = (e.clientY / window.innerHeight - 0.5).toFixed(3);
      document.documentElement.style.setProperty('--look-x', x);
      document.documentElement.style.setProperty('--look-y', y);
    };
    window.addEventListener('pointermove', handleParallax, { passive: true });
    return () => window.removeEventListener('pointermove', handleParallax);
  }, []);

  const [showOrgSettings,    setShowOrgSettings]    = useState(false);
  const [plannerEvent,       setPlannerEvent]       = useState(null);   // null | 'create' | event obj
  const [groupCompEvent,     setGroupCompEvent]     = useState(null);   // null | event obj
  const [editingShip,        setEditingShip]        = useState(null);   // null | hangar ship obj (Settings > Games > Hangar "Open")
  const [friends,            setFriends]            = useState([]);
  const [loading,            setLoading]            = useState(true);
  // Voice roster & speaking state from CommLink
  const [voiceRoster,        setVoiceRoster]        = useState([]);
  // Live status of passively-monitored channels (primary group + inactive freqs),
  // keyed by channel id — lets the UI confirm "still connected" locally instead of
  // that presence only being visible to the server and other users.
  const [monitorStatus,      setMonitorStatus]      = useState({});
  const setMonitorStatusFor = useCallback((channelId, status) => {
    setMonitorStatus(prev => {
      if (status === null) {
        if (!(channelId in prev)) return prev;
        const next = { ...prev };
        delete next[channelId];
        return next;
      }
      return { ...prev, [channelId]: status };
    });
  }, []);
  // Real-time channel occupant list: { [channelId]: string[] } – updated via SSE + initial channel fetch
  const [channelPresence,    setChannelPresence]    = useState({});
  const [localSpeaking,      setLocalSpeaking]      = useState(false);
  // Audio level bars: local mic amplitude (0-100) and per-callsign remote levels
  const [localAudioLevel,    setLocalAudioLevel]    = useState(0);
  const [remoteLevels,       setRemoteLevels]       = useState({}); // { [callsign]: { level, ts } }
  // Lifted mute/share state from CommLink so sidebar can render controls
  const [voiceMuted,         setVoiceMuted]         = useState(true);
  const [voiceSharing,       setVoiceSharing]       = useState(false);
  // CommLink's connection status ('disconnected' | 'connecting' | 'connected'
  // | 'error') — only read by the strip bridge (connecting → connected).
  const [voiceStatus,        setVoiceStatus]        = useState('disconnected');
  // E2EV: CommLink's voice key / version-gate state ({ keyState, error } | null).
  const [voiceE2e,           setVoiceE2e]           = useState(null);
  // 'excellent' | 'good' | 'fair' | 'poor' — rolling drop/reconnect count from
  // CommLink's connection-health tracker, rendered as a signal-bars indicator
  // in the bottom status bar (see ConnectionQualityBars).
  const [voiceConnectionQuality, setVoiceConnectionQuality] = useState('excellent');
  // Profile modal: { callsign, isLocal } or null
  const [profileModalUser,   setProfileModalUser]   = useState(null);
  const [voiceReportModal,   setVoiceReportModal]   = useState(null); // { accusedUserId, accusedCallsign, orgId }
  const [voiceReportSubmitting, setVoiceReportSubmitting] = useState(false);
  const [gainValue,          setGainValue]          = useState(() => parseFloat(localStorage.getItem('specter_audio_gain') || '1.0'));
  // Ref to CommLink action functions (toggleMic, startScreenShare, etc.)
  const commLinkActionsRef = useRef({});
  // Ref for CommLink's text chat relay (used only when CommLink renders a text channel)
  const commLinkRelayRef = useRef(null);
  // Ref for CommLink's MLS video/audio key re-derive — see the mls_commit
  // handler below for why this needs to fire on top of handleChannelCommit.
  const commLinkMlsCommitRef = useRef(null);
  // Single OPERATIONS view (Now & soon + month grid + scheduled list) —
  // replaces the separate CALENDAR panel and Active Operations dropdown.
  const [opsViewOpen,        setOpsViewOpen]        = useState(true);
  // Bumped by a one-shot timer when an op crosses a badge/"Now & soon"
  // boundary (see msUntilNextOpsChange) so the header re-renders on time.
  const [opsClock,           setOpsClock]           = useState(0);
  const [serverPickerOpen,   setServerPickerOpen]   = useState(false);
  const [orgBilling,         setOrgBilling]         = useState(null);
  const [billingPanelOpen,   setBillingPanelOpen]   = useState(false);
  const [membersExpanded,    setMembersExpanded]    = useState(false);
  const [activeSharers,      setActiveSharers]      = useState([]); // callsigns of all active sharers
  const [watchTarget,        setWatchTarget]        = useState(null); // callsign to watch, or null
  // watchTarget only means anything while CommLink is mounted to actually show
  // the picture-in-picture preview (see its watchStreamTarget prop below).
  // There are several separate "leave voice" call sites (disconnect button,
  // op-end auto-disconnect, clicking away from the channel, CommLink's own
  // back button...) and it's easy to add a new one without remembering this
  // reset, which would leave a stale target behind. Centralizing the reset
  // here instead of duplicating it at every setInComms(false) call site makes
  // it correct by construction.
  useEffect(() => {
    if (!inComms) setWatchTarget(null);
  }, [inComms]);
  // SV: the strip's stream viewer owns watchTarget (stream.watch) — CommLink
  // relays to the strip instead of the overlay, and the overlay is told there
  // is no target. Dropped with the target (left voice, watch failed).
  const [stripViewer, setStripViewer] = useState(false);
  useEffect(() => { if (!watchTarget) setStripViewer(false); }, [watchTarget]);
  // Joining voice or starting to watch a stream folds the OPERATIONS view away
  // so it doesn't eat CommLink's / the stream's space (previously the calendar
  // just sat hidden under CommLink's layer with its pill still lit); the
  // button stays available to reopen it on top.
  useEffect(() => {
    if (inComms || watchTarget) setOpsViewOpen(false);
  }, [inComms, watchTarget]);
  // Channel management UI state
  const [showCreateChan,     setShowCreateChan]     = useState(false);
  const [newChanName,        setNewChanName]        = useState('');
  const [newChanKind,        setNewChanKind]        = useState(0); // 0=Voice, 1=Text
  const [chanCreateLoading,  setChanCreateLoading]  = useState(false);
  const [chanCreateError,    setChanCreateError]    = useState(null);
  // ── Left cabinet ──────────────────────────────────────────────────────────
  const [leftTab,          setLeftTab]          = useState(null); // null | 'profile' | 'dm'
  const [orgOrder,         setOrgOrder]         = useState([]);
  const [selectedDmFriend, setSelectedDmFriend] = useState(null);
  const [dragIdx,          setDragIdx]          = useState(null);
  const [isOverlay,        setIsOverlay]        = useState(false);
  const [overlayFallbackActive, setOverlayFallbackActive] = useState(false);
  const localOverlayCanvasRef = useRef(null);
  const [appVersion,       setAppVersion]       = useState('');
  // Monitor channels: array of channel objects to listen on (RX-only, ~30% vol)
  const [monitorChannels,  setMonitorChannels]  = useState([]); // { id, name, ... }
  // Liaison frequencies available to this user during an event
  const [availableFreqs,   setAvailableFreqs]   = useState([]); // [{id, name, channel_id, channel_name}]
  // Index into [primaryGroupChannel, ...availableFreqs] — 0 = primary group channel
  const [activeFreqIdx,    setActiveFreqIdx]    = useState(0);
  const [passiveFreqVolume, setPassiveFreqVolume] = useState(() => {
    const parsed = parseFloat(localStorage.getItem('specter_passive_freq_volume') || '0.3');
    return Number.isFinite(parsed) ? Math.max(0, Math.min(2, parsed)) : 0.3;
  });
  // Per-channel volume for monitor channels: { [channelId]: number } — defaults to 0.3
  const [monitorVolumes,   setMonitorVolumes]   = useState(() => {
    try { return JSON.parse(localStorage.getItem('specter_monitor_volumes') || '{}'); } catch { return {}; }
  });
  // Event join banner: shown when an event starts and user has an accepted assignment
  const [joinBanner,       setJoinBanner]       = useState(null); // null | { event, channel, group_name, role }
  const [isOpCommander,    setIsOpCommander]    = useState(false); // true when user has is_commander role in active event
  const [eventChannelAccess, setEventChannelAccess] = useState({}); // { [channelId]: true }
  const eventPromptTimersRef = useRef({}); // { [eventId]: timeoutId }
  // End operation modal: shown when commander wants to end the operation
  const [endOpModal,       setEndOpModal]       = useState(false);
  // DM notification: { from_user_id, from_callsign, count } when a DM arrives
  const [dmNotif,          setDmNotif]          = useState(null);
  // Toast notification queue: [{ id, type, title, body }]
  const [notifications,    setNotifications]    = useState([]);
  const notifCounterRef = useRef(0);
  const pushNotif = useCallback((type, title, body) => {
    const id = ++notifCounterRef.current;
    setNotifications(prev => [...prev, { id, type, title, body }]);
    // Auto-dismiss after 7 seconds
    setTimeout(() => setNotifications(prev => prev.filter(n => n.id !== id)), 7000);
  }, []);
  // Locally-muted user_ids (server-enforced per-listener via SET_LOCAL_MUTE —
  // see CommLink.jsx — so the mixer excludes them from just this listener's mix).
  // Persisted across sessions/restarts in localStorage.
  const [localMutedUsers, setLocalMutedUsers] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('specter_local_muted_users') || '[]'));
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('specter_local_muted_users', JSON.stringify([...localMutedUsers]));
    } catch {}
  }, [localMutedUsers]);

  // Fetch app version from Tauri on mount
  useEffect(() => {
    if (window.__TAURI__) {
      import('@tauri-apps/api/app').then(({ getVersion }) => getVersion()).then(v => setAppVersion(v)).catch(() => {});
    }
  }, []);

  // ── Overlay HUD: spawns a separate always-on-top Tauri window ──────────
  // Persistent unlisten ref so listeners are always cleaned up across abnormal
  // close paths (crash, OS close, failed IPC).
  const _unlistenOverlayReady = useRef(null);
  const _overlayMountWatchdogRef = useRef(null);
  const _overlayToggleInProgress = useRef(false); // mutex — prevents double-fire races
  const _overlayWinHandle = useRef(null); // cached WebviewWindow handle for the overlay
  const _overlayReadyAckRef = useRef(false);

  const _closeOverlayWindowHard = async (forceDestroy = false) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('hide_overlay');
    } catch {}
    if (forceDestroy) {
      try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const overlayWin = WebviewWindow.getByLabel('specter-overlay');
        if (overlayWin) await overlayWin.close();
      } catch {}
    }
    return true;
  };

  const _cleanupOverlayListeners = () => {
    if (_overlayMountWatchdogRef.current) {
      clearTimeout(_overlayMountWatchdogRef.current);
      _overlayMountWatchdogRef.current = null;
    }
    const readyFn = _unlistenOverlayReady.current;
    _unlistenOverlayReady.current = null;
    if (typeof readyFn === 'function') {
      // Tauri event unlisten is async; swallow rejected teardown during window destroy races.
      Promise.resolve()
        .then(() => readyFn())
        .catch(() => {});
    }
  };

  // Resolves true when the toggle went through (false: failed, or a toggle was
  // already in progress) — the strip bridge's overlay.watch acks on this.
  const toggleOverlay = async () => {
    if (!window.__TAURI__) return false;
    const isWindows = navigator.userAgent.toLowerCase().includes('windows');
    const manualOverlaySafeMode = isWindows && localStorage.getItem('specter_overlay_safe_mode') === '1';
    const localOverlaySafeMode = isWindows && (manualOverlaySafeMode || overlayFallbackActive);
    if (isWindows && localOverlaySafeMode) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('client_log', { msg: '[Overlay] local safe mode toggle' });
      } catch {}
      setIsOverlay((v) => {
        const next = !v;
        // Runtime fallback is cleared when the user exits local overlay,
        // allowing the next toggle to retry native overlay.
        if (!next && !manualOverlaySafeMode) setOverlayFallbackActive(false);
        return next;
      });
      pushNotif('info', 'Overlay Safe Mode', manualOverlaySafeMode
        ? 'Using local HUD only (native overlay bypassed).'
        : 'Using temporary local HUD fallback. Close overlay to retry native.');
      return true;
    }
    if (_overlayToggleInProgress.current) {
      console.log('[overlay] toggleOverlay debounced — already in progress');
      return false;
    }
    _overlayToggleInProgress.current = true;
    console.log('[overlay] toggleOverlay called, isOverlay=', isOverlay);
    const previousOverlayState = isOverlay;
    const nextOverlayState = !previousOverlayState;
    // Only commit open-state after native show is acknowledged to avoid
    // entering a false "overlay active" state during construction races.
    if (!nextOverlayState) setIsOverlay(false);
    // Helper: races a promise against a timeout, resolving to fallback if it times out.
    const withTimeout = (p, ms, fallback = null) =>
      Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);
    let _readyUnlisten; // cleaned up in finally
    try {
      const { emit, listen } = await import('@tauri-apps/api/event');
      import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('client_log', { msg: `[Overlay] native toggle start (isOverlay=${isOverlay})` }))
        .catch(() => {});
      const next = nextOverlayState;

      if (next) {
        // Determine position from the user's configured corner.
        // currentMonitor() is an IPC call that can hang — cap it at 800ms.
        let xPos = 16, yPos = 16;
        try {
          console.log('[overlay] fetching monitor info...');
          const { currentMonitor } = await import('@tauri-apps/api/window');
          const monitor = await withTimeout(currentMonitor(), 800);
          console.log('[overlay] monitor=', monitor ? `${monitor.size.width}x${monitor.size.height}` : 'null/timeout');
          if (monitor) {
            const f = monitor.scaleFactor;
            const mw = monitor.size.width / f;
            const mx = monitor.position.x / f;
            const my = monitor.position.y / f;
            const corner = localStorage.getItem('specter_overlay_corner') || 'top-right';
            xPos = corner === 'top-left' ? mx + 16 : mx + mw - 384 - 16;
            yPos = my + 16;
          }
        } catch (monErr) { console.warn('[overlay] currentMonitor error:', monErr); }

        // Auto-watch own stream if user is sharing and has no watch target yet.
        const localCallsign = user?.callsign || user?.username;
        if (voiceSharing && !watchTarget && localCallsign) {
          setWatchTarget(localCallsign);
        }

        // Ask the overlay to reset passthrough state, then wait for its ack.
        // This guarantees setIgnoreCursorEvents(true) is active before the window
        // becomes visible — the focus handler would otherwise set interactive mode
        // if the hotkey had been used in a prior session.
        const readyP = new Promise(async (resolve) => {
          try {
            _readyUnlisten = await listen('overlay-ready', () => {
              try { _readyUnlisten?.(); _readyUnlisten = null; } catch {}
              resolve();
            });
          } catch { resolve(); }
        });
        console.log('[overlay] emitting overlay-prepare');
        await emit('overlay-prepare', {});
        await withTimeout(readyP, 1200);

        const { invoke } = await import('@tauri-apps/api/core');

        // Trust invoke's own resolution/rejection for the show_overlay result
        // instead of racing a 'specter://overlay-show-result' event listener:
        // listen() registration is an async IPC round-trip with no ordering
        // guarantee relative to the Rust command's own emit, so a fast
        // show_overlay (e.g. cached/pre-warmed window) can emit before the
        // listener is registered — the event is then silently dropped (Tauri
        // does not queue events for late subscribers) and this always reads
        // as a timeout even though Rust already succeeded. invoke()'s promise
        // has no such race: it resolves/rejects exactly when the command
        // handler returns. The visibility poll below is the real success check.
        //
        // Still needs a timeout, though: WebviewWindowBuilder::build() for this
        // window has been observed (setup_errors.log breadcrumbs) taking
        // anywhere from instant to several minutes on this hardware before
        // eventually succeeding — with no timeout at all here, a slow build
        // means this await never returns, _overlayToggleInProgress never
        // resets, and the overlay button is permanently dead for the rest of
        // the session with no fallback and no error shown. Bound it so a slow
        // build falls back to the local HUD instead of hanging forever; if
        // Rust's build finishes later in the background after the fallback
        // already fired, hide the now-visible native window rather than
        // leaving an orphan behind/in front of the fallback UI.
        console.log('[overlay] showing overlay via Rust at', xPos, yPos);
        const showOverlayPromise = invoke('show_overlay', { x: xPos, y: yPos })
          .then(() => 'ok')
          .catch((err) => ({ err }));
        const showResult = await withTimeout(showOverlayPromise, 4000, 'timeout');
        if (showResult !== 'ok') {
          const reason = showResult === 'timeout'
            ? 'timeout'
            : String(showResult?.err?.message || showResult?.err || 'unknown');
          invoke('client_log', { msg: `[Overlay] native show failed: ${reason}` }).catch(() => {});
          if (reason === 'timeout') {
            showOverlayPromise.then((late) => {
              if (late === 'ok') {
                invoke('client_log', { msg: '[Overlay] native show_overlay resolved late after fallback — hiding orphaned window' }).catch(() => {});
                invoke('hide_overlay').catch(() => {});
              }
            });
          }
          throw new Error(reason);
        }

        // Rust's show_overlay already verifies (and SetWindowPos-corrects, if
        // needed) that the window is genuinely visible on the main thread
        // before it ever returns success — see do_show_overlay_on_main_thread.
        // Trust that signal directly rather than adding a second, independent
        // getByLabel()/isVisible() query here: a disagreeing re-check could
        // throw 'Overlay did not become visible' even when the window really
        // was showing, which would skip setIsOverlay(true) below — leaving no
        // overlay-update emitted (empty channel name / stream picker despite
        // the HUD being visible on screen) and React's isOverlay state stuck
        // at `false`, so the next toggle click would try to open again
        // instead of closing.
        console.log('[overlay] overlay shown — emitting overlay-update');
        invoke('client_log', { msg: '[Overlay] native show_overlay returned' }).catch(() => {});

        // Push current voice state immediately.
        await emit('overlay-update', overlayDataRef.current);
        invoke('client_log', { msg: '[Overlay] native overlay-update emitted' }).catch(() => {});

        setIsOverlay(true);
        console.log('[overlay] setIsOverlay(true) done');
      } else {
        // Closing path
        try { await emit('force-overlay-exit'); } catch {}
        const { invoke } = await import('@tauri-apps/api/core');
        invoke('client_log', { msg: '[Overlay] native hide_overlay start' }).catch(() => {});
        await invoke('hide_overlay').catch(() => {});
        invoke('client_log', { msg: '[Overlay] native hide_overlay returned' }).catch(() => {});
        console.log('[overlay] overlay hidden');
        _cleanupOverlayListeners();
      }
      return true;
    } catch (e) {
      console.error('[overlay] toggle FAILED:', e);
      setIsOverlay(previousOverlayState);
      return false;
    }
    finally {
      try { _readyUnlisten?.(); } catch {}
      _overlayToggleInProgress.current = false;
    }
  };

  // Ensure no orphaned overlay window survives when WarRoom unmounts/app exits.
  useEffect(() => {
    return () => {
      _cleanupOverlayListeners();
      if (!window.__TAURI__) return;
      _closeOverlayWindowHard().catch(() => {});
    };
  // mount/unmount only
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Overlay cleanup on app close is handled by the Rust on_window_event(Destroyed)
  // handler in lib.rs, which calls overlay.close() when the main window is destroyed.
  // A JS onCloseRequested handler here was intercepting the close event in Tauri 2
  // and preventing the native X-button close from working.

  // Keep a ref with fresh overlay data so the overlay-ready handler always sees current values.
  const overlayDataRef = useRef({});
  useEffect(() => {
    // When on a liaison frequency, show the freq name; else show the primary channel name
    const activeFreqName = activeFreqIdx > 0 ? (availableFreqs[activeFreqIdx - 1]?.name || null) : null;
    const localCallsign = user?.callsign || user?.username;
    // Defensive: always include the local user when they are sharing.
    const sharersForOverlay =
      voiceSharing && localCallsign && !activeSharers.includes(localCallsign)
        ? [...activeSharers, localCallsign]
        : activeSharers;
    overlayDataRef.current = {
      voiceRoster,
      localSpeaking,
      activeSharers: sharersForOverlay,
      remoteLevels,
      userCallsign: localCallsign,
      // SV: while the strip's viewer has the stream the overlay shows none.
      watchTarget: stripViewer ? null : watchTarget,
      voiceChannelName: activeFreqName || voiceChannel?.name || null,
    };
  }, [voiceRoster, localSpeaking, activeSharers, remoteLevels, user, watchTarget, stripViewer, voiceChannel, activeFreqIdx, availableFreqs, voiceSharing]);

  // Emit current voice state to the overlay HUD window whenever it changes.
  useEffect(() => {
    if (!isOverlay || !window.__TAURI__) return;
    import('@tauri-apps/api/event').then(({ emit }) => {
      emit('overlay-update', overlayDataRef.current);
    });
  }, [isOverlay, voiceRoster, localSpeaking, activeSharers, remoteLevels, watchTarget, stripViewer /* SV */, voiceChannel, voiceSharing]);

  // Heartbeat: re-send overlay-update every 2s while overlay is open.
  // This recovers from the race where the first overlay-ready-triggered update
  // is emitted before the overlay's listener is registered. Without this, an
  // idle voice channel (no speaking, no roster changes) would leave the overlay
  // showing empty state indefinitely.
  useEffect(() => {
    if (!isOverlay || !window.__TAURI__) return;
    const id = setInterval(() => {
      import('@tauri-apps/api/event').then(({ emit }) => {
        emit('overlay-update', overlayDataRef.current);
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [isOverlay]);

  // Overlay now has its own VideoDecoder fed by raw NAL bytes relayed from CommLink.
  useEffect(() => {
    const setFrameCb = commLinkActionsRef.current?.setVideoFrameCallback;
    if (setFrameCb) setFrameCb(null);
  }, [isOverlay, watchTarget, voiceSharing]);

  // Listen for stream selection from the overlay HUD.
  useEffect(() => {
    if (!isOverlay || !window.__TAURI__) return;
    let unlisten;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('overlay-stream-select', (event) => {
        const callsign = event.payload?.callsign || null;
        // SV: picking a stream in the overlay takes it over from the strip's
        // viewer; the overlay's "none" while the strip owns the stream only
        // means "nothing in the overlay", which is already the case.
        if (!callsign && stripViewerRef.current) return;
        setStripViewer(false);
        setWatchTarget(callsign);
      }).then(fn => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, [isOverlay]);
  const stripViewerRef = useRef(stripViewer); // SV: for the listener above
  stripViewerRef.current = stripViewer;

  // Listen for overlay-exit so the toggle button resets when the user closes the
  // overlay via its own X button (supplements tauri://destroyed on the window ref).
  useEffect(() => {
    if (!window.__TAURI__) return;
    let unlisten;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('overlay-exit', () => {
        setIsOverlay(false);
      }).then(fn => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, []);

  // Ref for cycle-stream hotkey (needs fresh activeSharers + watchTarget without re-registering shortcut)
  const cycleStreamRef = useRef({ activeSharers: [], watchTarget: null });
  useEffect(() => {
    cycleStreamRef.current = { activeSharers, watchTarget };
  }, [activeSharers, watchTarget]);

  // Listen for cycle-stream event (emitted by global shortcut)
  useEffect(() => {
    if (!window.__TAURI__) return;
    let unlisten;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('specter://cycle-stream', () => {
        const { activeSharers: sharers, watchTarget: current } = cycleStreamRef.current;
        if (!sharers || sharers.length === 0) return;
        const idx = sharers.indexOf(current);
        const next = idx >= sharers.length - 1 ? null : sharers[idx + 1];
        setWatchTarget(next);
      }).then(fn => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, []);

  // Debrief/reconnect-storm investigation: tracks the last logged commChannel id
  // so the render-scoped IIFE below only logs on actual change, not every render.
  const commChannelTraceRef = useRef(undefined);

  // The channel id CommLink currently has open. `commChannel` itself is a const
  // scoped to the render IIFE far below, so the SSE handlers (which live up here
  // and close over this component's scope, not that block's) cannot see it — they
  // referenced it anyway and threw `ReferenceError: commChannel is not defined`
  // every time an mls_commit/mls_welcome arrived, *before* reaching the key
  // re-derive call they were guarding. That made CommLink's MLS key refresh dead
  // on every client: a commit would advance the group's epoch while the local
  // SFrameCrypto key stayed on the old one, so video from anyone else in the
  // channel silently failed to decrypt for the rest of the session. Optional
  // chaining did not save it — `?.` guards null/undefined *values*, not an
  // identifier that was never declared in scope.
  //
  // Kept separate from commChannelTraceRef on purpose: that one is documented as
  // a logging aid and is only written inside an `if (changed)`, so overloading it
  // as load-bearing state would be a trap for the next person.
  const activeCommChannelIdRef = useRef(undefined);

  // Ref for freq cycle (needs fresh state without re-registering shortcut)
  const freqCycleRef = useRef({ availableFreqs: [], activeFreqIdx: 0, inComms: false });
  useEffect(() => {
    freqCycleRef.current = { availableFreqs, activeFreqIdx, inComms };
  }, [availableFreqs, activeFreqIdx, inComms]);

  // If available frequencies change (assignment updates/reload), keep the active
  // index inside the valid slot range: 0..availableFreqs.length
  useEffect(() => {
    traceLog(`availableFreqs.length changed to ${availableFreqs.length} — clamping activeFreqIdx`);
    setActiveFreqIdx(prev => Math.min(prev, availableFreqs.length));
  }, [availableFreqs.length]);

  // Listen for specter://cycle-freq (emitted by global shortcut or web keydown)
  useEffect(() => {
    const handleCycleFreq = () => {
      const { availableFreqs: freqs, activeFreqIdx: idx, inComms: connected } = freqCycleRef.current;
      if (!connected) return;
      const freqList = freqs; // [freq1, freq2, ...]  index 0 = first liaison freq; primary is null
      // Total slots = 1 (primary) + freqs.length
      const totalSlots = 1 + freqList.length;
      if (totalSlots < 2) return;
      traceLog(`cycle-freq hotkey fired, idx ${idx} -> ${(idx + 1) % totalSlots}`);
      setActiveFreqIdx(prev => (prev + 1) % totalSlots);
    };

    if (window.__TAURI__) {
      let unlisten;
      import('@tauri-apps/api/event').then(({ listen }) => {
        listen('specter://cycle-freq', handleCycleFreq).then(fn => { unlisten = fn; });
      });
      return () => { unlisten?.(); };
    } else {
      // Web fallback: listen for storage event dispatched from keydown handler
      window.addEventListener('specter-cycle-freq', handleCycleFreq);
      return () => window.removeEventListener('specter-cycle-freq', handleCycleFreq);
    }
  }, []);

  // Web keydown handler for channel toggle (non-Tauri)
  useEffect(() => {
    if (window.__TAURI__) return;
    const handler = (e) => {
      const stored = localStorage.getItem('specter_channel_toggle_key') || '';
      if (!stored) return;
      const parts = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      if (!['Control','Alt','Shift','Meta'].includes(e.key)) parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
      if (parts.join('+') === stored) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('specter-cycle-freq'));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Global shortcuts (PTT / channel-toggle while game is focused) ─────────
  useEffect(() => {
    if (!window.__TAURI__) return;
    let disposed = false;

    const mapKey = (k) =>
      k.replace(/\bCtrl\b/g, 'Control').replace(/\bMeta\b/g, 'Super');

    const setup = async () => {
      const { register, unregisterAll } = await import('@tauri-apps/plugin-global-shortcut');
      const { emit } = await import('@tauri-apps/api/event');
      await unregisterAll();
      if (disposed) return;

      const voiceMode = localStorage.getItem('specter_voice_mode') || 'push-to-talk';
      const pttKey = localStorage.getItem('specter_ptt_key') || '';
      const channelToggleKey = storedKeybind('specter_channel_toggle_key', DEFAULT_KEYBINDS.channelToggle);
      const streamNextKey = storedKeybind('specter_stream_next_key', DEFAULT_KEYBINDS.streamNext);
      const overlayPassthroughKey = storedKeybind('specter_overlay_passthrough_key', DEFAULT_KEYBINDS.overlayPassthrough);

      // Windows delivers WM_HOTKEY repeatedly while a hotkey is held down, so a
      // handler that just checks `state === 'Pressed'` fires on every auto-repeat
      // tick. For the one-shot actions below that meant holding the key cycled
      // through every stream/frequency in a blur instead of advancing by one.
      // Edge-detect: act on the first Pressed, then ignore further Presseds until
      // a Released arrives. PTT deliberately keeps both edges — it needs the
      // Released to stop transmitting — but is deduped so a held key doesn't
      // re-emit `active: true` on every repeat.
      const onEdge = (handler) => {
        let down = false;
        return (ev) => {
          const pressed = ev.state === 'Pressed';
          if (pressed === down) return;
          down = pressed;
          handler(pressed);
        };
      };

      if (voiceMode === 'push-to-talk' && pttKey) {
        try {
          await register(mapKey(pttKey), onEdge((pressed) => {
            emit('specter://ptt-active', { active: pressed });
          }));
        } catch (e) { console.warn('PTT shortcut register failed:', e); }
      }

      if (channelToggleKey) {
        try {
          await register(mapKey(channelToggleKey), onEdge((pressed) => {
            if (pressed) emit('specter://cycle-freq', {});
          }));
        } catch (e) { console.warn('Channel toggle shortcut register failed:', e); }
      }

      if (streamNextKey) {
        try {
          await register(mapKey(streamNextKey), onEdge((pressed) => {
            if (pressed) emit('specter://cycle-stream', {});
          }));
        } catch (e) { console.warn('Stream cycle shortcut register failed:', e); }
      }

      if (overlayPassthroughKey) {
        try {
          await register(mapKey(overlayPassthroughKey), onEdge((pressed) => {
            if (pressed) emit('specter://overlay-passthrough', {});
          }));
        } catch (e) { console.warn('Overlay passthrough shortcut register failed:', e); }
      }
    };

    setup();

    const onStorage = (e) => {
      if (['specter_ptt_key', 'specter_channel_toggle_key', 'specter_voice_mode', 'specter_stream_next_key', 'specter_overlay_passthrough_key'].includes(e.key)) {
        setup();
      }
    };
    window.addEventListener('storage', onStorage);

    return () => {
      disposed = true;
      window.removeEventListener('storage', onStorage);
      import('@tauri-apps/plugin-global-shortcut')
        .then(({ unregisterAll }) => unregisterAll())
        .catch(() => {});
    };
  }, []);

  // ── Bootstrap: load user's orgs & friends ──────────────────────────────────
  useEffect(() => {
    api.getMyOrgs().then(({ data }) => {
      const list = data?.orgs || [];
      setOrgs(list);
      // Restore saved server-tab drag order
      try {
        const saved = JSON.parse(localStorage.getItem('specter_org_order') || '[]');
        const ordered = [
          ...saved.map(id => list.find(o => o.id === id)).filter(Boolean),
          ...list.filter(o => !saved.includes(o.id)),
        ];
        setOrgOrder(ordered.length ? ordered : list);
      } catch { setOrgOrder(list); }
      if (list.length > 0) {
        const savedOrgId = localStorage.getItem(LAST_SELECTED_ORG_KEY);
        const target = initialConnectOrgId
          ? (list.find(o => o.id === initialConnectOrgId) ?? list[0])
          : savedOrgId
            ? (list.find(o => o.id === savedOrgId) ?? list[0])
            : list[0];
        setSelectedOrg(target);
      }
      setLoading(false);
    });
    api.getFriends().then(({ data }) => setFriends(data?.friends || []));
  }, []);

  // Persist server selection so a crash/restart hotloads the same server shell.
  useEffect(() => {
    if (selectedOrg?.id) localStorage.setItem(LAST_SELECTED_ORG_KEY, selectedOrg.id);
  }, [selectedOrg?.id]);

  // Tray strip <-> this window, over the app-wide `active-server-changed`
  // event ({ orgId, source }): follow a server picked in the strip, and tell
  // the strip when the selection changes here.
  const orgsForStripRef = useRef(orgs);
  orgsForStripRef.current = orgs;
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    let unlisten = null;
    let stopped = false;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('active-server-changed', (e) => {
        const { orgId, source } = e.payload || {};
        if (!orgId || source === 'main') return;
        const org = orgsForStripRef.current.find(o => o.id === orgId);
        if (org) setSelectedOrg(org);
        else localStorage.setItem(LAST_SELECTED_ORG_KEY, orgId); // orgs not loaded yet: bootstrap picks it up
      }))
      .then((fn) => { if (stopped) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { stopped = true; if (unlisten) unlisten(); };
  }, []);
  useEffect(() => {
    if (!selectedOrg?.id || !window.__TAURI_INTERNALS__) return;
    import('@tauri-apps/api/event')
      .then(({ emit }) => emit('active-server-changed', { orgId: selectedOrg.id, source: 'main' }))
      .catch(() => {});
  }, [selectedOrg?.id]);

  // ── Real-time event stream ─────────────────────────────────────────────────
  const refreshOrgs = useCallback(() => {
    api.getMyOrgs().then(({ data }) => {
      const list = data?.orgs || [];
      setOrgs(list);
      // Refresh selectedOrg from the new list so fields like tier reflect the latest DB state.
      if (selectedOrg) {
        const fresh = list.find(o => o.id === selectedOrg.id);
        setSelectedOrg(fresh || list[0] || null);
      } else if (list.length > 0) {
        const savedOrgId = localStorage.getItem(LAST_SELECTED_ORG_KEY);
        const target = savedOrgId ? (list.find(o => o.id === savedOrgId) ?? list[0]) : list[0];
        setSelectedOrg(target);
      }
      // Maintain drag order
      setOrgOrder(prev => {
        const ids = prev.map(o => o.id);
        return [
          ...ids.map(id => list.find(o => o.id === id)).filter(Boolean),
          ...list.filter(o => !ids.includes(o.id)),
        ];
      });
    });
  }, [selectedOrg]);

  const refreshMembers = useCallback(() => {
    if (!selectedOrg) return;
    api.getOrgMembers(selectedOrg.id).then(({ data }) => setMembers(data?.members || []));
  }, [selectedOrg?.id]);

  const refreshChannelsCb = useCallback(() => {
    if (!selectedOrg) return;
    api.getChannels(selectedOrg.id).then(({ data, error }) => {
      if (!error) {
        const chs = data?.channels || [];
        setChannels(chs);
        // Seed channel presence from the initial list (occupants attached by backend)
        const presMap = {};
        for (const ch of chs) {
          if (Array.isArray(ch.occupants)) presMap[ch.id] = ch.occupants;
        }
        setChannelPresence(presMap);
      }
    });
  }, [selectedOrg?.id]);

  // If we're browsing a server without joining comms, periodically refresh
  // channel occupant snapshots to clear stale "active in channel" indicators
  // after crashes or abrupt exits that can miss a realtime leave event.
  useEffect(() => {
    if (!selectedOrg || inComms) return;
    const id = setInterval(() => {
      refreshChannelsCb();
    }, 15000);
    return () => clearInterval(id);
  }, [selectedOrg?.id, inComms, refreshChannelsCb]);

  // Fetch + sort shared by refreshEventsCb and the server-switch reset below.
  // Deliberately ungated: the server-switch load has always run for every
  // member (getOrgEvents only checks membership, and `events` also drives
  // activeOp / op-channel UI), while refreshEventsCb keeps its calendar gate.
  const loadEvents = useCallback((orgId) => {
    api.getOrgEvents(orgId).then(({ data }) => {
      const evs = (data?.events || []).sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
      setEvents(evs);
    });
  }, []);

  const refreshEventsCb = useCallback(() => {
    if (!selectedOrg) return;
    const hasCalendarAccess = selectedOrg?.owner_id === user?.id
      || selectedOrg?.permissions?.can_view_calendar === true
      || selectedOrg?.permissions?.can_create_events === true;
    if (!hasCalendarAccess) return;
    loadEvents(selectedOrg.id);
  }, [selectedOrg?.id, selectedOrg?.owner_id, selectedOrg?.permissions, user?.id, loadEvents]);

  // Re-render once when the next op crosses a badge / "Now & soon" boundary
  // (enters 24h or 30min, starts, ends) instead of polling on an interval.
  useEffect(() => {
    const ms = msUntilNextOpsChange(events);
    if (ms == null) return;
    // Cap at 1h: setTimeout overflows past ~24.8 days, and a periodic
    // re-check is harmless.
    const id = setTimeout(() => setOpsClock(c => c + 1), Math.min(ms, 3600 * 1000));
    return () => clearTimeout(id);
  }, [events, opsClock]);

  // Hangar's ship list stays inside Settings (a narrow column is fine for
  // rows), but opening a ship escapes to the main content pane as ShipEditor
  // — see Hangar.jsx's onOpenShip prop. editingShip has to live here (not in
  // Hangar) because ShipEditor's onUpdate needs the freshly-patched ship back
  // on every call (seat-lock/loadout-override edits read from the `ship`
  // prop each render), and Hangar unmounts while the editor is open.
  const handleOpenShip = (ship) => setEditingShip(ship);
  const updateShip = async (id, patch) => {
    const { data, error } = await api.updateHangarShip(id, patch);
    if (!error) setEditingShip(prev => (prev && prev.id === id) ? data.ship : prev);
  };

  // Shared by scheduleEventStartPrompts' local timer and the event_launched SSE
  // handler below, so a user whose join prompt fires from the local
  // start-time timer (rather than receiving the launch SSE live) still gets
  // monitor/frequency access populated. Kept component-scoped (not
  // module-level) since it closes over several setState setters.
  const applyEventAssignmentExtras = useCallback((eventId, eventName, a, all) => {
    traceLog(`applyEventAssignmentExtras eventId=${eventId} a.launched=${a?.launched} a.channel_id=${a?.channel_id} freqCount=${(a?.frequencies || []).length}`);
    const access = {};
    for (const row of all) {
      if (row?.channel_id) access[row.channel_id] = true;
      for (const mc of (row?.monitor_channels || [])) {
        if (mc?.channel_id) access[mc.channel_id] = true;
      }
    }
    if (Object.keys(access).length) {
      setEventChannelAccess(prev => ({ ...prev, ...access }));
    }

    if (!a || !a.channel_id || a.launched === false) {
      traceLog(`applyEventAssignmentExtras eventId=${eventId} EARLY RETURN (no assignment or not launched)`);
      return;
    }

    setIsOpCommander(!!a.is_op_commander);
    setJoinBanner({
      eventId,
      eventName,
      channel: { id: a.channel_id, name: a.channel_name, channel_kind: 0 },
      group_name: a.group_name,
      role: a.role,
      commander_callsign: a.commander_callsign,
    });

    // Monitor channels: other accepted group assignments for this user. (A role
    // monitoring extra *group* channels via channel_group_ids was a separate,
    // never-wired-to-any-UI feature — removed; this is the one still-legitimate
    // source of "monitor" channels.)
    const secondaryChannels = all.slice(1)
      .filter(ag => ag.channel_id && ag.channel_id !== a.channel_id)
      .map(ag => ({ id: ag.channel_id, name: ag.channel_name, channel_kind: 0 }));
    if (secondaryChannels.length > 0) setMonitorChannels(secondaryChannels);

    // Available liaison frequencies for this user
    const freqs = (a.frequencies || [])
      .filter(f => f && f.channel_id)
      .filter((f, idx, arr) => arr.findIndex(x => x.channel_id === f.channel_id) === idx);
    traceLog(`applyEventAssignmentExtras eventId=${eventId} setting availableFreqs (count=${freqs.length}) + activeFreqIdx=0 + monitorChannels (count=${secondaryChannels.length})`);
    setAvailableFreqs(freqs);
    setActiveFreqIdx(0);
  }, []);

  const scheduleEventStartPrompts = useCallback(() => {
    if (!selectedOrg?.id || !user?.id) return;
    for (const t of Object.values(eventPromptTimersRef.current)) clearTimeout(t);
    eventPromptTimersRef.current = {};

    const nowMs = Date.now();
    for (const ev of (events || [])) {
      if (!ev?.id || !ev?.start_time) continue;
      const startMs = new Date(ev.start_time).getTime();
      if (!Number.isFinite(startMs) || startMs <= nowMs) continue;

      eventPromptTimersRef.current[ev.id] = setTimeout(async () => {
        try {
          const { data } = await api.getMyEventAssignment(selectedOrg.id, ev.id);
          const a = data?.assignment;
          const all = data?.assignments || (a ? [a] : []);
          applyEventAssignmentExtras(ev.id, ev.name, a, all);
        } catch {}
      }, Math.max(0, startMs - Date.now()));
    }
  }, [selectedOrg?.id, user?.id, events, applyEventAssignmentExtras]);

  useEffect(() => {
    scheduleEventStartPrompts();
    return () => {
      for (const t of Object.values(eventPromptTimersRef.current)) clearTimeout(t);
      eventPromptTimersRef.current = {};
    };
  }, [scheduleEventStartPrompts]);

  // Rule shared with the tray strip — see utils/opsPermissions.
  const canLaunchEvent = useCallback((ev) => canLaunchOp(selectedOrg, user, ev), [selectedOrg, user]);

  const handleLaunchFromCard = useCallback(async (ev) => {
    if (!selectedOrg) return;
    if (!canLaunchEvent(ev)) return;
    const { error } = await api.launchEvent(selectedOrg.id, ev.id);
    if (!error) refreshEventsCb();
  }, [selectedOrg?.id, refreshEventsCb, canLaunchEvent]);

  // ── P2A: strip chat subscription + unread counts (engine/unreadStore.js) ──
  // stripChatChannelId: the text channel the strip is showing (text.select),
  // which is always read. Counts are kept in a ref (the source of truth,
  // updated synchronously per relay) mirrored into state for the bridge.
  const [stripChatChannelId, setStripChatChannelId] = useState(null);
  const [stripChatSeq, setStripChatSeq] = useState(0);
  const stripChatChannelRef = useRef(null);
  // MR2: per account (unreadStore keys by user id).
  const unreadUserId = user?.id ?? null;
  const unreadRef = useRef(null);
  const unreadForRef = useRef(undefined);
  if (unreadForRef.current !== unreadUserId) {
    unreadForRef.current = unreadUserId;
    unreadRef.current = loadUnread(unreadUserId);
  }
  const [unreadCounts, setUnreadCounts] = useState(() => unreadRef.current.counts);
  useEffect(() => { setUnreadCounts(unreadRef.current.counts); }, [unreadUserId]);
  const commitUnread = useCallback((next) => {
    if (next === unreadRef.current) return;
    unreadRef.current = next;
    saveUnread(next, unreadForRef.current);
    setUnreadCounts(next.counts);
  }, []);
  const noteUnreadRelay = (payload) => {
    commitUnread(countRelay(unreadRef.current, payload, { userId: user?.id, viewingChannelId: stripChatChannelRef.current }));
    // Reading along: keep lastRead current for the channel being shown.
    if (payload?.channel_id && payload.channel_id === stripChatChannelRef.current) {
      commitUnread(markUnreadRead(unreadRef.current, payload.channel_id));
    }
  };
  useEffect(() => {
    // App.jsx's message-cache drain may add counts after this mounted.
    const reload = () => { unreadRef.current = loadUnread(unreadForRef.current); setUnreadCounts(unreadRef.current.counts); };
    window.addEventListener(UNREAD_CHANGED_EVENT, reload);
    return () => window.removeEventListener(UNREAD_CHANGED_EVENT, reload);
  }, []);

  useEventStream({
    // Org list changed (created, joined, kicked, dissolved)
    orgs_changed:     refreshOrgs,
    org_created:      refreshOrgs,
    // SSE stream just connected — refresh org list in case the initial fetch raced with startup,
    // and (MR2) ask peers for anything missed while disconnected, on every server.
    connected:        () => { refreshOrgs(); _textChatResyncRef.current?.(); },
    // Org-scoped events for the currently selected org
    channel_created:  refreshChannelsCb,
    channel_deleted:  refreshChannelsCb,
    member_joined:    refreshMembers,
    member_removed:   refreshMembers,
    member_updated:   refreshMembers,
    role_created:     refreshMembers,
    role_updated:     refreshMembers,
    role_deleted:     refreshMembers,
    event_launched:   (payload) => {
      refreshEventsCb();
      refreshChannelsCb();
      // Always show a toast when any operation launches
      const evName = events.find(e => e.id === payload?.eventId)?.name;
      pushNotif('op_launch', 'OPERATION LAUNCHED', evName ? `"${evName}" has gone live` : 'Channels are being created');
      // Check if this user has an assignment in the launched event
      if (!selectedOrg || !payload?.eventId) return;
      api.getMyEventAssignment(selectedOrg.id, payload.eventId).then(({ data }) => {
        const a = data?.assignment;
        const all = data?.assignments || (a ? [a] : []);
        applyEventAssignmentExtras(payload.eventId, evName, a, all);
      }).catch(() => {});
    },
    // A planner edited the roster/roles after launch (or before — harmless
    // no-op then, since there's nothing to re-apply until launched) — refetch
    // this user's assignment so already-online, already-launched users pick up
    // new role/frequency access live instead of needing a manual refresh.
    event_roster_changed: (payload) => {
      if (!selectedOrg || !payload?.event_id) return;
      // Refresh the general events list unconditionally — this is what drives
      // filled_slots/total_slots on calendar cards, the Active Operations
      // banner, and the scheduled-ops list for EVERY viewer, not just whoever
      // just joined/left. Previously this only ran the launched-only
      // assignment refetch below, so slot counts never hot-updated for anyone
      // just watching the calendar.
      refreshEventsCb();
      const ev = events.find(e => e.id === payload.event_id);
      traceLog(`event_roster_changed event_id=${payload.event_id} local-cached ev.launched=${ev?.launched}`);
      if (!ev?.launched) return;
      // Lazily reconcile the event's voice-cascade MLS group (see
      // mlsSession.js's ensureEventGroup doc comment) — same "propagates the
      // next time anyone's client happens to notice" design as
      // ensureChannelGroup, just triggered by this roster-change signal
      // instead of only on channel-open, since a priority speaker's cascade
      // key needs to be current for whoever's already in-call, not just
      // whoever opens the channel next.
      ensureEventGroup(api, user?.id, selectedOrg.id, payload.event_id).catch(() => {});
      // EVMLS: event channels' MLS groups hold only the event's signed-up
      // audience (ensureChannelGroup → /mls/members), so an accept / leave /
      // role change must rotate them now, not on the next channel open:
      // reconcile the event channels this client is using — its group
      // channel and its frequencies (LEADFREQ: the Leadership net included).
      // Sequential; ensureChannelGroup goes through mlsSession's queue.
      {
        const orgIdForMls = selectedOrg.id;
        const evChannelIds = new Set([
          voiceChannel?.event_id === payload.event_id ? voiceChannel.id : null,
          ...(freqCycleRef.current.availableFreqs || []).map(f => f.channel_id),
        ].filter(Boolean));
        (async () => {
          for (const chanId of evChannelIds) {
            try { await ensureChannelGroup(api, user?.id, orgIdForMls, chanId); } catch { /* retried on the next roster change / channel open */ }
          }
        })();
      }
      api.getMyEventAssignment(selectedOrg.id, payload.event_id).then(({ data }) => {
        const a = data?.assignment;
        const all = data?.assignments || (a ? [a] : []);
        applyEventAssignmentExtras(payload.event_id, ev.name, a, all);
      }).catch(() => {});
    },
    operation_ended:  (payload) => {
      traceLog(`operation_ended eventId=${payload?.eventId} mode=${payload?.mode} target=${payload?.target_channel_id} — before: voiceChannel.id=${voiceChannel?.id} activeFreqIdx=${activeFreqIdx} availableFreqs.length=${availableFreqs.length}`);
      // Operation has ended — refresh events + channels
      refreshEventsCb();
      refreshChannelsCb();
      setJoinBanner(null);
      setEndOpModal(false);
      setIsOpCommander(false);
      // Server has already moved subscriptions.  Navigate the local client to
      // the target channel (lobby or debrief), or disconnect if none.
      if (payload?.target_channel_id) {
        const moveName = payload.target_channel_name || payload.target_channel_id;
        const modeName = payload.mode === 'debrief' ? 'DEBRIEF' : 'LOBBY';
        pushNotif('op_end', 'OPERATION ENDED', `Moving to ${modeName}: ${moveName}`);
        setChannels(prev => {
          // Channel list may not yet include the debrief channel — fall back to
          // a stub so CommLink can connect; refreshChannelsCb will fill it in.
          const destCh = prev.find(c => c.id === payload.target_channel_id)
            || { id: payload.target_channel_id, name: moveName, channel_kind: 0 };
          setActiveChannel(destCh);
          setVoiceChannel(destCh);
          setInComms(true);
          return prev;
        });
        setMonitorChannels([]);
        setAvailableFreqs([]); setActiveFreqIdx(0);
      } else {
        pushNotif('op_end', 'OPERATION ENDED', 'You have been disconnected from op channels');
        setInComms(false);
        setVoiceChannel(null);
        setVoiceRoster([]);
        setMonitorChannels([]);
        setAvailableFreqs([]); setActiveFreqIdx(0);
      }
    },
    dm_received: (payload) => {
      // Only show notification if not already in DM with this person
      if (payload?.from_user_id) {
        setDmNotif(prev => {
          if (prev?.from_user_id === payload.from_user_id)
            return { ...prev, count: (prev.count || 0) + 1 };
          return { from_user_id: payload.from_user_id, from_callsign: payload.from_callsign, count: 1 };
        });
      }
    },
    message_relay: (payload) => {
      noteUnreadRelay(payload); // P2A: unread badges in the strip
      _textChatRelayRef.current?.(payload);
      _dmCabinetRelayRef.current?.(payload);
      commLinkRelayRef.current?.(payload);
    },
    // Peer backfill sync (see messageStore.js / messageController.ts) — these
    // were previously unwired here, so TextChat/DmCabinet's carefully
    // registered _*SyncRequestRef/_*SyncResponseRef were never invoked and
    // the "ask peers for anything I missed" mechanism never actually ran.
    sync_request: (payload) => {
      _textChatSyncRequestRef.current?.(payload);
    },
    sync_response: (payload) => {
      _textChatSyncResponseRef.current?.(payload);
    },
    // MR2: DM backfill (flat: conversation_id, requester_id, since /
    // conversation_id, relayed_by, bundle, count).
    dm_sync_request: (payload) => {
      _dmCabinetSyncRequestRef.current?.(payload);
    },
    dm_sync_response: (payload) => {
      _dmCabinetSyncResponseRef.current?.(payload);
    },
    // MR2: a member of one of my servers asks for channel history (any
    // channel, org-wide) — answered from local history, re-encrypted.
    org_sync_request: (payload) => {
      channelChatOrgSyncRequestRef.current?.(payload);
    },
    // MLS group-management traffic (see mlsGroupController.ts's submitDmCommit) —
    // handled globally, not just while the relevant DM is open, since a
    // Commit/Welcome can arrive for a conversation the user isn't currently
    // viewing. Both handlers are no-ops when not actionable for this device
    // (see mlsSession.js's handleDmCommit/handleDmWelcome doc comments).
    mls_commit: (payload) => {
      if (payload?.conversation_id && payload?.commit) {
        handleDmCommit(api, user?.id, payload.conversation_id, payload.commit).catch(() => {});
      } else if (payload?.channel_id && payload?.commit) {
        handleChannelCommit(api, user?.id, payload.channel_id, payload.commit)
          .then(() => {
            // If this is the channel CommLink currently has open, its cached
            // SFrameCrypto key is now stale — re-derive, or video/audio
            // to/from anyone added/removed by this commit silently fails to
            // decrypt for the rest of the session (see CommLink.jsx's Join
            // handler).
            if (payload.channel_id === activeCommChannelIdRef.current) commLinkMlsCommitRef.current?.();
            // Monitored channels (useMonitorChannel) hold their own relay-mode
            // audio key for this channel — same staleness, separate hook.
            notifyGroupKeyChange(payload.channel_id);
          })
          // .catch last, not before .then: with it first, a genuine
          // handleChannelCommit failure was swallowed and the .then still ran,
          // and anything the .then itself threw became an unhandled rejection
          // with nothing left to catch it.
          .catch(() => {});
      } else if (payload?.event_group_id && payload?.commit) {
        handleEventGroupCommit(api, user?.id, payload.event_group_id, payload.commit)
          .then(() => notifyGroupKeyChange(payload.event_group_id))
          .catch(() => {});
      }
    },
    mls_welcome: (payload) => {
      if (payload?.conversation_id && payload?.welcome) {
        handleDmWelcome(api, user?.id, payload.conversation_id, payload.welcome).catch(() => {});
      } else if (payload?.channel_id && payload?.welcome) {
        handleChannelWelcome(api, user?.id, payload.channel_id, payload.welcome)
          .then(() => {
            if (payload.channel_id === activeCommChannelIdRef.current) commLinkMlsCommitRef.current?.();
            notifyGroupKeyChange(payload.channel_id);
          })
          .catch(() => {});
      } else if (payload?.event_group_id && payload?.welcome) {
        handleEventGroupWelcome(api, user?.id, payload.event_group_id, payload.welcome)
          .then(() => notifyGroupKeyChange(payload.event_group_id))
          .catch(() => {});
      }
    },
    // Real-time channel occupant presence
    channel_presence_changed: (payload) => {
      if (payload?.channelId) {
        setChannelPresence(prev => ({ ...prev, [payload.channelId]: payload.occupants || [] }));
      }
    },
  });

  // ── Persist / restore voice channel across page reloads ──────────────────
  // Save whenever the user joins or leaves a channel.
  useEffect(() => {
    if (inComms && voiceChannel && selectedOrg) {
      sessionStorage.setItem('specter_voice_resume', JSON.stringify({
        orgId: selectedOrg.id,
        channelId: voiceChannel.id,
      }));
    } else {
      sessionStorage.removeItem('specter_voice_resume');
    }
  }, [inComms, voiceChannel?.id, selectedOrg?.id]);

  // ── Reload org data when selection changes ─────────────────────────────────
  useEffect(() => {
    if (!selectedOrg) return;
    for (const t of Object.values(eventPromptTimersRef.current)) clearTimeout(t);
    eventPromptTimersRef.current = {};
    setEvents([]);
    setMembers([]);
    setChannels([]);
    setActiveChannel(null);
    setVoiceChannel(null);
    setInComms(false);
    setMonitorChannels([]);
    setAvailableFreqs([]); setActiveFreqIdx(0);
    setIsOpCommander(false);
    setVoiceRoster([]);
    setLocalSpeaking(false);
    setLocalAudioLevel(0);
    setRemoteLevels({});
    setVoiceMuted(true);
    setVoiceSharing(false);
    setProfileModalUser(null);
    // OPERATIONS is the default view when landing on a server — keep this in
    // sync with the OPERATIONS pill's highlighted state (see opsViewOpen
    // useState above) so the pill and the content shown never disagree.
    setOpsViewOpen(true);
    setActiveSharers([]);
    setWatchTarget(null);
    setChannelPresence({});
    setOrgBilling(null);
    setBillingPanelOpen(false);
    setEventChannelAccess({});

    loadEvents(selectedOrg.id);
    api.getOrgMembers(selectedOrg.id).then(({ data }) => setMembers(data?.members || []));
    api.getOrgBilling(selectedOrg.id).then(({ data }) => { if (data) setOrgBilling(data); });
    api.getChannels(selectedOrg.id).then(({ data, error }) => {
      if (error) return;
      const chans = data?.channels || [];
      setChannels(chans);
      // Seed channel presence from the server's current occupant snapshot
      const presMap = {};
      for (const ch of chans) {
        if (Array.isArray(ch.occupants)) presMap[ch.id] = ch.occupants;
      }
      setChannelPresence(presMap);
      // Restore voice channel if user refreshed while connected
      try {
        const saved = JSON.parse(sessionStorage.getItem('specter_voice_resume') || 'null');
        if (saved && saved.orgId === selectedOrg.id) {
          const ch = chans.find(c => c.id === saved.channelId);
          if (ch) {
            setVoiceChannel(ch);
            setActiveChannel(ch);
            setInComms(true);
          }
        }
      } catch {}
    });
  }, [selectedOrg?.id, loadEvents]);

  // ── Derive active operation ────────────────────────────────────────────────
  const now = new Date();
  const activeOp =
    events.find(e => new Date(e.start_time) <= now && (!e.end_time || new Date(e.end_time) >= now)) ||
    events.find(e => new Date(e.start_time) > now);

  // ── Permission helpers ─────────────────────────────────────────────────────
  const isCommander = selectedOrg?.role_name === 'Commander' || selectedOrg?.owner_id === user?.id
    || selectedOrg?.permissions?.can_manage_channels === true;
  // Per-action moderation gates — match the server's actual permission keys
  // (checkModerationPermission in modController.ts) rather than the blanket
  // isCommander flag, so a role with only some mod permissions doesn't see
  // buttons for actions the server will reject.
  const canKickMembers = selectedOrg?.owner_id === user?.id || selectedOrg?.permissions?.can_kick === true;
  const canBanMembers = selectedOrg?.owner_id === user?.id || selectedOrg?.permissions?.can_ban === true;
  const canMuteMembers = selectedOrg?.owner_id === user?.id || selectedOrg?.permissions?.can_mute === true;
  // Op gates shared with the tray strip (utils/opsPermissions).
  const canViewCalendar = canViewOpsCalendar(selectedOrg, user);
  // can schedule = org admin, or role explicitly granted create-events permission
  const canScheduleEvents = canScheduleOps(selectedOrg, user);
  // can access server settings panel = full admin OR any moderation permission
  const canAccessSettings = isCommander
    || selectedOrg?.permissions?.can_manage_roles === true
    || selectedOrg?.permissions?.can_manage_channels === true
    || selectedOrg?.permissions?.can_kick === true
    || selectedOrg?.permissions?.can_ban === true
    || selectedOrg?.permissions?.can_mute === true;
  const canEditOperationEvent = useCallback((ev) => canEditOp(selectedOrg, user, ev), [selectedOrg, user]);
  const handleOpenEventComp = useCallback((ev) => {
    if (!ev) return;
    setGroupCompEvent(ev);
    setOpsViewOpen(false);
  }, []);

  // ── Server tab drag-and-drop ──────────────────────────────────────────────
  const handleDragStart = (i) => setDragIdx(i);
  const handleDragOver  = (e, i) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === i) return;
    const next = [...orgOrder];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(i, 0, moved);
    setDragIdx(i);
    setOrgOrder(next);
  };
  const handleDragEnd = () => {
    localStorage.setItem('specter_org_order', JSON.stringify(orgOrder.map(o => o.id)));
    setDragIdx(null);
  };

  // ── Channel CRUD ───────────────────────────────────────────────────────────
  const refreshChannels = () =>
    api.getChannels(selectedOrg.id).then(({ data, error }) => {
      if (!error) setChannels(data?.channels || []);
    });

  const handleCreateChannel = async (e) => {
    e.preventDefault();
    if (!newChanName.trim() || !selectedOrg) return;
    setChanCreateLoading(true);
    setChanCreateError(null);
    const { error } = await api.createChannel(selectedOrg.id, { name: newChanName.trim(), kind: newChanKind });
    setChanCreateLoading(false);
    if (!error) {
      setNewChanName('');
      setShowCreateChan(false);
      refreshChannels();
    } else {
      setChanCreateError(error);
    }
  };

  const handleDeleteChannel = async (chanId) => {
    if (!confirm('Delete this channel?')) return;
    await api.deleteChannel(selectedOrg.id, chanId);
    if (activeChannel?.id === chanId) setActiveChannel(null);
    refreshChannels();
  };

  // ── Voice join / leave ─────────────────────────────────────────────────────
  // What the sidebar's voice row and Disconnect button do; also run by the
  // strip bridge (voice.join / voice.leave below).
  const joinVoiceChannel = (ch) => {
    setActiveChannel(ch);
    if (!(inComms && voiceChannel?.id === ch.id)) {
      setVoiceChannel(ch);
      setInComms(true);
    }
  };
  const leaveVoice = () => {
    setInComms(false); setVoiceChannel(null); setVoiceRoster([]); setMonitorChannels([]); setAvailableFreqs([]); setActiveFreqIdx(0);
  };

  // ── If in full comms view ──────────────────────────────────────────────────
  // CommLink is now embedded in the center panel — no full-screen takeover.

  // ── Overlay mode: compact HUD replaces the full UI ──────────────────────
  // CommLink rendered ONCE inside the normal layout so it never unmounts when
  // toggling overlay.  The normal layout is hidden via display:none during
  // overlay mode, but CommLink's WebTransport + audio pipeline keep running.
  const commLinkVisible = !(activeChannel && (activeChannel.channel_kind ?? 0) === 1);
  const isLocalOverlayActive = (() => {
    if (!isOverlay || !window.__TAURI__) return false;
    try {
      return localStorage.getItem('specter_overlay_safe_mode') === '1' || overlayFallbackActive;
    } catch {
      return overlayFallbackActive;
    }
  })();
  // Index of the selected server in the list — picks its HexBadge colour.
  const selectedOrgIdx = selectedOrg ? orgs.findIndex(o => o.id === selectedOrg.id) : -1;

  // ── Strip bridge (src/engine/bridge.js) ─────────────────────────────────
  // This window is the hidden engine; the tray strip is the UI. Publish the
  // state the strip needs and run its commands through the same handlers the
  // sidebar uses. Nothing here has voice/overlay logic of its own.
  const localCallsignForBridge = user?.callsign || user?.username || null;
  // The local-HUD "safe mode" renders inside this (hidden) window, so the
  // strip can't use the overlay while it's on.
  const overlaySafeModeForBridge = (() => {
    try { return localStorage.getItem('specter_overlay_safe_mode') === '1' || overlayFallbackActive; } catch { return overlayFallbackActive; }
  })();
  // P2A: the one channel-chat instance (see engine/useChannelChat.js) — for
  // the text channel the engine has open, which is the strip's chat while it
  // has one subscribed (text.select sets activeChannel).
  const textChannelForChat = activeChannel && (activeChannel.channel_kind ?? 0) === 1 ? activeChannel : null;
  const channelChat = useChannelChat({ orgId: selectedOrg?.id, channel: textChannelForChat, user });
  // MR2: engine start / server joined → heal encryption, retry what waited
  // for a key, catch up every channel (useChannelChat's startOrgSync; each
  // server once, sequentially). Left servers are forgotten.
  const orgIdsKey = orgs.map(o => o.id).sort().join(',');
  useEffect(() => {
    if (!user?.id) return;
    const ids = orgIdsKey ? orgIdsKey.split(',') : [];
    forgetOrgs(ids);
    startOrgSync(ids);
  }, [user?.id, orgIdsKey]);
  // Publish that channel's rows to the strip while it's subscribed to it.
  useEffect(() => {
    if (!stripChatChannelId || channelChat.channelId !== stripChatChannelId) return;
    const apiBase = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) || 'http://localhost:8082';
    const rows = buildChatRows(channelChat.messages, {
      userId: user?.id,
      resolveImageUrl: (url) => (url.startsWith('http') ? url : `${apiBase}${url}`),
    });
    bridgeEmit(STRIP_WINDOW, EV.CHAT, { channelId: stripChatChannelId, loading: channelChat.loading, rows })
      .catch((err) => console.warn('[bridge] engine-chat emit failed:', err));
  }, [stripChatChannelId, stripChatSeq, channelChat.channelId, channelChat.messages, channelChat.loading, user?.id]);

  const bridgeState = buildEngineState({
    user, org: selectedOrg, canManageChannels: isCommander, channels, channelPresence,
    inComms, voiceChannel, voiceStatus, voiceMuted, voiceSharing, voiceRoster,
    voiceE2e, // E2EV
    activeSharers, watchTarget, isOverlay, overlaySafeMode: overlaySafeModeForBridge, activeChannel,
    unread: unreadCounts, canShare: nativeCaptureAvailable(),
    stripViewer, // SV
    freqs: availableFreqs, activeFreqIdx, monitorStatus, // LEADFREQ
  });
  const findBridgeChannel = (channelId, kind) => {
    const ch = channels.find(c => c.id === channelId);
    if (!ch || ((ch.channel_kind ?? 0) === 1 ? 'text' : 'voice') !== kind) throw new Error('That channel no longer exists');
    return ch;
  };
  useEngineBridgeHost({
    state: bridgeState,
    inVoice: Boolean(inComms && voiceChannel),
    getLevels: () => buildLevelsFrame({
      callsign: localCallsignForBridge, localSpeaking, localLevel: localAudioLevel, voiceMuted, remoteLevels,
    }),
    handlers: {
      [CMD.SERVER_SELECT]: ({ orgId }) => {
        if (selectedOrg?.id === orgId) return;
        const org = orgs.find(o => o.id === orgId);
        if (!org) throw new Error('Unknown server');
        setSelectedOrg(org);
      },
      [CMD.VOICE_JOIN]: ({ channelId }) => { joinVoiceChannel(findBridgeChannel(channelId, 'voice')); },
      [CMD.VOICE_LEAVE]: () => { if (inComms) leaveVoice(); },
      [CMD.VOICE_SET_MUTED]: async ({ muted }) => {
        if (!inComms) throw new Error('Not in a voice channel');
        if (Boolean(voiceMuted) === Boolean(muted)) return;
        const toggle = commLinkActionsRef.current?.toggleMic;
        if (!toggle) throw new Error('Voice is still connecting');
        // CommLink reports a mic failure through its own state, which comes
        // back to the strip as state.voice.muted staying put.
        await toggle();
      },
      [CMD.VOICE_SET_DEAFENED]: () => { throw new Error('Deafen is not available yet'); },
      // P2A: text.select is the strip's chat subscription (null = closed).
      // The channel being shown is read (and stays read while shown).
      [CMD.TEXT_SELECT]: ({ channelId }) => {
        const prev = stripChatChannelRef.current;
        if (prev) commitUnread(markUnreadRead(unreadRef.current, prev));
        if (!channelId) {
          stripChatChannelRef.current = null;
          setStripChatChannelId(null);
          return;
        }
        const ch = findBridgeChannel(channelId, 'text');
        stripChatChannelRef.current = ch.id;
        commitUnread(markUnreadRead(unreadRef.current, ch.id));
        if (activeChannel?.id !== ch.id) setActiveChannel(ch);
        setStripChatChannelId(ch.id);
        setStripChatSeq((n) => n + 1); // re-send rows even if nothing changed
      },
      // MR2: force-heal every encryption group of a server, then catch up.
      [CMD.SERVER_RESYNC_ENCRYPTION]: async ({ orgId }) => {
        const id = orgId || selectedOrg?.id;
        if (!id || !orgs.some(o => o.id === id)) throw new Error('Unknown server');
        return resyncOrgEncryption(id);
      },
      [CMD.CHAT_SEND]: async ({ channelId, text }) => {
        const ch = findBridgeChannel(channelId, 'text');
        const msg = await channelChat.send(text, ch);
        return { id: msg.id, timestamp: msg.timestamp };
      },
      [CMD.OVERLAY_OPEN]: async () => {
        if (overlaySafeModeForBridge) throw new Error('The overlay is in safe mode; turn it off in Settings to use it from here');
        if (!isOverlay && !(await toggleOverlay())) throw new Error("The overlay couldn't open");
      },
      [CMD.SHARE_LIST_SOURCES]: async () => {
        if (!inComms) throw new Error('Join a voice channel to share your screen');
        if (!nativeCaptureAvailable()) throw new Error('Screen sharing from here needs native capture (it is switched to browser mode)');
        return { sources: await listCaptureSourcesForStrip() };
      },
      [CMD.SHARE_START]: async ({ sourceId, name }) => {
        if (!inComms) throw new Error('Join a voice channel to share your screen');
        if (voiceSharing) return;
        const start = commLinkActionsRef.current?.startScreenShare;
        if (!start) throw new Error('Voice is still connecting');
        const r = await start({ presetSource: { id: sourceId, name: name || sourceId } });
        if (r && !r.ok) throw new Error(r.error || (r.cancelled ? 'Cancelled' : 'Screen share failed'));
      },
      [CMD.SHARE_STOP]: async () => {
        if (!voiceSharing) return;
        await commLinkActionsRef.current?.stopScreenShare?.();
      },
      // S11: launch the overlay already watching a sharer. Same steps as the
      // overlay button + "Watch stream": toggleOverlay opens it, then the
      // target is set (after, so toggleOverlay's "watch my own stream"
      // default can't override it).
      [CMD.OVERLAY_WATCH]: async ({ callsign }) => {
        if (!inComms) throw new Error('Not in a voice channel');
        if (overlaySafeModeForBridge) throw new Error('The overlay is in safe mode; turn it off in Settings to use it from here');
        const sharing = activeSharers.includes(callsign) || (voiceSharing && callsign === localCallsignForBridge);
        if (!sharing) throw new Error(`${callsign} isn't sharing right now`);
        if (!isOverlay && !(await toggleOverlay())) throw new Error("The overlay couldn't open");
        setStripViewer(false); // SV: hands the stream from the strip's viewer to the overlay
        setWatchTarget(callsign);
      },
      // SV: watch a sharer in the strip's own viewer (no overlay needed).
      [CMD.STREAM_WATCH]: ({ callsign, restart }) => {
        if (!inComms) throw new Error('Not in a voice channel');
        const sharing = activeSharers.includes(callsign) || (voiceSharing && callsign === localCallsignForBridge);
        if (!sharing) throw new Error(`${callsign} isn't sharing right now`);
        if (restart && stripViewer && watchTarget === callsign) {
          commLinkActionsRef.current?.restartWatch?.();
          return;
        }
        setStripViewer(true);
        setWatchTarget(callsign);
      },
      [CMD.STREAM_STOP]: () => {
        if (!stripViewer) return;
        setStripViewer(false);
        setWatchTarget(null);
      },
      [CMD.OVERLAY_CLOSE]: async () => {
        if (isOverlay && !(await toggleOverlay())) throw new Error("The overlay couldn't close");
      },
      [CMD.CHANNELS_REFRESH]: () => { refreshChannelsCb(); },
      // LEADFREQ: pick the transmit frequency (0 = group channel), same state
      // the cycle-freq keybind steps through; the rest stay monitored.
      [CMD.VOICE_SET_FREQUENCY]: ({ index }) => {
        if (!inComms) throw new Error('Not in a voice channel');
        const i = Number(index);
        if (!Number.isInteger(i) || i < 0 || i > availableFreqs.length) throw new Error('That frequency is no longer available');
        if (i !== activeFreqIdx) setActiveFreqIdx(i);
      },
    },
  });
  // P2C: the strip's Settings cabinet reads/writes this window's settings
  // (src/engine/settingsBridge.js). Same mic-capture rule as SettingsUI.
  useSettingsBridgeHost({ micCaptureActive: inComms && !voiceMuted });

  return (
    <>
    {/* Monitor channel audio sinks — one per monitored channel (no UI, just audio hooks).
        Also passively monitors all inactive liaison frequency channels so operators hear
        every freq they have access to, not just the one they are actively transmitting on.
        When the operator is on a liaison freq (activeFreqIdx > 0), the primary voiceChannel
        is also added to the passive monitor list. */}
    {inComms && selectedOrg && voiceChannel && (() => {
      // The primary voice channel is the FOUNDATION — CommLink owns it exclusively.
      // activeFreqChannelId is what CommLink is currently transmitting on:
      //   - activeFreqIdx > 0 → a liaison frequency channel
      //   - activeFreqIdx = 0 → the primary voice channel itself
      // Both the primary and the active freq are always excluded from monitors so
      // a MonitorChannelInstance never opens a duplicate WebTransport to the same
      // channel CommLink is already connected to (which would steal the server-side
      // audio output slot and silence CommLink's audio feed).
      const activeTxChannelId = activeFreqIdx > 0
        ? (availableFreqs[activeFreqIdx - 1]?.channel_id || voiceChannel.id)
        : voiceChannel.id;
      // Inactive liaison frequencies: all freqs except the one being transmitted on
      const inactiveFreqMonitors = availableFreqs
        .filter((_, i) => i !== activeFreqIdx - 1)
        .filter(f => f.channel_id)
        .map(f => ({ id: f.channel_id, name: f.name, channel_kind: 0 }));
      // Primary group channel passively monitored when transmitting on a liaison freq
      const primaryMonitor = (activeFreqIdx > 0 && voiceChannel.id !== activeTxChannelId)
        ? [voiceChannel] : [];
      const allMonitors = [...monitorChannels, ...inactiveFreqMonitors, ...primaryMonitor]
        .filter((mc, idx, arr) => arr.findIndex(x => x.id === mc.id) === idx)
        .filter(mc => mc.id !== activeTxChannelId);   // never monitor the active TX channel
      return allMonitors.map(mc => {
        const isPassiveFreq = (availableFreqs || []).some(f => f.channel_id === mc.id)
          || (activeFreqIdx > 0 && mc.id === voiceChannel.id);
        const volume = isPassiveFreq ? passiveFreqVolume : (monitorVolumes[mc.id] ?? 0.3);
        return <MonitorChannelInstance key={mc.id} org={selectedOrg} channel={mc} volume={volume} onStatusChange={setMonitorStatusFor} />;
      });
    })()}

    {/* In-app local overlay fallback shown when native overlay is disabled or times out. */}
    {isLocalOverlayActive && (
      <div style={{ position: 'fixed', top: 8, right: 8, zIndex: 5000, pointerEvents: 'none' }}>
        <div style={{ pointerEvents: 'auto' }}>
          <GameOverlay
            voiceRoster={voiceRoster}
            localSpeaking={localSpeaking}
            activeSharers={activeSharers}
            watchTarget={watchTarget}
            user={user}
            onExitOverlay={() => setIsOverlay(false)}
            onWatchStream={setWatchTarget}
            videoCanvasRef={localOverlayCanvasRef}
            localAudioLevel={localAudioLevel}
            remoteLevels={remoteLevels}
            streamConnected={Boolean(watchTarget)}
            voiceChannelName={
              activeFreqIdx > 0
                ? (availableFreqs[activeFreqIdx - 1]?.name || null)
                : (voiceChannel?.name || null)
            }
            embedded
          />
        </div>
      </div>
    )}

    {/* END OPERATION modal */}
    {endOpModal && activeOp && selectedOrg && (
      <EndOperationModal
        event={activeOp}
        org={selectedOrg}
        onClose={() => setEndOpModal(false)}
        onEnded={() => { setEndOpModal(false); }}
      />
    )}
    {/* Holographic scan-line sweep — one fixed element, no layout impact */}
    <div className="proj-scan-line" />
    {/* Holographic room environment */}
    <img src={holoRoom} className="holo-room-bg" alt="" aria-hidden="true" />
    {/* Circuit tracery grid — subtle background texture */}
    <div className="hud-circuit-bg" />
    {/* Projection bloom — light column rising from puck */}
    <div className="holo-bloom" aria-hidden="true" />
    {/* Holo projector puck — physical anchor for the projected UI */}
    <img src={holoProjector} className="holo-projector" alt="" aria-hidden="true" />
    {/* ── Main layout ─────────────────────────────────────────────────── */}
    <div
      className="h-screen text-white font-mono flex flex-col overflow-hidden select-none hud-projected holo-viewport app-shell"
      style={{ background: 'transparent', paddingTop: window.__TAURI__ ? 28 : 0, display: isLocalOverlayActive ? 'none' : 'flex' }}
    >
      {/* ─────────────────── Main 3-column layout ─────────────────── */}
      <div className="flex flex-1 overflow-hidden bg-transparent depth-stage">

        {/* ══ LEFT: Org switcher + Channel list ══════════════════════ */}
        <aside
          className="flex flex-col overflow-hidden font-ui hud-panel-side hud-border-r bg-specter-bg-surface depth-surface depth-elev-2 panel"
          style={{ width: 240, minWidth: 240, background: 'transparent' }}
        >
          {/* Server header */}
          <div style={{ flexShrink: 0, position: 'relative' }}>
            {/* Transparent backdrop — closes picker when clicking outside */}
            {serverPickerOpen && (
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                onClick={() => setServerPickerOpen(false)}
              />
            )}

            {/* Top row: server logo + name (opens the server list) + wallet */}
            <div className="flex items-center gap-1 px-2 py-2 border-b border-specter-border-divider">
              <button
                type="button"
                onClick={() => setServerPickerOpen(o => !o)}
                aria-expanded={serverPickerOpen}
                className={cx(
                  'flex-1 min-w-0 flex items-center gap-2.5 px-1.5 py-1 rounded-ui-row text-left transition-colors hover:bg-white/5',
                  serverPickerOpen && 'bg-white/5',
                  focusRing,
                )}
              >
                <HexBadge
                  key={selectedOrg?.id || 'none'}
                  letter={(selectedOrg?.callsign || 'S')[0]}
                  colorKey={selectedOrgIdx >= 0 ? getOrgColor(selectedOrgIdx) : 'cyan'}
                  size={30}
                  imageUrl={selectedOrg?.logo_url ? `${UPLOADS_BASE_URL}${selectedOrg.logo_url}` : null}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui-base font-semibold text-specter-text-main">
                    {selectedOrg ? selectedOrg.callsign : 'Select a server'}
                  </span>
                  <span className="block truncate text-ui-xs text-specter-text-subtle">
                    {selectedOrg
                      ? (members.length > 0 ? `${members.length} member${members.length === 1 ? '' : 's'}` : 'Switch server')
                      : `${orgs.length} joined`}
                  </span>
                </span>
                <ChevronDown
                  size={16}
                  aria-hidden="true"
                  className={cx('shrink-0 text-specter-text-subtle transition-transform duration-150', serverPickerOpen && 'rotate-180')}
                />
              </button>

              {/* Wallet — opens the server billing panel when the billing UI flag is on */}
              <IconButton
                size="sm"
                icon={<Wallet size={15} />}
                label={BILLING_UI_ENABLED && orgBilling?.payments?.enabled ? 'Server wallet' : 'Server wallet — coming soon'}
                onClick={() => {
                  if (BILLING_UI_ENABLED && orgBilling?.payments?.enabled && selectedOrg) setBillingPanelOpen(true);
                }}
              />
            </div>

            {/* Billing cycle consumption bar */}
            {selectedOrg && (() => {
              const dataBytes  = orgBilling?.cycle?.bytes_out ?? 0;
              const dataLimit  = orgBilling?.tier_limits?.data_bytes ?? 1;
              const dataPct    = Math.min(100, Math.round(dataBytes / dataLimit * 100));
              const dataColor  = barColor(dataPct);
              const dataLabel  = orgBilling ? `${fmtBytes(dataBytes)} / ${fmtBytes(dataLimit)}` : '—';
              return (
                <div className="mx-2 mt-2 px-2.5 py-1.5 rounded-ui-row bg-specter-bg-deep/40 border border-specter-border-divider">
                  <div className="flex items-center justify-between gap-2 mb-1 text-ui-xs">
                    <span className="text-specter-text-subtle" style={dataColor ? { color: dataColor.label } : undefined}>Data this cycle</span>
                    <span className="font-mono tabular-nums text-specter-text-muted" style={dataColor ? { color: dataColor.label } : undefined}>{dataLabel}</span>
                  </div>
                  <div className="h-1 rounded-pill overflow-hidden bg-specter-bg-deep">
                    <div
                      className="h-full rounded-pill"
                      style={{ width: `${dataPct}%`, background: dataColor?.bar || 'linear-gradient(90deg, #0e7490, #22d3ee)', transition: 'width 0.6s' }}
                    />
                  </div>
                </div>
              );
            })()}

            {/* Server list */}
            {serverPickerOpen && (
              <div
                className={cx('absolute left-2 right-2 top-full z-[100] mt-1 p-1 max-h-[300px] overflow-y-auto rounded-ui-md', glassPanel)}
                style={{ background: 'rgba(8, 24, 40, 0.96)' }}
              >
                {loading && <div className="px-3 py-2 text-ui-sm text-specter-text-subtle">Loading…</div>}
                {orgs.map((org, i) => {
                  const col = getOrgColor(i);
                  const c = COLOR_MAP[col];
                  const isAct = selectedOrg?.id === org.id;
                  return (
                    <button
                      key={org.id}
                      type="button"
                      onClick={() => { setSelectedOrg(org); setServerPickerOpen(false); }}
                      aria-current={isAct ? 'true' : undefined}
                      className={cx(
                        'w-full flex items-center gap-2.5 px-2 py-1.5 rounded-ui-row text-left transition-colors',
                        isAct ? 'bg-specter-primary-cyan/10' : 'hover:bg-white/5',
                        focusRing,
                      )}
                    >
                      <HexBadge letter={(org.callsign || '?')[0]} colorKey={col} size={28} active={isAct} imageUrl={org.logo_url ? `${UPLOADS_BASE_URL}${org.logo_url}` : null} />
                      <span
                        className={cx('min-w-0 flex-1 truncate text-ui-sm font-medium', !isAct && 'text-specter-text-main')}
                        style={isAct ? { color: c.text } : undefined}
                      >
                        {org.callsign}
                      </span>
                      {isAct && <Check size={15} aria-label="Current server" className="shrink-0 text-specter-primary-neon" />}
                    </button>
                  );
                })}
                {!loading && orgs.length === 0 && (
                  <div className="px-3 py-2.5 text-ui-sm text-specter-text-subtle text-center">No servers joined</div>
                )}
              </div>
            )}
          </div>

          {/* ── Channel list ─────────────────────────────────────────── */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {selectedOrg ? (
              <>
                {/* Section header */}
                <div className="flex items-center justify-between pl-4 pr-2 pt-3 pb-1 flex-shrink-0">
                  <span className="text-ui-xs font-semibold text-specter-text-subtle">Channels</span>
                  <div className="flex items-center gap-0.5">
                    {canAccessSettings && (
                      <IconButton size="sm" icon={<Settings size={15} />} label="Server settings" onClick={() => setShowOrgSettings(true)} />
                    )}
                    {isCommander && (
                      <IconButton size="sm" icon={<Plus size={16} />} label="Add channel" active={showCreateChan} onClick={() => setShowCreateChan(v => !v)} />
                    )}
                  </div>
                </div>

                {/* Create channel form */}
                {showCreateChan && isCommander && (
                  <form
                    onSubmit={handleCreateChannel}
                    className="mx-2 mb-2 p-2 flex-shrink-0 space-y-2 rounded-ui-md bg-specter-bg-deep/40 border border-specter-border-divider"
                  >
                    <Input
                      autoFocus
                      value={newChanName}
                      onChange={e => setNewChanName(e.target.value)}
                      placeholder="Channel name"
                      aria-label="Channel name"
                      maxLength={32}
                      inputClassName="h-8 text-ui-sm"
                    />
                    <div className="flex gap-1 p-0.5 rounded-ui-row bg-specter-bg-deep/60 border border-specter-border-divider" role="radiogroup" aria-label="Channel type">
                      {[{ v: 0, label: 'Voice', Icon: Volume2 }, { v: 1, label: 'Text', Icon: Hash }].map(opt => (
                        <button
                          key={opt.v}
                          type="button"
                          role="radio"
                          aria-checked={newChanKind === opt.v}
                          onClick={() => setNewChanKind(opt.v)}
                          className={cx(
                            'flex-1 h-7 inline-flex items-center justify-center gap-1.5 rounded-ui-sm text-ui-sm transition-colors',
                            newChanKind === opt.v
                              ? 'bg-specter-primary-cyan/15 text-specter-primary-neon'
                              : 'text-specter-text-muted hover:text-specter-text-main hover:bg-white/5',
                            focusRing,
                          )}
                        >
                          <opt.Icon size={14} aria-hidden="true" />
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-1.5">
                      <Button type="submit" size="sm" className="flex-1" disabled={chanCreateLoading || !newChanName.trim()}>
                        {chanCreateLoading ? 'Creating…' : 'Create'}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="flex-1"
                        onClick={() => { setShowCreateChan(false); setNewChanName(''); setChanCreateError(null); }}
                      >
                        Cancel
                      </Button>
                    </div>
                    {chanCreateError && (
                      <div role="alert" className="text-ui-xs text-red-400">{chanCreateError}</div>
                    )}
                  </form>
                )}

                {/* Channel rows */}
                <div className="flex-1 overflow-y-auto px-2 pb-2">
                  {/* Voice channels */}
                  {(() => {
                    const voiceChannels = channels.filter(ch => (ch.channel_kind ?? 0) === 0);
                    const regularVoice = voiceChannels.filter(ch => !ch.event_id);
                    const eventVoice = voiceChannels.filter(ch => ch.event_id);
                    // Group event channels by event_id
                    const eventGroups = {};
                    for (const ch of eventVoice) {
                      if (!eventGroups[ch.event_id]) eventGroups[ch.event_id] = [];
                      eventGroups[ch.event_id].push(ch);
                    }
                    // Occupants listed under a voice channel you're not in
                    const renderOccupants = (chOccupants, depth = 0) => (
                      <div className="pb-0.5">
                        {chOccupants.map(u => {
                          const om = members.find(m => (m.callsign || m.username) === u);
                          const oUrl = om?.avatar_url ? `${UPLOADS_BASE_URL}${om.avatar_url}` : null;
                          return (
                            <div
                              key={u}
                              onClick={() => setProfileModalUser({ callsign: u })}
                              className="flex items-center gap-2 pr-2 py-0.5 rounded-ui-row cursor-pointer text-ui-sm text-specter-text-muted hover:text-specter-text-main hover:bg-white/5 transition-colors"
                              style={{ paddingLeft: 32 + depth * 14 }}
                            >
                              <HexBadge letter={u[0]} colorKey="blue" size={18} imageUrl={oUrl} />
                              <span className="truncate">{u}</span>
                            </div>
                          );
                        })}
                      </div>
                    );
                    // Build tree for each event group
                    const renderEventChannels = (eventChannels) => {
                      const childMap = {};
                      const roots = [];
                      for (const ch of eventChannels) {
                        if (!ch.parent_channel_id || !eventChannels.find(c => c.id === ch.parent_channel_id)) {
                          roots.push(ch);
                        } else {
                          if (!childMap[ch.parent_channel_id]) childMap[ch.parent_channel_id] = [];
                          childMap[ch.parent_channel_id].push(ch);
                        }
                      }
                      const renderNode = (ch, depth = 0) => {
                        const isJoined = inComms && voiceChannel?.id === ch.id;
                        const isActive = activeChannel?.id === ch.id || isJoined;
                        const chOccupants = channelPresence[ch.id] || [];
                        return (
                          <div key={ch.id}>
                            {renderVoiceChannel(ch, isActive, isJoined, depth, chOccupants.length)}
                            {isJoined ? renderRoster() : (chOccupants.length > 0 && renderOccupants(chOccupants, depth))}
                            {(childMap[ch.id] || []).map(child => renderNode(child, depth + 1))}
                          </div>
                        );
                      };
                      return roots.map(ch => renderNode(ch));
                    };

                    // Helper to render a voice channel row
                    const renderVoiceChannel = (ch, isActive, isJoined, depth = 0, occupantCount = 0) => (
                      <div
                        className={cx(
                          'group flex items-center gap-2 h-8 pr-1 rounded-ui-row cursor-pointer transition-colors',
                          isActive ? 'bg-specter-primary-cyan/10 text-specter-text-main' : 'text-specter-text-muted hover:bg-white/5 hover:text-specter-text-main',
                        )}
                        style={{ paddingLeft: 8 + depth * 14 }}
                        onClick={() => joinVoiceChannel(ch)}
                      >
                        <Volume2
                          size={16}
                          aria-hidden="true"
                          className={cx('shrink-0', isJoined ? 'text-emerald-400' : isActive ? 'text-specter-primary-neon' : 'text-specter-text-subtle')}
                        />
                        <span className="flex-1 truncate text-ui-base">{ch.name}</span>
                        {!isJoined && occupantCount > 0 && (
                          <span className="shrink-0 px-1 text-ui-xs tabular-nums text-specter-text-subtle" title={`${occupantCount} in channel`}>
                            {occupantCount}
                          </span>
                        )}
                        {isJoined && (
                          <IconButton
                            size="sm"
                            variant="danger"
                            className="!h-6 !w-6"
                            icon={<PhoneOff size={13} />}
                            label="Disconnect"
                            onClick={e => { e.stopPropagation(); leaveVoice(); }}
                          />
                        )}
                        {isCommander && !isJoined && (
                          <IconButton
                            size="sm"
                            variant="danger"
                            className="!h-6 !w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            icon={<Trash2 size={13} />}
                            label="Delete channel"
                            onClick={e => { e.stopPropagation(); handleDeleteChannel(ch.id); }}
                          />
                        )}
                      </div>
                    );

                    // Helper to render the roster under a joined channel
                    const renderRoster = () => {
                      const localCallsign = user?.callsign || user?.username;
                      const remoteUsers = voiceRoster.filter(r => r !== localCallsign);
                      const connecting = inComms && voiceRoster.length === 0;
                      const allUsers = connecting
                        ? (localCallsign ? [localCallsign] : [])
                        : [localCallsign, ...remoteUsers].filter(Boolean);
                      const now = Date.now();
                      return (
                        <div className="pb-1">
                          {allUsers.map(r => {
                            const isLocal = r === localCallsign;
                            const speaking = isLocal ? localSpeaking : false;
                            const isSharer = activeSharers.includes(r);
                            const remoteEntry = remoteLevels[r];
                            const remoteActive = remoteEntry && (now - remoteEntry.ts) < 400;
                            const displayLevel = isLocal ? localAudioLevel : (remoteActive ? remoteEntry.level : 0);
                            const rowUserId = members.find(m => (m.callsign || m.username) === r)?.user_id;
                            const rowLocallyMuted = !isLocal && !!rowUserId && localMutedUsers.has(rowUserId);
                            return (
                              <div key={r}>
                                {/* Mute + screenshare controls above local user row */}
                                {isLocal && (
                                  <div className="flex items-center gap-1 pl-8 pr-2 pt-1 pb-0.5">
                                    <button
                                      type="button"
                                      onClick={e => { e.stopPropagation(); commLinkActionsRef.current?.toggleMic?.(); }}
                                      className={cx(
                                        'h-6 px-2 inline-flex items-center gap-1 rounded-ui-sm border text-ui-xs transition-colors',
                                        voiceMuted
                                          ? 'border-specter-border text-specter-text-subtle hover:text-specter-text-main'
                                          : 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20',
                                        focusRing,
                                      )}
                                      title={voiceMuted ? 'Unmute mic' : 'Mute mic'}
                                      aria-pressed={voiceMuted}
                                    >
                                      {voiceMuted ? <MicOff size={13} aria-hidden="true" /> : <Mic size={13} aria-hidden="true" />}
                                      {voiceMuted ? 'Muted' : 'Mic on'}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={e => {
                                        e.stopPropagation();
                                        voiceSharing
                                          ? commLinkActionsRef.current?.stopScreenShare?.()
                                          : commLinkActionsRef.current?.startScreenShare?.();
                                      }}
                                      className={cx(
                                        'h-6 px-2 inline-flex items-center gap-1 rounded-ui-sm border text-ui-xs transition-colors',
                                        voiceSharing
                                          ? 'border-specter-state-error/50 bg-specter-state-error/10 text-red-300 hover:bg-specter-state-error/20'
                                          : 'border-specter-border text-specter-text-muted hover:text-specter-text-main hover:border-specter-border-strong',
                                        focusRing,
                                      )}
                                      title={voiceSharing ? 'Stop screen share' : 'Share screen'}
                                    >
                                      {voiceSharing ? <MonitorX size={13} aria-hidden="true" /> : <MonitorUp size={13} aria-hidden="true" />}
                                      {voiceSharing ? 'Stop' : 'Share'}
                                    </button>
                                  </div>
                                )}
                                {/* User name row */}
                                <div
                                  className={cx(
                                    'flex items-center gap-2 pl-8 pr-2 pt-0.5 rounded-ui-row cursor-pointer text-ui-sm hover:bg-white/5',
                                    speaking ? 'text-emerald-300' : 'text-specter-text-muted',
                                  )}
                                  onClick={e => { e.stopPropagation(); setProfileModalUser({ callsign: r, isLocal }); }}
                                  title={isLocal ? 'Click to adjust mic gain' : 'Click to view profile'}
                                >
                                  <span
                                    aria-hidden="true"
                                    className="h-2 w-2 shrink-0 rounded-pill"
                                    style={{ background: speaking ? '#22c55e' : '#2d5a6e', boxShadow: speaking ? '0 0 6px rgba(34,197,94,0.8)' : 'none' }}
                                  />
                                  <span className="truncate">
                                    {r}
                                    {connecting && isLocal && <span className="ml-1 text-ui-xs text-specter-text-subtle">connecting…</span>}
                                  </span>
                                  {isSharer && (
                                    <MonitorPlay size={13} className="shrink-0 text-specter-primary-neon" aria-label="Sharing screen" />
                                  )}
                                  {rowLocallyMuted && (
                                    <VolumeX size={13} className="shrink-0 text-amber-400" aria-label="Muted for you only" />
                                  )}
                                </div>
                                {/* Audio level bar */}
                                <div className="pl-8 pr-2 pt-0.5 pb-1">
                                  <div className="h-[3px] rounded-pill overflow-hidden" style={{ background: '#0e1c2c' }}>
                                    <div style={{
                                      height: '100%',
                                      width: `${displayLevel}%`,
                                      background: isLocal
                                        ? (voiceMuted ? '#374151' : displayLevel > 60 ? '#22c55e' : '#0891b2')
                                        : (displayLevel > 60 ? '#22c55e' : '#0891b2'),
                                      borderRadius: 2,
                                      transition: 'width 80ms linear, background-color 200ms',
                                    }} />
                                  </div>
                                </div>
                                {/* Watch stream button — only shown for remote sharers, not the local user's own share */}
                                {isSharer && !isLocal && (
                                  <button
                                    type="button"
                                    onClick={() => setWatchTarget(prev => prev === r ? null : r)}
                                    className={cx(
                                      'ml-8 mb-1 h-6 px-2 inline-flex items-center gap-1 rounded-ui-sm text-ui-xs transition-colors',
                                      watchTarget === r
                                        ? 'bg-emerald-500/10 text-emerald-300'
                                        : 'text-specter-primary-neon hover:bg-specter-primary-cyan/10',
                                      focusRing,
                                    )}
                                  >
                                    {watchTarget === r ? <Eye size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
                                    {watchTarget === r ? 'Watching' : 'Watch stream'}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    };

                    return (
                      <>
                        {/* Regular voice channels */}
                        {regularVoice.length > 0 && (
                          <div>
                            <div className="px-2 pt-2 pb-1 text-ui-xs font-semibold text-specter-text-subtle">Voice</div>
                            {regularVoice.map(ch => {
                              const isJoined = inComms && voiceChannel?.id === ch.id;
                              const isActive = activeChannel?.id === ch.id || isJoined;
                              const chOccupants = channelPresence[ch.id] || [];
                              return (
                                <div key={ch.id}>
                                  {renderVoiceChannel(ch, isActive, isJoined, 0, chOccupants.length)}
                                  {isJoined ? renderRoster() : (chOccupants.length > 0 && renderOccupants(chOccupants))}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Event voice channels are shown in the main content area (Op Channels panel) */}
                      </>
                    );
                  })()}

                  {/* Text channels */}
                  {channels.filter(ch => (ch.channel_kind ?? 0) === 1).length > 0 && (
                    <div>
                      <div className="px-2 pt-3 pb-1 text-ui-xs font-semibold text-specter-text-subtle">Text</div>
                      {channels.filter(ch => (ch.channel_kind ?? 0) === 1).map(ch => {
                        const isActive = activeChannel?.id === ch.id;
                        return (
                          <div
                            key={ch.id}
                            className={cx(
                              'group flex items-center gap-2 h-8 pl-2 pr-1 rounded-ui-row cursor-pointer transition-colors',
                              isActive ? 'bg-specter-primary-cyan/10 text-specter-text-main' : 'text-specter-text-muted hover:bg-white/5 hover:text-specter-text-main',
                            )}
                            onClick={() => setActiveChannel(ch)}
                          >
                            <Hash size={16} aria-hidden="true" className={cx('shrink-0', isActive ? 'text-specter-primary-neon' : 'text-specter-text-subtle')} />
                            <span className="flex-1 truncate text-ui-base">{ch.name}</span>
                            {isCommander && (
                              <IconButton
                                size="sm"
                                variant="danger"
                                className="!h-6 !w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                                icon={<Trash2 size={13} />}
                                label="Delete channel"
                                onClick={e => { e.stopPropagation(); handleDeleteChannel(ch.id); }}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {channels.length === 0 && (
                    <div className="px-3 py-4 text-ui-sm text-specter-text-subtle text-center">
                      {isCommander ? 'No channels yet. Add one with +.' : 'No channels available'}
                    </div>
                  )}

                  {/* ── Collapsible Members List ─────────────────────── */}
                  {members.length > 0 && (
                    <div className="mt-2 pt-1 border-t border-specter-border-divider">
                      <button
                        type="button"
                        onClick={() => setMembersExpanded(v => !v)}
                        aria-expanded={membersExpanded}
                        className={cx('w-full flex items-center justify-between h-8 px-2 rounded-ui-row hover:bg-white/5 transition-colors', focusRing)}
                      >
                        <span className="text-ui-xs font-semibold text-specter-text-subtle">Members</span>
                        <span className="flex items-center gap-1.5">
                          <Badge>{members.length}</Badge>
                          <ChevronDown
                            size={14}
                            aria-hidden="true"
                            className={cx('text-specter-text-subtle transition-transform duration-150', membersExpanded && 'rotate-180')}
                          />
                        </span>
                      </button>

                      {membersExpanded && (
                        <div className="pb-1.5">
                          {(() => {
                            const onlineCallsigns = new Set(
                              Object.values(channelPresence).flat()
                            );
                            const online  = members.filter(m => onlineCallsigns.has(m.callsign || m.username));
                            const offline = members.filter(m => !onlineCallsigns.has(m.callsign || m.username));
                            const renderMember = (m) => {
                              const isOnline = onlineCallsigns.has(m.callsign || m.username);
                              const avatarUrl = m.avatar_url ? `${UPLOADS_BASE_URL}${m.avatar_url}` : null;
                              return (
                                <div
                                  key={m.user_id}
                                  className={cx(
                                    'flex items-center gap-2 h-8 px-2 rounded-ui-row cursor-pointer text-ui-sm hover:bg-white/5 transition-colors',
                                    isOnline ? 'text-specter-text-muted hover:text-specter-text-main' : 'text-specter-text-subtle opacity-70 hover:opacity-100',
                                  )}
                                  onClick={() => setProfileModalUser({ callsign: m.callsign || m.username, isLocal: (m.callsign || m.username) === (user?.callsign || user?.username) })}
                                >
                                  <HexBadge letter={(m.callsign || '?')[0]} colorKey="blue" size={20} online={isOnline} imageUrl={avatarUrl} />
                                  <span className="truncate">{m.callsign || m.username}</span>
                                </div>
                              );
                            };
                            return (
                              <>
                                {online.length > 0 && (
                                  <>
                                    <div className="px-2 pt-1.5 pb-0.5 text-ui-xs text-specter-text-subtle">Online — {online.length}</div>
                                    {online.map(renderMember)}
                                  </>
                                )}
                                {offline.length > 0 && (
                                  <>
                                    <div className="px-2 pt-1.5 pb-0.5 text-ui-xs text-specter-text-subtle">Offline — {offline.length}</div>
                                    {offline.map(renderMember)}
                                  </>
                                )}
                              </>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="px-4 py-5 text-ui-sm text-specter-text-subtle text-center">
                Select a server to see channels
              </div>
            )}
          </div>

          {/* Op channel panel — shown during active operation */}
          {inComms && voiceChannel && activeOp?.launched && (() => {
            const opChannels = channels.filter(c => c.event_id === activeOp.id && (c.channel_kind ?? 0) === 0);
            if (opChannels.length === 0) return null;
            return (
              <div className={cx('rounded-ui-md', glassPanel)} style={{ margin: '8px', padding: '6px 10px' }}>
                <div style={{ fontSize: 9, color: '#0e7490', letterSpacing: '0.25em', marginBottom: 6 }}>OP CHANNELS</div>

                {opChannels.map(ch => {
                  const isActive = ch.id === voiceChannel?.id;
                  const isMonitored = !isActive && monitorChannels.some(mc => mc.id === ch.id);
                  const hasAccess = isOpCommander || !!eventChannelAccess[ch.id];
                  const isLocked = !hasAccess;
                  const chOccupants = channelPresence[ch.id] || [];
                  return (
                    <div key={ch.id} style={{ marginBottom: 3 }}>
                      <div
                        className="flex items-center gap-2"
                        style={{
                          padding: '4px 6px', borderRadius: 3, cursor: (isActive || isLocked) ? 'default' : 'pointer',
                          background: isLocked ? '#120707' : (isActive ? '#041e2e' : '#040c17'),
                          border: `1px solid ${isLocked ? '#7f1d1d' : (isActive ? '#0891b2' : isMonitored ? '#1e4a2e' : '#0e2233')}`,
                          opacity: isLocked ? 0.8 : 1,
                        }}
                        title={isLocked ? 'Locked: assignment or commander role required' : (isActive ? 'Active channel' : isMonitored ? 'Click to switch · Right-click to stop monitoring' : 'Click to monitor (RX only)')}
                        onClick={() => {
                          if (isActive || isLocked) return;
                          if (isMonitored) {
                            // Swap active ↔ monitored
                            const prev = voiceChannel;
                            setVoiceChannel(ch);
                            setActiveChannel(ch);
                            setMonitorChannels(prevMons =>
                              prevMons.filter(c => c.id !== ch.id).concat({ id: prev.id, name: prev.name, channel_kind: 0 })
                            );
                          } else {
                            // Toggle on as a monitor channel
                            setMonitorChannels(prev => [...prev, { id: ch.id, name: ch.name, channel_kind: 0 }]);
                          }
                        }}
                        onContextMenu={e => {
                          e.preventDefault();
                          if (isLocked) return;
                          if (isMonitored) {
                            setMonitorChannels(prev => prev.filter(c => c.id !== ch.id));
                          }
                        }}
                        onMouseEnter={e => { if (!isActive && !isLocked) { e.currentTarget.style.borderColor = isMonitored ? '#22c55e' : '#0e4a5a'; } }}
                        onMouseLeave={e => { if (!isActive && !isLocked) { e.currentTarget.style.borderColor = isMonitored ? '#1e4a2e' : '#0e2233'; } }}
                      >
                        <div style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: isLocked ? '#ef4444' : (isActive ? '#22d3ee' : isMonitored ? '#22c55e' : '#334155') }} />
                        <span className="truncate" style={{ fontSize: 10, flex: 1, letterSpacing: '0.1em', color: isLocked ? '#fca5a5' : (isActive ? '#67e8f9' : isMonitored ? '#4ade80' : '#64748b') }}>
                          {ch.name}
                        </span>
                        {chOccupants.length > 0 && (
                          <span style={{ fontSize: 9, color: '#334155', flexShrink: 0 }}>{chOccupants.length}</span>
                        )}
                        <span style={{ fontSize: 9, letterSpacing: '0.2em', flexShrink: 0, color: isLocked ? '#fca5a5' : (isActive ? '#0891b2' : isMonitored ? '#16a34a' : '#334155') }}>
                          {isLocked ? 'LOCKED' : (isActive ? 'ACTIVE' : isMonitored ? 'MON' : 'RX')}
                        </span>
                      </div>
                      {chOccupants.length > 0 && (
                        <div className="flex flex-wrap gap-x-3" style={{ paddingLeft: 14, paddingTop: 2 }}>
                          {chOccupants.map(u => (
                            <span
                              key={u}
                              onClick={() => setProfileModalUser({ callsign: u })}
                              style={{ fontSize: 10, color: '#64748b', cursor: 'pointer' }}
                            >
                              {u}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                <div style={{ fontSize: 9, color: '#1e4060', marginTop: 4, letterSpacing: '0.08em' }}>
                  CLICK to monitor · CLICK MON to swap active · RIGHT-CLICK to remove · LOCKED needs assignment/commander
                </div>
              </div>
            );
          })()}

          {/* ── Audio Mixer Panel — shown when in comms ──────────────────── */}
          {inComms && voiceChannel && (
            <div style={{ borderTop: '1px solid #0e2233', padding: '6px 10px', flexShrink: 0 }}>
              <div style={{ fontSize: 9, color: '#0e7490', letterSpacing: '0.25em', marginBottom: 6 }}>AUDIO MIXER</div>

              {/* Frequency cycle indicator */}
              {availableFreqs.length > 0 && (
                <div style={{ marginBottom: 6, background: '#020c18', border: '1px solid #0e2233', borderRadius: 3, padding: '4px 8px' }}>
                  <div style={{ fontSize: 9, color: '#0e7490', letterSpacing: '0.2em', marginBottom: 4 }}>ACTIVE FREQ</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                    {/* Primary group channel (index 0) — dot shows the passive monitor
                        connection is actually live when this isn't the active TX channel */}
                    <button
                      onClick={() => setActiveFreqIdx(0)}
                      title={activeFreqIdx !== 0 ? (monitorStatus[voiceChannel.id]?.connected ? 'Still connected (passive)' : 'Reconnecting…') : undefined}
                      style={{
                        fontSize: 9, padding: '2px 7px', borderRadius: 3, cursor: 'pointer', fontFamily: 'monospace', letterSpacing: '0.1em',
                        background: activeFreqIdx === 0 ? '#041e2e' : 'transparent',
                        border: `1px solid ${activeFreqIdx === 0 ? '#0891b2' : '#0e2233'}`,
                        color: activeFreqIdx === 0 ? '#22d3ee' : '#6b7280',
                      }}
                    >
                      {activeFreqIdx !== 0 && (
                        <span style={{
                          display: 'inline-block', width: 5, height: 5, borderRadius: '50%', marginRight: 4,
                          background: monitorStatus[voiceChannel.id]?.connected ? '#22c55e' : '#374151',
                        }} />
                      )}
                      {voiceChannel.name.toUpperCase()}
                    </button>
                    {availableFreqs.map((freq, fi) => {
                      const isActive = activeFreqIdx === fi + 1;
                      return (
                      <button
                        key={freq.id}
                        onClick={() => setActiveFreqIdx(fi + 1)}
                        title={!isActive ? (monitorStatus[freq.channel_id]?.connected ? 'Still connected (passive)' : 'Reconnecting…') : undefined}
                        style={{
                          fontSize: 9, padding: '2px 7px', borderRadius: 3, cursor: 'pointer', fontFamily: 'monospace', letterSpacing: '0.1em',
                          background: isActive ? '#1a1000' : 'transparent',
                          border: `1px solid ${isActive ? '#d97706' : '#0e2233'}`,
                          color: isActive ? '#f59e0b' : '#6b7280',
                        }}
                      >
                        {!isActive && (
                          <span style={{
                            display: 'inline-block', width: 5, height: 5, borderRadius: '50%', marginRight: 4,
                            background: monitorStatus[freq.channel_id]?.connected ? '#22c55e' : '#374151',
                          }} />
                        )}
                        ◈ {freq.name}
                      </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Main channel volume */}
              <div style={{ marginBottom: 6 }}>
                <div className="flex items-center justify-between" style={{ marginBottom: 3 }}>
                  <span style={{ fontSize: 9, color: '#22d3ee', letterSpacing: '0.15em' }}>
                    ACTIVE TX · {(activeFreqIdx > 0 ? (availableFreqs[activeFreqIdx - 1]?.name || voiceChannel.name) : voiceChannel.name).toUpperCase()}
                  </span>
                  <span style={{ fontSize: 9, color: '#22d3ee', fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right' }}>
                    {Math.round(gainValue * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  value={gainValue}
                  onChange={e => {
                    const v = parseFloat(e.target.value);
                    setGainValue(v);
                    localStorage.setItem('specter_audio_gain', String(v));
                    window.dispatchEvent(new StorageEvent('storage', { key: 'specter_audio_gain' }));
                  }}
                  style={{ width: '100%', accentColor: '#0891b2', cursor: 'pointer' }}
                />
              </div>

              {availableFreqs.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div className="flex items-center justify-between" style={{ marginBottom: 3 }}>
                    <span style={{ fontSize: 9, color: '#f59e0b', letterSpacing: '0.15em' }}>
                      PASSIVE FREQ RX
                    </span>
                    <span style={{ fontSize: 9, color: '#f59e0b', fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right' }}>
                      {Math.round(passiveFreqVolume * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.05"
                    value={passiveFreqVolume}
                    onChange={e => {
                      const v = parseFloat(e.target.value);
                      setPassiveFreqVolume(v);
                      localStorage.setItem('specter_passive_freq_volume', String(v));
                    }}
                    style={{ width: '100%', accentColor: '#d97706', cursor: 'pointer' }}
                  />
                </div>
              )}

              {/* Per-monitor-channel volume sliders */}
              {monitorChannels.map(mc => {
                const vol = monitorVolumes[mc.id] ?? 0.3;
                return (
                  <div key={mc.id} style={{ marginBottom: 5 }}>
                    <div className="flex items-center justify-between" style={{ marginBottom: 3 }}>
                      <span style={{ fontSize: 9, color: '#4ade80', letterSpacing: '0.15em' }}>
                        ◎ {mc.name.toUpperCase()}
                      </span>
                      <span style={{ fontSize: 9, color: '#4ade80', fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right' }}>
                        {Math.round(vol * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="2"
                      step="0.05"
                      value={vol}
                      onChange={e => {
                        const v = parseFloat(e.target.value);
                        setMonitorVolumes(prev => {
                          const next = { ...prev, [mc.id]: v };
                          localStorage.setItem('specter_monitor_volumes', JSON.stringify(next));
                          return next;
                        });
                      }}
                      style={{ width: '100%', accentColor: '#16a34a', cursor: 'pointer' }}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {/* Audio waveform — visible while in comms */}
          {inComms && (
            <div style={{ padding: '4px 10px 6px', flexShrink: 0, borderTop: '1px solid #0e2233' }}>
              <div style={{ fontSize: 9, color: '#0e7490', letterSpacing: '0.3em', marginBottom: 3 }}>SIGNAL</div>
              <AudioWaveform level={localAudioLevel} speaking={localSpeaking} />
            </div>
          )}
          {/* User footer */}
          <div className="flex-shrink-0 px-2 py-2 border-t border-specter-border-divider">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setLeftTab(leftTab === 'profile' || leftTab === 'dm' ? null : 'profile')}
                aria-expanded={leftTab === 'profile' || leftTab === 'dm'}
                title="Profile and contacts"
                className={cx(
                  'flex-1 min-w-0 flex items-center gap-2.5 px-1.5 py-1 rounded-ui-row text-left transition-colors hover:bg-white/5',
                  (leftTab === 'profile' || leftTab === 'dm') && 'bg-white/5',
                  focusRing,
                )}
              >
                <span className="relative shrink-0">
                  <HexBadge letter={(user?.callsign || 'U')[0]} colorKey="cyan" size={28} active={leftTab === 'profile' || leftTab === 'dm'} imageUrl={user?.avatar_url ? `${UPLOADS_BASE_URL}${user.avatar_url}` : null} />
                  {dmNotif && (
                    <span
                      aria-label="New direct message"
                      className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-pill bg-specter-state-error"
                      style={{ boxShadow: '0 0 0 2px #081828' }}
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui-sm font-semibold text-specter-text-main">{user?.callsign}</span>
                  <span className="flex items-center gap-1.5 text-ui-xs text-specter-text-subtle">
                    <span aria-hidden="true" className="h-1.5 w-1.5 rounded-pill bg-specter-state-success" />
                    Online
                  </span>
                </span>
              </button>
              <IconButton
                icon={<LogOut size={16} />}
                label="Log out"
                className="hover:!text-red-300"
                onClick={onLogout}
              />
            </div>
          </div>
        </aside>

        {/* ══ CABINET: Profile + Contacts / DM slide-out ════════════════ */}
        {leftTab && (
          <div
            className="depth-surface depth-elev-2"
            style={{
              position: 'absolute', left: 240, top: 0, bottom: 0, width: 260, zIndex: 10,
              background: '#040c17', borderRight: '1px solid #0e2233',
              boxShadow: '6px 0 28px rgba(0,0,0,0.65)',
              display: 'flex', flexDirection: 'column',
            }}
          >
            {leftTab === 'dm'
              ? <DmCabinet friend={selectedDmFriend} onBack={() => setLeftTab('profile')} currentUserId={user?.id} />
              : <ProfileCabinet
                  user={user}
                  friends={friends}
                  onSelectFriend={f => { setSelectedDmFriend(f); setLeftTab('dm'); setDmNotif(prev => prev?.from_user_id === f.user_id ? null : prev); }}
                  onOpenSettings={() => setShowSettings(true)}
                />
            }
          </div>
        )}

        {/* ══ CENTER: Active Operation ════════════════════════════ */}
        <main className="flex-1 flex flex-col overflow-hidden depth-surface depth-elev-1 relative">
        {/* CommLink stays mounted whenever in voice — even while Settings/Planner/ShipEditor are open, so opening a menu never tears down the mic */}
        {inComms && selectedOrg && voiceChannel && (() => {
          // Compute which channel CommLink should be connected to:
          // activeFreqIdx = 0 → primary group channel
          // activeFreqIdx > 0 → liaison frequency channel
          const activeFreq = activeFreqIdx > 0 ? availableFreqs[activeFreqIdx - 1] : null;
          const commChannel = activeFreq
            ? { id: activeFreq.channel_id, name: activeFreq.name, channel_kind: 0 }
            : voiceChannel;
          // Publish to the SSE handlers above, which cannot see this binding —
          // see activeCommChannelIdRef. Written unconditionally (not inside the
          // change-check below) so it is correct on every render, not only on
          // transitions.
          activeCommChannelIdRef.current = commChannel?.id;
          if (commChannelTraceRef.current !== commChannel?.id) {
            traceLog(`commChannel (CommLink key) changed ${commChannelTraceRef.current} -> ${commChannel?.id} (activeFreqIdx=${activeFreqIdx}, source=${activeFreq ? 'frequency' : 'voiceChannel'})`);
            commChannelTraceRef.current = commChannel?.id;
          }
          const commLinkShown = commLinkVisible && !editingShip && !(plannerEvent && selectedOrg) && !showSettings;
          return (
            <div className="overflow-hidden" style={{
              position: 'absolute', inset: 0, zIndex: 1,
              display: commLinkShown ? 'flex' : 'none',
              flexDirection: 'column',
            }}>
              <CommLink
                key={commChannel?.id}
                org={selectedOrg}
                channel={commChannel}
                channelVolume={gainValue}
                onBack={() => { setInComms(false); setVoiceChannel(null); setMonitorChannels([]); setAvailableFreqs([]); setActiveFreqIdx(0); }}
                onRosterChange={setVoiceRoster}
                onSpeakingChange={setLocalSpeaking}
                onSharersChange={setActiveSharers}
                watchStreamTarget={watchTarget}
                onWatchFailed={() => setWatchTarget(null)}
                onMuteChange={setVoiceMuted}
                onLocalLevelChange={setLocalAudioLevel}
                onRemoteLevelsChange={setRemoteLevels}
                onSharingChange={setVoiceSharing}
                onStatusChange={setVoiceStatus}
                onE2eStateChange={setVoiceE2e /* E2EV */}
                onConnectionQualityChange={setVoiceConnectionQuality}
                localMutedUserIds={localMutedUsers}
                externalControlsRef={commLinkActionsRef}
                hideMuteButton
                embedded
                overlayActive={isOverlay}
                stripViewerActive={stripViewer && Boolean(watchTarget) /* SV */}
                onRelayRef={commLinkRelayRef}
                onMlsCommitRef={commLinkMlsCommitRef}
              />
            </div>
          );
        })()}
        {editingShip ? (
          <ShipEditor ship={editingShip} onUpdate={updateShip} onClose={() => setEditingShip(null)} />
        ) : plannerEvent && selectedOrg ? (
          <OperationPlanner
            org={selectedOrg}
            event={plannerEvent === 'create' ? null : plannerEvent}
            members={members}
            user={user}
            onClose={() => setPlannerEvent(null)}
            onRefreshEvents={refreshEventsCb}
          />
        ) : showSettings ? (
          <SettingsUI onClose={() => setShowSettings(false)} user={user} onOpenShip={handleOpenShip} micCaptureActive={inComms && !voiceMuted} />
        ) : (
          <>

          {/* JOIN OPERATION banner — flashes when user has an assigned channel after launch */}
          {joinBanner && (
            <div
              className="flex items-center gap-3 px-5 py-2 flex-shrink-0"
              style={{
                background: 'linear-gradient(90deg, #041a0e 0%, #062110 100%)',
                borderBottom: '1px solid #166534',
                animation: 'specter-pulse 1.2s ease-in-out infinite',
                position: 'relative',
                zIndex: 2,
              }}
            >
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: '#22c55e', boxShadow: '0 0 10px #22c55e' }} />
              <div className="flex-1 min-w-0">
                <div style={{ fontSize: 13, fontWeight: 'bold', color: '#86efac', letterSpacing: '0.15em' }}>
                  {(joinBanner.eventName || 'EVENT')} IS STARTING — {joinBanner.group_name?.toUpperCase()}
                  {joinBanner.role && <span style={{ color: '#4ade80', marginLeft: 8, fontWeight: 'normal' }}>/ {joinBanner.role}</span>}
                </div>
                <div style={{ fontSize: 13, color: '#16a34a', letterSpacing: '0.1em' }}>
                  Would you like to join your channel? {joinBanner.channel.name}
                  {joinBanner.commander_callsign && <span style={{ marginLeft: 8, color: '#15803d' }}>CMD: {joinBanner.commander_callsign}</span>}
                </div>
              </div>
              <button
                onClick={() => {
                  setVoiceChannel(joinBanner.channel);
                  setActiveChannel(joinBanner.channel);
                  setInComms(true);
                  setJoinBanner(null);
                }}
                style={{
                  fontSize: 13, padding: '5px 14px', borderRadius: 3, letterSpacing: '0.2em',
                  background: '#14532d', border: '1px solid #16a34a', color: '#4ade80', cursor: 'pointer', fontWeight: 'bold',
                  flexShrink: 0,
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#166534'}
                onMouseLeave={e => e.currentTarget.style.background = '#14532d'}
              >
                YES · JOIN CHANNEL
              </button>
              <button
                onClick={() => setJoinBanner(null)}
                style={{ fontSize: 13, color: '#166534', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0, padding: '0 4px' }}
                onMouseEnter={e => e.currentTarget.style.color = '#f87171'}
                onMouseLeave={e => e.currentTarget.style.color = '#166534'}
                title="No"
              >NO</button>
            </div>
          )}

          {/* Op header bar — holds the OPERATIONS toggle for the inline
              operations view below, so it never permanently eats a row of
              vertical space when there's nothing urgent in it. */}
          {(() => {
            const opsBadge = selectedOrg ? getOpsBadge(events) : null;
            return (
          <div
            className={cx('flex items-center justify-between gap-4 px-4 py-2.5 flex-shrink-0 font-ui min-h-[56px]', glassPanel)}
            style={{ position: 'relative', zIndex: 2 }}
          >
            {!(inComms && voiceChannel) && (
              <div className="min-w-0">
                <div className="text-ui-xs text-specter-text-subtle">
                  {activeOp ? 'Active operation' : selectedOrg ? 'Standby' : 'No server selected'}
                </div>
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="truncate text-ui-lg font-semibold text-specter-text-main">
                    {activeOp
                      ? activeOp.name
                      : selectedOrg
                        ? selectedOrg.callsign
                        : 'Select a server'}
                  </span>
                  {activeOp && (
                    <span className="shrink-0 font-mono text-ui-xs tabular-nums text-specter-primary-neon">
                      {new Date(activeOp.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      {activeOp.end_time && (
                        <>{' — '}{new Date(activeOp.end_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{' UTC'}</>
                      )}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Comms indicator + actions */}
            <div className="flex items-center gap-2 ml-auto min-w-0">
              {voiceChannel && inComms && (
                <Badge variant="live" className="min-w-0 max-w-[260px]" title={`Connected to ${voiceChannel.name}`}>
                  <span className="truncate">{voiceChannel.name}</span>
                  <span className="shrink-0 opacity-70">· Connected</span>
                </Badge>
              )}
              {activeChannel && (activeChannel.channel_kind ?? 0) === 1 && (
                <span className="flex items-center gap-1 min-w-0 text-ui-sm text-specter-text-muted">
                  <Hash size={14} aria-hidden="true" className="shrink-0 text-specter-text-subtle" />
                  <span className="truncate">{activeChannel.name}</span>
                </span>
              )}
              {/* OPERATIONS toggle — one entry point for Now & soon, the month
                  grid and the scheduled list (was separate OPERATIONS/CALENDAR
                  pills). Stays available while watching a stream. */}
              {selectedOrg && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setOpsViewOpen(o => !o)}
                  aria-pressed={opsViewOpen}
                  title={opsBadge?.kind === 'soon' ? `${opsBadge.event.name} starts soon` : undefined}
                  icon={<CalendarDays size={15} />}
                  className={cx('shrink-0', opsViewOpen && '!border-specter-primary-cyan !bg-specter-primary-cyan/15 !text-specter-primary-neon')}
                >
                  Operations
                  {opsBadge?.kind === 'live' && <Badge variant="live" className="ml-0.5" />}
                  {opsBadge?.kind === 'soon' && <Badge variant="warning" className="ml-0.5">Soon</Badge>}
                  {opsBadge?.kind === 'count' && <Badge variant="count" className="ml-0.5">{opsBadge.count}</Badge>}
                </Button>
              )}
              {/* CA-3d: Overlay button visible whenever we're in the Tauri app (no activeChannel gate).
                  Previously required activeChannel, but overlay is useful as soon as WarRoom is open. */}
              {window.__TAURI__ && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={toggleOverlay}
                  aria-pressed={isOverlay}
                  icon={<Layers size={15} />}
                  className={cx('shrink-0', isOverlay && '!border-emerald-500/60 !bg-emerald-500/10 !text-emerald-300')}
                >
                  {isOverlay ? 'Exit overlay' : 'Overlay'}
                </Button>
              )}
              {inComms && (
                <Button
                  variant="danger"
                  size="sm"
                  className="shrink-0"
                  icon={<PhoneOff size={15} />}
                  onClick={() => { setInComms(false); setVoiceChannel(null); setMonitorChannels([]); setAvailableFreqs([]); setActiveFreqIdx(0); }}
                >
                  Disconnect
                </Button>
              )}
              {/* END OPERATION button — for org commanders or the assigned operation commander */}
              {(isCommander || isOpCommander) && activeOp?.launched && (
                <Button
                  variant="danger"
                  size="sm"
                  icon={<Square size={12} fill="currentColor" />}
                  className="shrink-0 !bg-specter-state-error/25 hover:!bg-specter-state-error/40"
                  onClick={() => setEndOpModal(true)}
                >
                  End operation
                </Button>
              )}
            </div>

          </div>
            );
          })()}

          {/* OPERATIONS view (Now & soon + month grid + scheduled list) —
              pushed inline below the header (normal document flow) instead of
              floating over the body, so opening it never covers the rest of
              the WarRoom content. zIndex 2 (like the header) keeps it above
              CommLink's absolute layer while in voice / watching a stream,
              with a solid backing there so the video doesn't show through. */}
          {selectedOrg && opsViewOpen && (
            <div className="overflow-y-auto flex-shrink-0 p-4 border-b border-specter-border-divider" style={{ maxHeight: '60vh', position: 'relative', zIndex: 2, background: inComms ? '#040c17' : undefined }}>
              <OpsCalendarPanel
                events={events}
                orgId={selectedOrg?.id}
                canScheduleEvents={canScheduleEvents}
                onSchedule={canScheduleEvents ? () => { setPlannerEvent('create'); setOpsViewOpen(false); } : null}
                onScheduleForDate={canScheduleEvents ? (date) => { setPlannerEvent({ initialDate: date }); setOpsViewOpen(false); } : null}
                onOpenEvent={handleOpenEventComp}
                onLaunchEvent={handleLaunchFromCard}
                canLaunchEvent={canLaunchEvent}
              />
            </div>
          )}

          {/* Body: comms / text chat / calendar */}
          {/* Hidden when the OPERATIONS view is open with no channel selected and not in voice —
              the body row is flex-1 and would otherwise leave an empty panel below it */}
          {(activeChannel || (inComms && voiceChannel) || !opsViewOpen) && <div className="flex flex-1 overflow-hidden">

            {/* Center content — contextual */}
            {/* zIndex 2 keeps the op-channels panel + calendar tab (and its dropdown, z-20)
                clickable above CommLink's absolute overlay (zIndex 1) while connected to voice —
                without this, CommLink covers the whole area and blocks joining/scheduling events. */}
            <div className="flex-1 flex flex-col overflow-hidden relative" style={{ zIndex: 2 }}>

              {/* ── Active Operation Channels Panel ── shown when an op is launched */}
              {activeOp?.launched && (() => {
                const opVoiceChannels = channels.filter(c => c.event_id === activeOp.id && (c.channel_kind ?? 0) === 0);
                if (opVoiceChannels.length === 0) return null;
                // Build tree (roots + childMap)
                const childMap = {};
                const roots = [];
                for (const ch of opVoiceChannels) {
                  if (!ch.parent_channel_id || !opVoiceChannels.find(c => c.id === ch.parent_channel_id)) {
                    roots.push(ch);
                  } else {
                    if (!childMap[ch.parent_channel_id]) childMap[ch.parent_channel_id] = [];
                    childMap[ch.parent_channel_id].push(ch);
                  }
                }
                const renderOpNode = (ch, depth = 0) => {
                  const isJoined = inComms && voiceChannel?.id === ch.id;
                  const isMonitored = !isJoined && monitorChannels.some(mc => mc.id === ch.id);
                  const hasAccess = isOpCommander || !!eventChannelAccess[ch.id];
                  const isLocked = !hasAccess;
                  const chOccupants = channelPresence[ch.id] || [];
                  return (
                    <div key={ch.id} style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
                      <button
                        onClick={() => {
                          if (isJoined || isLocked) return;
                          if (isMonitored) {
                            const prev = voiceChannel;
                            setVoiceChannel(ch);
                            setActiveChannel(ch);
                            setMonitorChannels(prevMons =>
                              prevMons.filter(c => c.id !== ch.id).concat(prev ? [{ id: prev.id, name: prev.name, channel_kind: 0 }] : [])
                            );
                          } else {
                            setVoiceChannel(ch);
                            setActiveChannel(ch);
                            setInComms(true);
                          }
                        }}
                        onContextMenu={e => {
                          e.preventDefault();
                          if (isLocked) return;
                          if (isMonitored) setMonitorChannels(prev => prev.filter(c => c.id !== ch.id));
                          else if (!isJoined) setMonitorChannels(prev => [...prev, { id: ch.id, name: ch.name, channel_kind: 0 }]);
                        }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5,
                          padding: '5px 10px',
                          paddingLeft: 10 + depth * 10,
                          background: isLocked ? '#120707' : (isJoined ? '#041e2e' : isMonitored ? '#021a0e' : '#040c17'),
                          border: `1px solid ${isLocked ? '#7f1d1d' : (isJoined ? '#0891b2' : isMonitored ? '#166534' : '#0e2233')}`,
                          borderRadius: 3, cursor: (isJoined || isLocked) ? 'default' : 'pointer',
                          minWidth: 100, maxWidth: 160, whiteSpace: 'nowrap',
                          opacity: isLocked ? 0.8 : 1,
                        }}
                        onMouseEnter={e => { if (!isJoined && !isLocked) e.currentTarget.style.borderColor = isMonitored ? '#22c55e' : '#1e6080'; }}
                        onMouseLeave={e => { if (!isJoined && !isLocked) e.currentTarget.style.borderColor = isJoined ? '#0891b2' : isMonitored ? '#166534' : '#0e2233'; }}
                      >
                        {depth > 0 && <span style={{ fontSize: 8, color: '#374151' }}>└</span>}
                        <span style={{ fontSize: 13, color: isLocked ? '#ef4444' : (isJoined ? '#22c55e' : isMonitored ? '#4ade80' : '#2d5a6e'), flexShrink: 0 }}>◉</span>
                        <span style={{ fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', color: isLocked ? '#fca5a5' : (isJoined ? '#e5e7eb' : isMonitored ? '#86efac' : '#94a3b8'), letterSpacing: '0.04em' }}>
                          {ch.name}
                        </span>
                        {chOccupants.length > 0 && (
                          <span style={{ fontSize: 9, color: '#374151', flexShrink: 0 }}>{chOccupants.length}</span>
                        )}
                        <span style={{ fontSize: 8, letterSpacing: '0.15em', flexShrink: 0, color: isLocked ? '#fca5a5' : (isJoined ? '#0891b2' : isMonitored ? '#166534' : '#1e3a5f') }}>
                          {isLocked ? 'LOCKED' : (isJoined ? 'ACTIVE' : isMonitored ? 'MON' : 'JOIN')}
                        </span>
                      </button>
                      {(childMap[ch.id] || []).map(child => renderOpNode(child, depth + 1))}
                    </div>
                  );
                };
                return (
                  <div className={cx('rounded-ui-md', glassPanel)} style={{ margin: '8px 8px 0', flexShrink: 0, padding: '6px 14px 8px' }}>
                    <div style={{ fontSize: 9, color: '#ca8a04', letterSpacing: '0.3em', marginBottom: 5 }}>
                      ⚔ OPERATION CHANNELS — {activeOp.name.toUpperCase()}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {roots.map(ch => renderOpNode(ch))}
                    </div>
                    <div style={{ fontSize: 8, color: '#1e4060', marginTop: 4, letterSpacing: '0.08em' }}>
                      CLICK to join · RIGHT-CLICK to monitor · LOCKED channels require assignment or commander role
                    </div>
                  </div>
                );
              })()}

              {/* Calendar toggle + dropdown now live in the Op header bar above (merged
                  in per user request) instead of their own tab bar here. */}

              {/* Channel content */}
              {/* Text chat — shown when a text channel is selected (voice stays connected in background) */}
              {activeChannel && (activeChannel.channel_kind ?? 0) === 1 ? (
                <div className="flex-1 flex flex-col overflow-hidden">
                  {/* Voice connection indicator bar when viewing text while in voice */}
                  {inComms && voiceChannel && (
                    <div
                      className="flex items-center gap-2 px-4 py-1.5 flex-shrink-0 cursor-pointer transition-colors hover:bg-white/5"
                      style={{ borderBottom: '1px solid #0e2233', background: '#041a12' }}
                      onClick={() => setActiveChannel(voiceChannel)}
                    >
                      <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: '#22c55e', boxShadow: '0 0 6px #22c55e' }} />
                      <span style={{ fontSize: 13, color: '#22c55e', letterSpacing: '0.15em' }}>
                        VOICE CONNECTED — ◉ {voiceChannel.name.toUpperCase()}
                      </span>
                      <div style={{ flex: 1 }} />
                      <span style={{ fontSize: 10, color: '#0e7490', letterSpacing: '0.1em' }}>CLICK TO VIEW</span>
                    </div>
                  )}
                  <TextChat chat={channelChat} channel={activeChannel} />
                </div>
              ) : !inComms || !voiceChannel ? (
                selectedOrg && !activeChannel && !opsViewOpen ? (
                  /* Server landing — shown when a server is selected but no channel is active and OPERATIONS is closed */
                  <ServerHome
                    org={selectedOrg}
                    events={events}
                    members={members}
                    canViewCalendar={canViewCalendar}
                    canScheduleEvents={canScheduleEvents}
                    canLaunchEvent={canLaunchEvent}
                    onLaunchEvent={handleLaunchFromCard}
                    onOpenEvent={handleOpenEventComp}
                    onOpenPlanner={() => setPlannerEvent('create')}
                  />
                ) : null
              ) : null}
            </div>

          </div>}
          </>
        )}
        </main>

        {/* ══ RIGHT: Soundboard (hidden – non-functional) ═══════════ */}

      </div>

      {/* ══ BOTTOM: comms status bar ════════════════════════════════ */}
      <div
        className="flex items-center gap-3 px-4 flex-shrink-0 hud-panel hud-border-t depth-inset"
        style={{
          height: 32, background: 'rgba(3,10,19,0.75)',
          fontSize: 13, letterSpacing: '0.2em',
        }}
      >
        {/* Settings gear */}
        <button
          onClick={() => setShowSettings(true)}
          className="hover:text-cyan-300 transition-colors"
          style={{ fontSize: 20, color: '#22d3ee', cursor: 'pointer', lineHeight: 1, padding: '0 2px' }}
          title="Settings"
        >
          ⚙
        </button>
        <div
          className="rounded-full animate-pulse"
          style={{
            width: 7, height: 7,
            background: inComms ? '#22c55e' : '#0e7490',
            boxShadow: inComms ? '0 0 6px #22c55e' : 'none',
          }}
        />
        <span style={{ color: inComms ? '#22d3ee' : '#0e7490' }}>
          {inComms && voiceChannel
            ? `COMMS ACTIVE // #${voiceChannel.name.toUpperCase()}`
            : activeOp
              ? `COMMS STANDBY // ${activeOp.name.toUpperCase()}`
              : 'COMMS STANDBY'}
        </span>
        {inComms && voiceChannel && <ConnectionQualityBars quality={voiceConnectionQuality} />}
        <div style={{ flex: 1 }} />
        <span style={{ color: '#1d7a91' }}>
          {selectedOrg ? selectedOrg.callsign.toUpperCase() : '—'} // SPECTERCOMS
        </span>
        {appVersion && (
          <span style={{ color: '#1d7a91', opacity: 0.85 }}>v{appVersion}</span>
        )}
      </div>

      {profileModalUser && (() => {
        const targetMember = members.find(m => (m.callsign || m.username) === profileModalUser.callsign);
        const targetUserId = targetMember?.user_id;
        const isAlreadyFriend = friends.some(f => (f.callsign || f.username) === profileModalUser.callsign);
        const isLocallyMuted = !!targetUserId && localMutedUsers.has(targetUserId);
        const targetChannelEntry = Object.entries(channelPresence).find(([, occupants]) =>
          occupants.includes(profileModalUser.callsign)
        );
        const targetChannelId = targetChannelEntry?.[0] ?? null;
        return (
          <UserProfileModal
            targetUser={profileModalUser.callsign}
            avatarUrl={targetMember?.avatar_url ? `${UPLOADS_BASE_URL}${targetMember.avatar_url}` : null}
            isLocal={profileModalUser.isLocal}
            localAudioLevel={localAudioLevel}
            gainValue={gainValue}
            onGainChange={v => { setGainValue(v); localStorage.setItem('specter_audio_gain', String(v)); window.dispatchEvent(new StorageEvent('storage', { key: 'specter_audio_gain' })); }}
            userRole={targetMember?.role_name || ''}
            canKick={canKickMembers}
            canBan={canBanMembers}
            canMute={canMuteMembers}
            isFriend={isAlreadyFriend}
            isLocallyMuted={isLocallyMuted}
            isInChannel={!!targetChannelId}
            onClose={() => setProfileModalUser(null)}
            onAddFriend={async () => {
              if (!targetUserId) return;
              const { error } = await api.sendFriendRequest(targetUserId);
              if (!error) {
                pushNotif('system', 'FRIEND REQUEST SENT', `Request sent to ${profileModalUser.callsign}`);
                api.getFriends().then(({ data }) => setFriends(data?.friends || []));
              }
              setProfileModalUser(null);
            }}
            onDirectMessage={() => {
              const dmFriend = friends.find(f => (f.callsign || f.username) === profileModalUser.callsign)
                || (targetMember ? { user_id: targetUserId, callsign: profileModalUser.callsign, username: profileModalUser.callsign } : null);
              if (dmFriend) { setSelectedDmFriend(dmFriend); setLeftTab('dm'); }
              setProfileModalUser(null);
            }}
            onLocalMute={() => {
              if (!targetUserId) return;
              setLocalMutedUsers(prev => {
                const next = new Set(prev);
                if (next.has(targetUserId)) next.delete(targetUserId);
                else next.add(targetUserId);
                return next;
              });
              setProfileModalUser(null);
            }}
            onGlobalMute={async () => {
              if (!targetUserId || !selectedOrg) return;
              const { error } = await api.muteMember(selectedOrg.id, targetUserId, true);
              if (error) pushNotif('system', 'MUTE FAILED', error);
              else pushNotif('system', 'MEMBER MUTED', `${profileModalUser.callsign} has been server-muted`);
              setProfileModalUser(null);
            }}
            onKickFromChannel={async () => {
              if (!targetUserId || !selectedOrg || !targetChannelId) return;
              if (!confirm(`Kick ${profileModalUser.callsign} from the channel?`)) return;
              const { error } = await api.kickFromChannel(selectedOrg.id, targetUserId, targetChannelId);
              if (error) pushNotif('system', 'KICK FAILED', error);
              else pushNotif('system', 'MEMBER KICKED', `${profileModalUser.callsign} has been kicked from the channel`);
              setProfileModalUser(null);
            }}
            onKickFromServer={async () => {
              if (!targetUserId || !selectedOrg) return;
              if (!confirm(`Kick ${profileModalUser.callsign} from the server?`)) return;
              const { error } = await api.kickMember(selectedOrg.id, targetUserId);
              if (error) pushNotif('system', 'KICK FAILED', error);
              else pushNotif('system', 'MEMBER KICKED', `${profileModalUser.callsign} has been kicked from the server`);
              setProfileModalUser(null);
            }}
            onBan={async () => {
              if (!targetUserId || !selectedOrg) return;
              const reason = prompt(`Reason for banning ${profileModalUser.callsign} (optional):`);
              if (reason === null) return; // cancelled
              const { error } = await api.banMember(selectedOrg.id, targetUserId, reason || '');
              if (error) pushNotif('system', 'BAN FAILED', error);
              else pushNotif('system', 'MEMBER BANNED', `${profileModalUser.callsign} has been banned`);
              setProfileModalUser(null);
            }}
            canReportVoice={!profileModalUser.isLocal && !!targetChannelId}
            onReportVoice={() => {
              setProfileModalUser(null);
              setVoiceReportModal({
                accusedUserId: targetUserId,
                accusedCallsign: profileModalUser.callsign,
                orgId: selectedOrg?.id ?? null,
                note: '',
              });
            }}
          />
        );
      })()}

      {/* Voice misconduct report — attaches the last ~60s of actual call audio
          (what this client heard) plus a real speaking-activity timeline for
          that window. See CommLink.jsx's submitVoiceReport for what gets sent. */}
      {voiceReportModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={() => !voiceReportSubmitting && setVoiceReportModal(null)}>
          <div
            className="bg-[#0a1520] border border-[#0e7490] rounded-lg p-5 max-w-md w-full mx-4 font-mono"
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontSize: 13, color: '#f59e0b', letterSpacing: '0.2em', marginBottom: 8 }}>⚠ REPORT VOICE MISCONDUCT</div>
            <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 10 }}>
              This attaches the last ~60 seconds of call audio you actually heard, plus who was flagged as speaking during that window, to a report against <strong>{voiceReportModal.accusedCallsign}</strong>. Reviewed by platform admins only.
            </div>
            <textarea
              value={voiceReportModal.note}
              onChange={e => setVoiceReportModal(prev => ({ ...prev, note: e.target.value }))}
              placeholder="Briefly describe what happened (optional, but helps a reviewer act on this faster)"
              maxLength={2000}
              rows={4}
              style={{ width: '100%', fontSize: 13, color: '#e5e7eb', background: '#041018', border: '1px solid #0e2233', borderRadius: 3, padding: '8px 10px', marginBottom: 14, fontFamily: 'monospace', resize: 'vertical' }}
            />
            <div className="flex gap-2 justify-end">
              <button
                disabled={voiceReportSubmitting}
                onClick={() => setVoiceReportModal(null)}
                style={{ fontSize: 13, padding: '5px 14px', borderRadius: 3, background: '#1a1a2e', border: '1px solid #374151', color: '#cbd5e1', cursor: voiceReportSubmitting ? 'default' : 'pointer', letterSpacing: '0.1em', opacity: voiceReportSubmitting ? 0.5 : 1 }}
              >CANCEL</button>
              <button
                disabled={voiceReportSubmitting}
                onClick={async () => {
                  setVoiceReportSubmitting(true);
                  const result = await commLinkActionsRef.current?.submitVoiceReport?.(
                    voiceReportModal.accusedUserId,
                    voiceReportModal.note,
                    voiceReportModal.orgId,
                  );
                  setVoiceReportSubmitting(false);
                  if (result?.ok) {
                    pushNotif('system', 'REPORT SUBMITTED', 'Voice report submitted for admin review.');
                    setVoiceReportModal(null);
                  } else {
                    pushNotif('system', 'REPORT FAILED', result?.error || 'Could not submit report');
                  }
                }}
                style={{ fontSize: 13, padding: '5px 14px', borderRadius: 3, background: '#3b0a0a', border: '1px solid #b91c1c', color: '#fca5a5', cursor: voiceReportSubmitting ? 'default' : 'pointer', letterSpacing: '0.1em', opacity: voiceReportSubmitting ? 0.6 : 1 }}
              >{voiceReportSubmitting ? 'SUBMITTING…' : 'SUBMIT REPORT'}</button>
            </div>
          </div>
        </div>
      )}
      {billingPanelOpen && selectedOrg && orgBilling && (
        <BillingPanel
          orgId={selectedOrg.id}
          orgName={selectedOrg.callsign}
          billing={orgBilling}
          onClose={() => setBillingPanelOpen(false)}
          onFunded={() => api.getOrgBilling(selectedOrg.id).then(({ data }) => { if (data) setOrgBilling(data); })}
        />
      )}
      {showOrgSettings && selectedOrg && (
        <OrgSettings
          org={selectedOrg}
          user={user}
          permissions={selectedOrg?.permissions}
          onClose={() => setShowOrgSettings(false)}
          onOrgUpdated={refreshOrgs}
        />
      )}
      {groupCompEvent && selectedOrg && (
        <EventGroupCompModal
          org={selectedOrg}
          event={groupCompEvent}
          user={user}
          members={members}
          canEditEvent={canEditOperationEvent(groupCompEvent)}
          canLaunchEvent={canLaunchEvent}
          onLaunchEvent={handleLaunchFromCard}
          onClose={() => setGroupCompEvent(null)}
          onEventUpdated={refreshEventsCb}
          onOpenEdit={() => {
            setPlannerEvent(groupCompEvent);
            setGroupCompEvent(null);
          }}
        />
      )}
    </div>
    {/* ── Toast notification stack ─────────────────────────────────────── */}
    {notifications.length > 0 && (
      <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 2000, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}>
        {notifications.map(n => (
          <div key={n.id} style={{
            background: n.type === 'op_launch' ? '#041e2e' : n.type === 'op_end' ? '#1c0a0a' : '#03111c',
            border: `1px solid ${n.type === 'op_launch' ? '#0891b2' : n.type === 'op_end' ? '#7f1d1d' : '#0e3a4e'}`,
            borderRadius: 6,
            padding: '10px 14px',
            minWidth: 260,
            maxWidth: 340,
            boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
            pointerEvents: 'auto',
            animation: 'notif-in 0.2s ease-out',
          }}>
            <div style={{ fontSize: 10, color: n.type === 'op_launch' ? '#22d3ee' : n.type === 'op_end' ? '#f87171' : '#94a3b8', letterSpacing: '0.2em', marginBottom: 3 }}>
              {n.title}
            </div>
            <div style={{ fontSize: 13, color: '#cbd5e1', letterSpacing: '0.04em' }}>{n.body}</div>
          </div>
        ))}
      </div>
    )}
    </>
  );
}
