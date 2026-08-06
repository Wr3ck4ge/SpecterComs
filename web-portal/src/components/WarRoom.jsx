// WarRoom.jsx — Tauri-exclusive Mission Control / War Room Dashboard
// Matches the SpecterComs "Aether Comms" concept: War Room sidebar, Active Operation
// calendar, Live Manifest tier roster, Soundboard, and Direct Messages panel.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, UPLOADS_BASE_URL } from '../api';
import CommLink from './CommLink';
import SettingsUI from './SettingsUI';
import OrgSettings from './OrgSettings';
import OperationPlanner, { GroupPlanner } from './OperationPlanner';
import ShipEditor from './ShipEditor';
import ServerHome from './ServerHome';
import OpsCalendarPanel from './OpsCalendarPanel';
import useEventStream from '../useEventStream';
import useMonitorChannel from '../useMonitorChannel';
import UserProfileModal from './UserProfileModal';
import BillingPanel, { BILLING_UI_ENABLED } from './BillingPanel';
import {
  saveChannelMessage, getChannelMessages, saveDmMessage, getDmMessages,
  getLatestChannelTimestamp, getChannelMessagesSince, saveChannelMessages,
  getLatestDmTimestamp, getDmMessagesSince, saveDmMessages,
} from '../messageStore';
import {
  ensureDmGroup, encryptDm, decryptDmOrRecallOwn, notePendingSent, handleDmCommit, handleDmWelcome,
  ensureChannelGroup, encryptChannel, decryptChannelOrRecallOwn, handleChannelCommit, handleChannelWelcome,
  ensureEventGroup, handleEventGroupCommit, handleEventGroupWelcome,
} from '../mlsSession';
import { barColor, fmtBytes } from '../utils/format';

// ── Module-level relay refs ───────────────────────────────────────────────────
// TextChat and DmCabinet set these on mount; useEventStream calls them on message_relay.
const _textChatRelayRef  = { current: null };
const _dmCabinetRelayRef = { current: null };
// Peer backfill sync — see messageStore.js / messageController.js /
// dmController.js. TextChat/DmCabinet set these on mount; useEventStream
// calls them on sync_request (someone else wants our local history) and
// sync_response (someone answered a request we made).
const _textChatSyncRequestRef  = { current: null };
const _textChatSyncResponseRef = { current: null };
const _dmCabinetSyncRequestRef  = { current: null };
const _dmCabinetSyncResponseRef = { current: null };
const LAST_SELECTED_ORG_KEY = 'specter_last_selected_org_id';

// ── Palette ─────────────────────────────────────────────────────────────────

const ORG_COLORS = ['cyan', 'purple', 'green', 'yellow', 'blue', 'orange'];

const COLOR_MAP = {
  cyan:   { bg: '#041e26', border: '#0891b2', text: '#67e8f9', glow: '#06b6d4' },
  purple: { bg: '#130d24', border: '#7c3aed', text: '#c084fc', glow: '#9333ea' },
  green:  { bg: '#031a0e', border: '#16a34a', text: '#86efac', glow: '#22c55e' },
  yellow: { bg: '#1c1300', border: '#ca8a04', text: '#fde047', glow: '#eab308' },
  blue:   { bg: '#050f24', border: '#2563eb', text: '#93c5fd', glow: '#3b82f6' },
  orange: { bg: '#1c0a00', border: '#c2410c', text: '#fdba74', glow: '#f97316' },
};

function getOrgColor(index) {
  return ORG_COLORS[index % ORG_COLORS.length];
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

// Holo-glass panel treatment — mirrors ServerHome.jsx's `glass` style object so
// panels across the app share the same translucent, blurred-glow look. Applied
// universally across panel-level elements (see GLASS_PANEL usages below) —
// keep this and ServerHome.jsx's `glass` object in sync when tuning the glow.
const GLASS_PANEL = {
  backdropFilter: 'blur(14px)',
  background: 'linear-gradient(180deg, rgba(4,12,23,0.82), rgba(2,8,16,0.72))',
  border: '1px solid rgba(56,189,248,0.35)',
  boxShadow: 'inset 0 1px 0 rgba(34,211,238,0.06), 0 0 0 1px rgba(34,211,238,0.16), 0 0 26px rgba(34,211,238,0.28), 0 18px 48px rgba(0,0,0,0.35)',
};

// ── Hexagonal Badge ──────────────────────────────────────────────────────────

const HEX_PATH = 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)';

function HexBadge({ letter, colorKey = 'cyan', size = 44, active = false, online = false, imageUrl = null }) {
  const c = COLOR_MAP[colorKey] || COLOR_MAP.cyan;
  const inner = size * 0.84;
  const offset = (size - inner) / 2;
  const [imgErr, setImgErr] = useState(false);
  const showImage = imageUrl && !imgErr;

  return (
    <div style={{ width: size, height: size, position: 'relative', flexShrink: 0 }}>
      {/* Border layer */}
      <div style={{
        clipPath: HEX_PATH,
        background: active ? c.glow : c.border,
        width: size, height: size,
        position: 'absolute',
        filter: active ? `drop-shadow(0 0 8px ${c.glow})` : 'none',
        opacity: active ? 1 : 0.75,
        transition: 'all 0.2s',
      }} />
      {/* Fill layer */}
      <div style={{
        clipPath: HEX_PATH,
        background: showImage ? 'transparent' : c.bg,
        width: inner, height: inner,
        position: 'absolute', top: offset, left: offset,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden',
      }}>
        {showImage ? (
          <img
            src={imageUrl}
            alt=""
            onError={() => setImgErr(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span style={{
            color: c.text, fontFamily: 'monospace', fontWeight: 'bold',
            fontSize: size * 0.30, lineHeight: 1, userSelect: 'none',
          }}>
            {(letter || '?').toUpperCase()}
          </span>
        )}
      </div>
      {/* Online dot */}
      {online && (
        <div style={{
          position: 'absolute', bottom: 1, right: 1,
          width: 7, height: 7, borderRadius: '50%',
          background: '#4ade80', boxShadow: '0 0 5px #22c55e',
        }} />
      )}
    </div>
  );
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
  const inFlightRef = React.useRef(false);
  const bottomRef   = React.useRef(null);

  // Deterministic, order-independent conversation ID
  const convId = React.useMemo(() => {
    if (!currentUserId || !friend?.user_id) return null;
    return [currentUserId, friend.user_id].sort().join('-');
  }, [currentUserId, friend?.user_id]);

  // ── Load from local IndexedDB on friend change ────────────────────────────
  React.useEffect(() => {
    if (!convId) { setLoading(false); return; }
    let cancelled = false;
    setMessages([]);
    setLoading(true);
    getDmMessages(convId).then(msgs => {
      if (!cancelled) {
        setMessages(msgs ?? []);
        setLoading(false);
      }
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [convId]);

  // ── Register SSE relay handler ────────────────────────────────────────────
  React.useEffect(() => {
    if (!convId) return;
    _dmCabinetRelayRef.current = (payload) => {
      if (payload.context !== 'dm' || payload.partner_id !== friend.user_id) return;
      const msg = payload.message;
      if (!msg) return;
      (async () => {
        // isOwnAccount: could be this exact device's own message echoed back
        // for multi-device sync (undecryptable here — recalled from the
        // pending-sent queue instead) or a genuinely different device on
        // this same account (decrypts normally). See decryptDmOrRecallOwn.
        const isOwnAccount = msg.sender_id === currentUserId;
        let plaintext = null;
        try {
          plaintext = await decryptDmOrRecallOwn(api, currentUserId, convId, msg.encrypted_content, isOwnAccount);
        } catch {
          plaintext = null; // genuinely undecryptable (e.g. arrived before this device joined the group)
        }
        const stored = { ...msg, conversation_id: convId, plaintext };
        saveDmMessage(stored).catch(() => {});
        setMessages(prev => {
          if (prev.some(m => m.id === msg.id)) return prev;
          return [...prev, stored];
        });
      })();
    };
    return () => { _dmCabinetRelayRef.current = null; };
  }, [friend?.user_id, convId]);

  // ── Ask the other participant for anything missing from our local history ─
  React.useEffect(() => {
    if (!convId || !friend?.user_id) return;
    let cancelled = false;
    (async () => {
      const since = await getLatestDmTimestamp(convId).catch(() => null);
      if (cancelled) return;
      api.requestDmSync(friend.user_id, since).catch(() => {});
    })();
    return () => { cancelled = true; };
  }, [convId, friend?.user_id]);

  // ── Answer the other participant's sync-request with what we have locally ─
  React.useEffect(() => {
    if (!convId || !friend?.user_id) return;
    _dmCabinetSyncRequestRef.current = (payload) => {
      if (payload.conversation_id !== convId) return;
      if (payload.requester_id === currentUserId) return; // don't answer our own request
      getDmMessagesSince(convId, payload.since).then((rows) => {
        if (rows.length === 0) return;
        const messages = rows.map(({ id, sender_id, to_user_id, callsign, encrypted_content, timestamp }) => (
          { id, sender_id, to_user_id, callsign, encrypted_content, timestamp }
        ));
        api.respondDmSync(friend.user_id, messages).catch(() => {});
      }).catch(() => {});
    };
    return () => { _dmCabinetSyncRequestRef.current = null; };
  }, [convId, friend?.user_id, currentUserId]);

  // ── Merge the other participant's answer into local store + UI ───────────
  // Backfilled rows carry real ciphertext (see respondDmSync's field-picked
  // payload above) — each is decrypted once here, same one-shot constraint
  // as the live relay path, before it's ever stored or rendered.
  React.useEffect(() => {
    _dmCabinetSyncResponseRef.current = (payload) => {
      if (payload.conversation_id !== convId || !payload.messages?.length) return;
      (async () => {
        const decrypted = await Promise.all(payload.messages.map(async (m) => {
          const isOwnAccount = m.sender_id === currentUserId;
          let plaintext = null;
          try {
            plaintext = await decryptDmOrRecallOwn(api, currentUserId, convId, m.encrypted_content, isOwnAccount);
          } catch {
            plaintext = null;
          }
          return { ...m, conversation_id: convId, plaintext };
        }));
        saveDmMessages(convId, decrypted).catch(() => {});
        setMessages((prev) => {
          const existing = new Set(prev.map((m) => m.id));
          const fresh = decrypted.filter((m) => !existing.has(m.id));
          if (fresh.length === 0) return prev;
          return [...prev, ...fresh].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        });
      })();
    };
    return () => { _dmCabinetSyncResponseRef.current = null; };
  }, [convId, currentUserId]);

  // ── Scroll to bottom on new messages ─────────────────────────────────────
  React.useEffect(() => {
    if (!loading) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, loading]);

  const handleSend = async () => {
    const content = input.trim();
    if (!content || inFlightRef.current) return;
    inFlightRef.current = true;
    setInput('');
    try {
      await ensureDmGroup(api, currentUserId, friend.user_id, convId);
      const ciphertext = await encryptDm(api, currentUserId, convId, content);
      notePendingSent(convId, content);
      await api.sendDmMessage(friend.user_id, ciphertext);
    } catch {
      // Sender receives own message back via SSE relay; silent failure is acceptable
    }
    inFlightRef.current = false;
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const fmtTime = (ts) => {
    try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
  };
  const fmtDate = (ts) => {
    try {
      const d = new Date(ts);
      const today = new Date();
      if (d.toDateString() === today.toDateString()) return 'Today';
      const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
      if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch { return ''; }
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
                      plaintext is explicitly null means decryption was attempted and failed. */}
                  {msg.plaintext !== undefined ? (msg.plaintext ?? '[unable to decrypt]') : msg.encrypted_content}
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
      <div style={{ padding: '8px', borderTop: '1px solid #0e2233', flexShrink: 0, display: 'flex', gap: 6 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
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

// ── Active Operations: events starting within 24h, plus anything currently
// live/launched. Slot availability itself is enforced inside
// EventGroupCompModal (JOIN/FULL per role), so this just needs to surface
// the right set of cards. Filtering pulled out to a plain function so both
// the header's count badge and the dropdown panel share one source of truth.
function getActiveOpsCards(events) {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 3600 * 1000);
  return events
    .filter(ev => {
      const start = new Date(ev.start_time);
      const end = ev.end_time ? new Date(ev.end_time) : null;
      const isLive = start <= now && (!end || end >= now);
      const startingSoon = start > now && start <= in24h;
      return ev.launched || isLive || startingSoon;
    })
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
}

function ActiveOperationsDropdown({ cards, onEventClick }) {
  const now = new Date();
  return (
    <div
      className="absolute left-0 right-0 z-20 overflow-y-auto depth-floating"
      style={{
        top: '100%', maxHeight: 340, background: '#040c17', borderBottom: '2px solid #0891b2',
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)', padding: '14px 20px',
      }}
    >
      <div style={{ fontSize: 10, color: '#0e7490', letterSpacing: '0.3em', marginBottom: 8 }}>ACTIVE OPERATIONS</div>
      <div className="flex flex-wrap gap-2">
        {cards.map(ev => {
          const start = new Date(ev.start_time);
          const end = ev.end_time ? new Date(ev.end_time) : null;
          const isLive = start <= now && (!end || end >= now);
          const hasSlots = Number(ev.total_slots) > 0;
          const slotsOpen = hasSlots && Number(ev.filled_slots) < Number(ev.total_slots);
          return (
            <button
              key={ev.id}
              onClick={() => onEventClick?.(ev)}
              className="text-left flex-shrink-0 transition-colors glass-card"
              style={{ minWidth: 190, padding: '8px 10px', cursor: 'pointer' }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                {(ev.launched || isLive) && (
                  <span className="text-[10px] rounded px-1 py-0.5 tracking-widest animate-pulse badge-live">LIVE</span>
                )}
                {!ev.launched && !isLive && (
                  <span style={{ fontSize: 10, color: '#0e7490', letterSpacing: '0.15em' }}>
                    {start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </div>
              <div className="text-xs font-bold text-white/85 truncate">{ev.name}</div>
              {hasSlots && (
                <div className="text-[11px] mt-0.5" style={{ color: slotsOpen ? '#4ade80' : '#94a3b8' }}>
                  {ev.filled_slots}/{ev.total_slots} slots{slotsOpen ? ' — OPEN' : ''}
                </div>
              )}
            </button>
          );
        })}
      </div>
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

function TextChat({ orgId, channel, user }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [expandedImg, setExpandedImg] = useState(null);
  const [reportModal, setReportModal] = useState(null); // { msg }
  const endRef = useRef(null);

  // ── Load from local IndexedDB on channel change ───────────────────────────
  useEffect(() => {
    if (!channel?.id) return;
    let cancelled = false;
    setMessages([]);
    setLoading(true);
    getChannelMessages(channel.id).then(rows => {
      if (!cancelled) { setMessages(rows); setLoading(false); }
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [channel?.id]);

  // ── Register SSE relay handler ────────────────────────────────────────────
  useEffect(() => {
    _textChatRelayRef.current = (payload) => {
      if (payload.channel_id !== channel?.id) return;
      (async () => {
        const isOwnAccount = payload.sender_id === user?.id;
        let plaintext = null;
        try {
          plaintext = await decryptChannelOrRecallOwn(api, user?.id, channel.id, payload.encrypted_content, isOwnAccount);
        } catch {
          plaintext = null; // genuinely undecryptable (e.g. arrived before this device joined the group)
        }
        const msg = {
          id:                payload.id,
          channel_id:        payload.channel_id,
          sender_id:         payload.sender_id,
          callsign:          payload.callsign ?? null,
          global_tag:        payload.global_tag ?? null,
          encrypted_content: payload.encrypted_content,
          plaintext,
          image_url:         payload.image_url ?? null,
          timestamp:         payload.timestamp,
          received_at:       new Date().toISOString(),
        };
        saveChannelMessage(msg).catch(() => {});
        setMessages(prev => {
          if (prev.some(m => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
      })();
    };
    return () => { _textChatRelayRef.current = null; };
  }, [channel?.id, user?.id]);

  // ── Ask other online members for anything missing from our local history ──
  // There's no server copy to pull from, so this fans out over the same
  // per-channel relay subject everyone's already subscribed to.
  useEffect(() => {
    if (!channel?.id || !orgId) return;
    let cancelled = false;
    (async () => {
      const since = await getLatestChannelTimestamp(channel.id).catch(() => null);
      if (cancelled) return;
      api.requestChannelSync(orgId, channel.id, since).catch(() => {});
    })();
    return () => { cancelled = true; };
  }, [channel?.id, orgId]);

  // ── Answer another member's sync-request with whatever we have locally ───
  useEffect(() => {
    if (!channel?.id || !orgId) return;
    _textChatSyncRequestRef.current = (payload) => {
      if (payload.channel_id !== channel.id) return;
      if (payload.requester_id === user?.id) return; // don't answer our own request
      getChannelMessagesSince(channel.id, payload.since).then((rows) => {
        if (rows.length === 0) return;
        const messages = rows.map(({ id, sender_id, callsign, global_tag, encrypted_content, image_url, timestamp }) => (
          { id, sender_id, callsign, global_tag, encrypted_content, image_url, timestamp }
        ));
        api.respondChannelSync(orgId, channel.id, payload.requester_id, messages).catch(() => {});
      }).catch(() => {});
    };
    return () => { _textChatSyncRequestRef.current = null; };
  }, [channel?.id, orgId, user?.id]);

  // ── Merge a peer's answer to our own sync-request into local store + UI ───
  // Backfilled rows carry real ciphertext (see respondChannelSync's
  // field-picked payload) — each is decrypted once here, same one-shot
  // constraint as the live relay path, before it's ever stored or rendered.
  useEffect(() => {
    _textChatSyncResponseRef.current = (payload) => {
      if (payload.channel_id !== channel?.id || !payload.messages?.length) return;
      (async () => {
        const decrypted = await Promise.all(payload.messages.map(async (m) => {
          const isOwnAccount = m.sender_id === user?.id;
          let plaintext = null;
          try {
            plaintext = await decryptChannelOrRecallOwn(api, user?.id, channel.id, m.encrypted_content, isOwnAccount);
          } catch {
            plaintext = null;
          }
          return { ...m, channel_id: channel.id, plaintext, received_at: new Date().toISOString() };
        }));
        saveChannelMessages(channel.id, decrypted).catch(() => {});
        setMessages((prev) => {
          const existing = new Set(prev.map((m) => m.id));
          const fresh = decrypted.filter((m) => !existing.has(m.id));
          if (fresh.length === 0) return prev;
          return [...prev, ...fresh].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        });
      })();
    };
    return () => { _textChatSyncResponseRef.current = null; };
  }, [channel?.id, user?.id]);

  // ── Auto-scroll on new messages ───────────────────────────────────────────
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || !orgId || !channel?.id) return;
    setInput('');
    setSendError(null);
    setSending(true);
    try {
      await ensureChannelGroup(api, user?.id, orgId, channel.id);
      const ciphertext = await encryptChannel(api, user?.id, channel.id, text);
      notePendingSent(channel.id, text);
      const { error: sendApiError } = await api.sendMessage(orgId, channel.id, ciphertext);
      // api.js never throws on a failed request — it always resolves to
      // {data, error} (see fetchWithAuth) — so a failed send (expired token,
      // network drop, etc.) would fall through here silently unless checked
      // explicitly. Promote it to a thrown error so the catch block below
      // restores the input and surfaces it, same as a thrown MLS error.
      if (sendApiError) throw new Error(sendApiError);
      // Optimistic message arrives back via SSE message_relay
    } catch (err) {
      // A failure here (thrown MLS error from ensureChannelGroup/encryptChannel,
      // e.g. an epoch conflict from another client committing to the group at
      // the same time, or the promoted api error above) means api.sendMessage
      // never ran — there's nothing for the SSE relay to echo back, so the
      // message would otherwise vanish with zero feedback. Restore the text
      // so nothing typed is lost, and surface the failure.
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
                  plaintext is explicitly null means decryption was attempted and failed. */}
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

export default function WarRoom({ user, onLogout, initialConnectOrgId }) {
  const [orgs,               setOrgs]               = useState([]);
  const [selectedOrg,        setSelectedOrg]        = useState(null);
  const [events,             setEvents]             = useState([]);
  const [members,            setMembers]            = useState([]);
  const [channels,           setChannels]           = useState([]);
  const [activeChannel,      setActiveChannel]      = useState(null);  // currently viewed channel (text or voice)
  const [voiceChannel,       setVoiceChannel]       = useState(null);  // currently connected voice channel (independent)
  const [inComms,            setInComms]            = useState(false);
  const [showSettings,       setShowSettings]       = useState(false);
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
  const [calendarOpen,       setCalendarOpen]       = useState(false);
  const [opsListOpen,        setOpsListOpen]        = useState(false);
  const [serverPickerOpen,   setServerPickerOpen]   = useState(false);
  const [orgBilling,         setOrgBilling]         = useState(null);
  const [billingPanelOpen,   setBillingPanelOpen]   = useState(false);
  const [membersExpanded,    setMembersExpanded]    = useState(false);
  const [activeSharers,      setActiveSharers]      = useState([]); // callsigns of all active sharers
  const [watchTarget,        setWatchTarget]        = useState(null); // callsign to watch, or null
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

  const toggleOverlay = async () => {
    if (!window.__TAURI__) return;
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
      return;
    }
    if (_overlayToggleInProgress.current) {
      console.log('[overlay] toggleOverlay debounced — already in progress');
      return;
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
    } catch (e) {
      console.error('[overlay] toggle FAILED:', e);
      setIsOverlay(previousOverlayState);
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
      watchTarget,
      voiceChannelName: activeFreqName || voiceChannel?.name || null,
    };
  }, [voiceRoster, localSpeaking, activeSharers, remoteLevels, user, watchTarget, voiceChannel, activeFreqIdx, availableFreqs, voiceSharing]);

  // Emit current voice state to the overlay HUD window whenever it changes.
  useEffect(() => {
    if (!isOverlay || !window.__TAURI__) return;
    import('@tauri-apps/api/event').then(({ emit }) => {
      emit('overlay-update', overlayDataRef.current);
    });
  }, [isOverlay, voiceRoster, localSpeaking, activeSharers, remoteLevels, watchTarget, voiceChannel, voiceSharing]);

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
        setWatchTarget(event.payload?.callsign || null);
      }).then(fn => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, [isOverlay]);

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
      const channelToggleKey = localStorage.getItem('specter_channel_toggle_key') || '';
      const streamNextKey = localStorage.getItem('specter_stream_next_key') || '';
      const overlayPassthroughKey = localStorage.getItem('specter_overlay_passthrough_key') || '';

      if (voiceMode === 'push-to-talk' && pttKey) {
        try {
          await register(mapKey(pttKey), (ev) => {
            emit('specter://ptt-active', { active: ev.state === 'Pressed' });
          });
        } catch (e) { console.warn('PTT shortcut register failed:', e); }
      }

      if (channelToggleKey) {
        try {
          await register(mapKey(channelToggleKey), (ev) => {
            if (ev.state === 'Pressed') emit('specter://cycle-freq', {});
          });
        } catch (e) { console.warn('Channel toggle shortcut register failed:', e); }
      }

      if (streamNextKey) {
        try {
          await register(mapKey(streamNextKey), (ev) => {
            if (ev.state === 'Pressed') emit('specter://cycle-stream', {});
          });
        } catch (e) { console.warn('Stream cycle shortcut register failed:', e); }
      }

      if (overlayPassthroughKey) {
        try {
          await register(mapKey(overlayPassthroughKey), (ev) => {
            if (ev.state === 'Pressed') emit('specter://overlay-passthrough', {});
          });
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

  const refreshEventsCb = useCallback(() => {
    if (!selectedOrg) return;
    const hasCalendarAccess = selectedOrg?.owner_id === user?.id
      || selectedOrg?.permissions?.can_view_calendar === true
      || selectedOrg?.permissions?.can_create_events === true;
    if (!hasCalendarAccess) return;
    api.getOrgEvents(selectedOrg.id).then(({ data }) => {
      const evs = (data?.events || []).sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
      setEvents(evs);
    });
  }, [selectedOrg?.id, selectedOrg?.owner_id, selectedOrg?.permissions, user?.id]);

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

  const canLaunchEvent = useCallback((ev) => {
    if (!selectedOrg || !ev || ev.launched) return false;
    const uid = user?.id;
    if (!uid) return false;
    if (selectedOrg.owner_id === uid) return true;
    if (selectedOrg.permissions?.can_create_events === true) return true;
    if (selectedOrg.permissions?.can_manage_channels === true) return true;
    if (selectedOrg.role_name === 'Commander') return true;
    if (ev.creator_id === uid) return true;
    if (ev.commander_user_id === uid) return true;
    if ((ev.planners || []).some(p => p.user_id === uid)) return true;
    return false;
  }, [selectedOrg, user?.id]);

  const handleLaunchFromCard = useCallback(async (ev) => {
    if (!selectedOrg) return;
    if (!canLaunchEvent(ev)) return;
    const { error } = await api.launchEvent(selectedOrg.id, ev.id);
    if (!error) refreshEventsCb();
  }, [selectedOrg?.id, refreshEventsCb, canLaunchEvent]);

  useEventStream({
    // Org list changed (created, joined, kicked, dissolved)
    orgs_changed:     refreshOrgs,
    org_created:      refreshOrgs,
    // SSE stream just connected — refresh org list in case the initial fetch raced with startup
    connected:        refreshOrgs,
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
      _textChatRelayRef.current?.(payload);
      _dmCabinetRelayRef.current?.(payload);
      commLinkRelayRef.current?.(payload);
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
        handleChannelCommit(api, user?.id, payload.channel_id, payload.commit).catch(() => {});
      } else if (payload?.event_group_id && payload?.commit) {
        handleEventGroupCommit(api, user?.id, payload.event_group_id, payload.commit).catch(() => {});
      }
    },
    mls_welcome: (payload) => {
      if (payload?.conversation_id && payload?.welcome) {
        handleDmWelcome(api, user?.id, payload.conversation_id, payload.welcome).catch(() => {});
      } else if (payload?.channel_id && payload?.welcome) {
        handleChannelWelcome(api, user?.id, payload.channel_id, payload.welcome).catch(() => {});
      } else if (payload?.event_group_id && payload?.welcome) {
        handleEventGroupWelcome(api, user?.id, payload.event_group_id, payload.welcome).catch(() => {});
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
    setCalendarOpen(false);
    setActiveSharers([]);
    setWatchTarget(null);
    setChannelPresence({});
    setOrgBilling(null);
    setBillingPanelOpen(false);
    setEventChannelAccess({});

    api.getOrgEvents(selectedOrg.id).then(({ data }) => {
      const evs = (data?.events || []).sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
      setEvents(evs);
    });
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
  }, [selectedOrg?.id]);

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
  const canViewCalendar = selectedOrg?.owner_id === user?.id
    || selectedOrg?.permissions?.can_view_calendar === true
    || selectedOrg?.permissions?.can_create_events === true;
  // can schedule = org admin, or role explicitly granted create-events permission
  const canScheduleEvents = isCommander || selectedOrg?.permissions?.can_create_events === true;
  const canEditOperationEvent = useCallback((ev) => {
    const uid = user?.id;
    if (!uid || !ev) return false;
    if (selectedOrg?.owner_id === uid) return true;
    if (ev.creator_id === uid) return true;
    return (ev.planners || []).some(p => p.user_id === uid);
  }, [selectedOrg?.owner_id, user?.id]);
  const handleOpenEventComp = useCallback((ev) => {
    if (!ev) return;
    setGroupCompEvent(ev);
    setCalendarOpen(false);
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
    {/* ── Main layout ─────────────────────────────────────────────────── */}
    <div
      className="h-screen text-white font-mono flex flex-col overflow-hidden select-none hud-projected holo-viewport app-shell"
      style={{ background: '#030a13', paddingTop: window.__TAURI__ ? 28 : 0, display: isLocalOverlayActive ? 'none' : 'flex' }}
    >
      {/* ─────────────────── Main 3-column layout ─────────────────── */}
      <div className="flex flex-1 overflow-hidden bg-transparent depth-stage">

        {/* ══ LEFT: Org switcher + Channel list ══════════════════════ */}
        <aside
          className="flex flex-col overflow-hidden hud-panel-side hud-border-r bg-specter-bg-surface depth-surface depth-elev-2 panel"
          style={{ width: 220, minWidth: 220, background: 'transparent' }}
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

            {/* Top row: hex logo + server name + wallet icon */}
            <div className="flex items-center gap-2 px-3 py-2 hud-border-b" style={{ flexShrink: 0 }}>
              {/* Hex org logo (or Specter S fallback) */}
              {selectedOrg?.logo_url ? (
                <div style={{ width: 20, height: 20, flexShrink: 0, clipPath: HEX_PATH, overflow: 'hidden' }}>
                  <img src={`${UPLOADS_BASE_URL}${selectedOrg.logo_url}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
              ) : (
                <div style={{ position: 'relative', width: 20, height: 20, flexShrink: 0 }}>
                  <div style={{ clipPath: HEX_PATH, background: '#06b6d4', width: 20, height: 20, position: 'absolute' }} />
                  <div style={{
                    clipPath: HEX_PATH, background: '#030a13',
                    width: 14, height: 14, position: 'absolute', top: 3, left: 3,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <span style={{ color: '#06b6d4', fontSize: 6, fontWeight: 'bold' }}>S</span>
                  </div>
                </div>
              )}

              {/* Server name — click to open server picker */}
              <button
                onClick={() => setServerPickerOpen(o => !o)}
                className="flex-1 flex items-center gap-1 min-w-0 text-left"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                {selectedOrg ? (
                  <span className="truncate" style={{ fontSize: 13, fontWeight: 'bold', color: '#e5e7eb', letterSpacing: '0.05em', flex: 1 }}>
                    {selectedOrg.callsign}
                  </span>
                ) : (
                  <span style={{ fontSize: 12, color: '#0e7490', letterSpacing: '0.15em', flex: 1 }}>SELECT SERVER</span>
                )}
                <span style={{ fontSize: 9, color: '#0e7490', flexShrink: 0 }}>{serverPickerOpen ? '▲' : '▼'}</span>
              </button>

              {/* Wallet icon — opens the server billing panel when the billing UI flag is on */}
              <button
                title={BILLING_UI_ENABLED && orgBilling?.payments?.enabled ? 'Server wallet' : 'Server wallet — coming soon'}
                onClick={() => {
                  if (BILLING_UI_ENABLED && orgBilling?.payments?.enabled && selectedOrg) setBillingPanelOpen(true);
                }}
                style={{
                  background: 'transparent',
                  border: '1px solid #0e2233',
                  borderRadius: 4,
                  padding: '3px 5px',
                  cursor: 'pointer',
                  color: '#0e7490',
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  lineHeight: 1,
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#0891b2'; e.currentTarget.style.color = '#22d3ee'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = '#0e2233'; e.currentTarget.style.color = '#0e7490'; }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 12V22H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h16v4"/>
                  <path d="M20 12a2 2 0 0 0-2 2v0a2 2 0 0 0 2 2h4v-4h-4z"/>
                </svg>
              </button>
            </div>

            {/* Billing cycle consumption bars */}
            {selectedOrg && (() => {
              const dataBytes  = orgBilling?.cycle?.bytes_out ?? 0;
              const dataLimit  = orgBilling?.tier_limits?.data_bytes ?? 1;
              const dataPct    = Math.min(100, Math.round(dataBytes / dataLimit * 100));
              const dataColor  = barColor(dataPct);
              const dataLabel  = orgBilling ? `${fmtBytes(dataBytes)} / ${fmtBytes(dataLimit)}` : '—';
              return (
                <div style={{ ...GLASS_PANEL, padding: '5px 10px 6px', borderRadius: 8, margin: '0 8px 8px' }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                      <span style={{ fontSize: 9, color: dataColor?.label || '#0e7490', letterSpacing: '0.12em', fontFamily: 'monospace' }}>DATA</span>
                      <span style={{ fontSize: 9, color: dataColor?.label || '#22d3ee', fontFamily: 'monospace' }}>{dataLabel}</span>
                    </div>
                    <div style={{ height: 3, background: '#041018', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ width: `${dataPct}%`, height: '100%', background: dataColor?.bar || 'linear-gradient(90deg, #0e7490, #22d3ee)', borderRadius: 2, transition: 'width 0.6s' }} />
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Dropdown server list */}
            {serverPickerOpen && (
              <div
                style={{
                  ...GLASS_PANEL,
                  position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
                  borderTop: 'none',
                  maxHeight: 240, overflowY: 'auto',
                }}
              >
                {loading && <div style={{ padding: '8px 12px', fontSize: 13, color: '#0e7490' }}>Loading...</div>}
                {orgs.map((org, i) => {
                  const col = getOrgColor(i);
                  const c = COLOR_MAP[col];
                  const isAct = selectedOrg?.id === org.id;
                  return (
                    <button
                      key={org.id}
                      onClick={() => { setSelectedOrg(org); setServerPickerOpen(false); }}
                      className="w-full flex items-center gap-2 text-left transition-all"
                      style={{
                        padding: '6px 12px',
                        background: isAct ? `${c.bg}cc` : 'transparent',
                        borderLeft: `2px solid ${isAct ? c.glow : 'transparent'}`,
                      }}
                      onMouseEnter={e => { if (!isAct) e.currentTarget.style.background = '#050f1a'; }}
                      onMouseLeave={e => { if (!isAct) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <HexBadge letter={(org.callsign || '?')[0]} colorKey={col} size={28} active={isAct} imageUrl={org.logo_url ? `${UPLOADS_BASE_URL}${org.logo_url}` : null} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate" style={{ fontSize: 13, fontWeight: 'bold', color: isAct ? c.text : '#cbd5e1' }}>
                          {org.callsign}
                        </div>
                        <div style={{ fontSize: 10, color: isAct ? c.glow : '#0e7490', letterSpacing: '0.15em' }}>
                          {isAct ? '● ACTIVE' : '○ STANDBY'}
                        </div>
                      </div>
                    </button>
                  );
                })}
                {!loading && orgs.length === 0 && (
                  <div style={{ padding: '10px 12px', fontSize: 13, color: '#0e7490', textAlign: 'center' }}>No servers joined</div>
                )}
              </div>
            )}
          </div>

          {/* ── Channel list ─────────────────────────────────────────── */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {selectedOrg ? (
              <>
                {/* Section header */}
                <div className="flex items-center justify-between px-3 pt-2.5 pb-1 flex-shrink-0">
                  <span style={{ fontSize: 11, color: '#0e7490', letterSpacing: '0.35em' }}>CHANNELS</span>
                  <div className="flex items-center gap-1">
                    {isCommander && (
                      <button
                        onClick={() => setShowOrgSettings(true)}
                        title="Server settings"
                        style={{
                          fontSize: 14, lineHeight: 1, color: '#0e7490',
                          background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px',
                          transition: 'color 0.15s',
                        }}
                        onMouseEnter={e => e.currentTarget.style.color = '#22d3ee'}
                        onMouseLeave={e => e.currentTarget.style.color = '#0e7490'}
                      >
                        ⚙
                      </button>
                    )}
                    {isCommander && (
                    <button
                      onClick={() => setShowCreateChan(v => !v)}
                      title="Add channel"
                      style={{
                        fontSize: 16, lineHeight: 1, color: showCreateChan ? '#22d3ee' : '#0e7490',
                        background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px',
                        transition: 'color 0.15s',
                      }}
                      onMouseEnter={e => e.currentTarget.style.color = '#22d3ee'}
                      onMouseLeave={e => e.currentTarget.style.color = showCreateChan ? '#22d3ee' : '#0e7490'}
                    >
                      +
                    </button>
                  )}
                  </div>
                </div>

                {/* Create channel form */}
                {showCreateChan && isCommander && (
                  <form
                    onSubmit={handleCreateChannel}
                    className="px-3 pb-2 flex-shrink-0 space-y-1.5"
                    style={{ borderBottom: '1px solid #0e2233' }}
                  >
                    <input
                      autoFocus
                      value={newChanName}
                      onChange={e => setNewChanName(e.target.value)}
                      placeholder="channel-name"
                      maxLength={32}
                      style={{
                        width: '100%', background: '#041018', border: '1px solid #0e2233',
                        borderRadius: 3, padding: '4px 8px', fontSize: 13, color: '#e5e7eb',
                        outline: 'none', fontFamily: 'monospace',
                      }}
                      onFocus={e => e.target.style.borderColor = '#0891b2'}
                      onBlur={e => e.target.style.borderColor = '#0e2233'}
                    />
                    <div className="flex gap-1.5">
                      {[{ v: 0, label: '◉ Voice' }, { v: 1, label: '☰ Text' }].map(opt => (
                        <button
                          key={opt.v}
                          type="button"
                          onClick={() => setNewChanKind(opt.v)}
                          style={{
                            flex: 1, fontSize: 13, padding: '3px 0', borderRadius: 3, cursor: 'pointer',
                            background: newChanKind === opt.v ? '#041e2e' : 'transparent',
                            border: `1px solid ${newChanKind === opt.v ? '#0891b2' : '#0e2233'}`,
                            color: newChanKind === opt.v ? '#22d3ee' : '#cbd5e1',
                            transition: 'all 0.15s',
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        type="submit"
                        disabled={chanCreateLoading || !newChanName.trim()}
                        style={{
                          flex: 1, fontSize: 13, padding: '4px 0', borderRadius: 3,
                          background: '#041e2e', border: '1px solid #0891b2',
                          color: '#22d3ee', cursor: 'pointer',
                          opacity: (!newChanName.trim() || chanCreateLoading) ? 0.4 : 1,
                        }}
                      >
                        {chanCreateLoading ? '...' : 'Create'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowCreateChan(false); setNewChanName(''); setChanCreateError(null); }}
                        style={{
                          flex: 1, fontSize: 13, padding: '4px 0', borderRadius: 3,
                          background: 'transparent', border: '1px solid #0e2233',
                          color: '#cbd5e1', cursor: 'pointer',
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                    {chanCreateError && (
                      <div style={{ fontSize: 10, color: '#ef4444', padding: '2px 0', letterSpacing: '0.05em' }}>
                        {chanCreateError}
                      </div>
                    )}
                  </form>
                )}

                {/* Channel rows */}
                <div className="flex-1 overflow-y-auto">
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
                            {renderVoiceChannel(ch, isActive, isJoined, depth)}
                            {isJoined ? renderRoster() : (chOccupants.length > 0 && (
                              <div>
                                {chOccupants.map(u => {
                                  const om = members.find(m => (m.callsign || m.username) === u);
                                  const oUrl = om?.avatar_url ? `${UPLOADS_BASE_URL}${om.avatar_url}` : null;
                                  return (
                                    <div key={u} onClick={() => setProfileModalUser({ callsign: u })} style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 20, paddingRight: 12, paddingTop: 2, paddingBottom: 2, fontSize: 13, color: '#94a3b8', cursor: 'pointer' }}>
                                      <HexBadge letter={u[0]} colorKey="blue" size={16} imageUrl={oUrl} />
                                      <span>{u}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            ))}
                            {(childMap[ch.id] || []).map(child => renderNode(child, depth + 1))}
                          </div>
                        );
                      };
                      return roots.map(ch => renderNode(ch));
                    };

                    // Helper to render a voice channel row
                    const renderVoiceChannel = (ch, isActive, isJoined, depth = 0) => (
                      <div
                        className={`group flex items-center gap-2 px-3 py-2 cursor-pointer transition-all glass-card ${isActive ? 'glass-card--active' : ''}`}
                        style={{
                          paddingLeft: 12 + depth * 14,
                        }}
                        onClick={() => {
                          setActiveChannel(ch);
                          if (!isJoined) {
                            setVoiceChannel(ch);
                            setInComms(true);
                          }
                        }}
                      >
                        {depth > 0 && <span style={{ fontSize: 9, color: '#0891b2', marginRight: -4 }}>└</span>}
                        <span style={{ fontSize: 12, color: isJoined ? '#22c55e' : isActive ? '#22d3ee' : '#2d5a6e', flexShrink: 0 }}>◉</span>
                        <span className="flex-1 truncate" style={{ fontSize: 13, color: isActive ? '#e5e7eb' : '#94a3b8' }}>
                          {ch.name}
                        </span>
                        {isJoined && (
                          <button
                            className="opacity-70 hover:opacity-100 transition-opacity"
                            onClick={e => { e.stopPropagation(); setInComms(false); setVoiceChannel(null); setVoiceRoster([]); setMonitorChannels([]); setAvailableFreqs([]); setActiveFreqIdx(0); }}
                            style={{
                              fontSize: 10, color: '#ef4444', background: 'none',
                              border: 'none', cursor: 'pointer', padding: '0 2px', flexShrink: 0,
                            }}
                            title="Disconnect"
                          >
                            ✕
                          </button>
                        )}
                        {isCommander && !isJoined && (
                          <button
                            className="opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={e => { e.stopPropagation(); handleDeleteChannel(ch.id); }}
                            style={{
                              fontSize: 10, color: '#7f1d1d', background: 'none',
                              border: 'none', cursor: 'pointer', padding: '0 2px', flexShrink: 0,
                            }}
                            onMouseEnter={e => e.currentTarget.style.color = '#ef4444'}
                            onMouseLeave={e => e.currentTarget.style.color = '#7f1d1d'}
                            title="Delete channel"
                          >
                            ✕
                          </button>
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
                        <>
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
                                  <div className="flex items-center gap-1 pl-7 pr-2 pt-1 pb-0.5">
                                    <button
                                      onClick={e => { e.stopPropagation(); commLinkActionsRef.current?.toggleMic?.(); }}
                                      style={{
                                        fontSize: 9, letterSpacing: '0.08em', padding: '2px 6px',
                                        border: voiceMuted ? '1px solid #374151' : '1px solid #22c55e',
                                        background: voiceMuted ? 'transparent' : 'rgba(34,197,94,0.08)',
                                        color: voiceMuted ? '#6b7280' : '#22c55e',
                                        borderRadius: 2, cursor: 'pointer', flexShrink: 0,
                                      }}
                                      title={voiceMuted ? 'Unmute mic' : 'Mute mic'}
                                    >
                                      {voiceMuted ? '⊘ MUTE' : (
                                        <svg width="10" height="13" viewBox="0 0 10 13" fill="currentColor" style={{display:'inline',verticalAlign:'middle'}}>
                                          <rect x="3" y="0" width="4" height="7" rx="2"/>
                                          <path d="M1 5.5a4 4 0 0 0 8 0" stroke="currentColor" strokeWidth="1.3" fill="none"/>
                                          <line x1="5" y1="9.5" x2="5" y2="11.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                                          <line x1="3" y1="11.5" x2="7" y2="11.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                                        </svg>
                                      )}
                                    </button>
                                    <button
                                      onClick={e => {
                                        e.stopPropagation();
                                        voiceSharing
                                          ? commLinkActionsRef.current?.stopScreenShare?.()
                                          : commLinkActionsRef.current?.startScreenShare?.();
                                      }}
                                      style={{
                                        fontSize: 9, letterSpacing: '0.08em', padding: '2px 6px',
                                        border: voiceSharing ? '1px solid #ef4444' : '1px solid #2d6a9f',
                                        background: voiceSharing ? 'rgba(239,68,68,0.08)' : 'transparent',
                                        color: voiceSharing ? '#ef4444' : '#5a9abf',
                                        borderRadius: 2, cursor: 'pointer', flexShrink: 0,
                                      }}
                                      title={voiceSharing ? 'Stop screen share' : 'Share screen'}
                                    >
                                      {voiceSharing ? (
                                        <svg width="11" height="10" viewBox="0 0 11 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" style={{display:'inline',verticalAlign:'middle'}}>
                                          <rect x="0.5" y="0.5" width="10" height="7" rx="1"/>
                                          <line x1="3.5" y1="9.5" x2="7.5" y2="9.5"/>
                                          <line x1="5.5" y1="7.5" x2="5.5" y2="9.5"/>
                                          <line x1="3" y1="4" x2="5.5" y2="1.5"/>
                                          <line x1="8" y1="4" x2="5.5" y2="1.5"/>
                                        </svg>
                                      ) : (
                                        <svg width="11" height="10" viewBox="0 0 11 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" style={{display:'inline',verticalAlign:'middle'}}>
                                          <rect x="0.5" y="0.5" width="10" height="7" rx="1"/>
                                          <line x1="3.5" y1="9.5" x2="7.5" y2="9.5"/>
                                          <line x1="5.5" y1="7.5" x2="5.5" y2="9.5"/>
                                          <line x1="3" y1="5" x2="5.5" y2="2.5"/>
                                          <line x1="8" y1="5" x2="5.5" y2="2.5"/>
                                        </svg>
                                      )}
                                    </button>
                                  </div>
                                )}
                                {/* User name row */}
                                <div
                                  className="flex items-center gap-1.5 pl-7 pr-3 py-0.5 cursor-pointer"
                                  style={{ fontSize: 13, color: speaking ? '#22c55e' : '#94a3b8' }}
                                  onClick={e => { e.stopPropagation(); setProfileModalUser({ callsign: r, isLocal }); }}
                                  title={isLocal ? 'Click to adjust mic gain' : 'Click to view profile'}
                                >
                                  <span style={{ fontSize: 8, color: speaking ? '#22c55e' : '#2d5a6e', textShadow: speaking ? '0 0 6px rgba(34,197,94,0.8)' : 'none' }}>●</span>
                                  <span className="truncate">{r}{connecting && isLocal && <span style={{ color: '#4b5563', fontSize: 9, marginLeft: 4 }}>(connecting…)</span>}</span>
                                  {isSharer && (
                                    <span style={{ fontSize: 8, color: '#22d3ee', marginLeft: 2 }} title="Sharing screen">📺</span>
                                  )}
                                  {rowLocallyMuted && (
                                    <span style={{ fontSize: 9, color: '#f59e0b', marginLeft: 2 }} title="Muted for you only">🔇</span>
                                  )}
                                </div>
                                {/* Audio level bar */}
                                <div className="pl-7 pr-3 pb-1">
                                  <div style={{ height: 3, background: '#0e1c2c', borderRadius: 2, overflow: 'hidden' }}>
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
                                    onClick={() => setWatchTarget(prev => prev === r ? null : r)}
                                    className="ml-8 mb-1 text-left transition-colors hover:text-cyan-300"
                                    style={{ fontSize: 10, color: watchTarget === r ? '#22c55e' : '#0891b2', letterSpacing: '0.1em' }}
                                  >
                                    {watchTarget === r ? '◉ WATCHING' : '▶ VIEW STREAM'}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </>
                      );
                    };

                    return (
                      <>
                        {/* Regular voice channels */}
                        {regularVoice.length > 0 && (
                          <div>
                            <div className="px-3 pt-2 pb-0.5" style={{ fontSize: 10, color: '#22d3ee', letterSpacing: '0.3em' }}>VOICE</div>
                            {regularVoice.map(ch => {
                              const isJoined = inComms && voiceChannel?.id === ch.id;
                              const isActive = activeChannel?.id === ch.id || isJoined;
                              const chOccupants = channelPresence[ch.id] || [];
                              return (
                                <div key={ch.id}>
                                  {renderVoiceChannel(ch, isActive, isJoined)}
                                  {isJoined ? renderRoster() : (chOccupants.length > 0 && (
                                    <div>
                                      {chOccupants.map(u => {
                                        const om = members.find(m => (m.callsign || m.username) === u);
                                        const oUrl = om?.avatar_url ? `${UPLOADS_BASE_URL}${om.avatar_url}` : null;
                                        return (
                                          <div key={u} onClick={() => setProfileModalUser({ callsign: u })} style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 20, paddingRight: 12, paddingTop: 2, paddingBottom: 2, fontSize: 13, color: '#94a3b8', cursor: 'pointer' }}>
                                            <HexBadge letter={u[0]} colorKey="blue" size={16} imageUrl={oUrl} />
                                            <span>{u}</span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  ))}
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
                      <div className="px-3 pt-2 pb-0.5" style={{ fontSize: 10, color: '#22d3ee', letterSpacing: '0.3em' }}>TEXT</div>
                      {channels.filter(ch => (ch.channel_kind ?? 0) === 1).map(ch => {
                        const isActive = activeChannel?.id === ch.id;
                        return (
                          <div
                            key={ch.id}
                            className={`group flex items-center gap-2 px-3 py-2 cursor-pointer transition-all glass-card ${isActive ? 'glass-card--active' : ''}`}
                            onClick={() => setActiveChannel(ch)}
                          >
                            <span style={{ fontSize: 12, color: isActive ? '#22d3ee' : '#2d5a6e', flexShrink: 0 }}>#</span>
                            <span className="flex-1 truncate" style={{ fontSize: 13, color: isActive ? '#e5e7eb' : '#94a3b8' }}>
                              {ch.name}
                            </span>
                            {isCommander && (
                              <button
                                className="opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={e => { e.stopPropagation(); handleDeleteChannel(ch.id); }}
                                style={{
                                  fontSize: 10, color: '#7f1d1d', background: 'none',
                                  border: 'none', cursor: 'pointer', padding: '0 2px', flexShrink: 0,
                                }}
                                onMouseEnter={e => e.currentTarget.style.color = '#ef4444'}
                                onMouseLeave={e => e.currentTarget.style.color = '#7f1d1d'}
                                title="Delete channel"
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {channels.length === 0 && (
                    <div style={{ padding: '14px 14px', fontSize: 13, color: '#0e7490', textAlign: 'center' }}>
                      {isCommander ? 'No channels yet — create one above' : 'No channels available'}
                    </div>
                  )}

                  {/* ── Collapsible Members List ─────────────────────── */}
                  {members.length > 0 && (
                    <div style={{ borderTop: '1px solid #0e2233', marginTop: 4 }}>
                      <button
                        onClick={() => setMembersExpanded(v => !v)}
                        className="w-full flex items-center justify-between px-3 py-2"
                        style={{ background: 'none', border: 'none', cursor: 'pointer' }}
                        onMouseEnter={e => e.currentTarget.style.background = '#050f1a'}
                        onMouseLeave={e => e.currentTarget.style.background = 'none'}
                      >
                        <span style={{ fontSize: 10, color: '#0e7490', letterSpacing: '0.35em' }}>MEMBERS</span>
                        <div className="flex items-center gap-1.5">
                          <span style={{
                            fontSize: 9, color: '#0e7490', background: '#041018',
                            border: '1px solid #0e4a5a', padding: '1px 6px', letterSpacing: '0.15em',
                          }}>
                            {members.length}
                          </span>
                          <span style={{ fontSize: 9, color: '#2d5a6e' }}>{membersExpanded ? '▲' : '▼'}</span>
                        </div>
                      </button>

                      {membersExpanded && (
                        <div style={{ paddingBottom: 6 }}>
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
                                  className="flex items-center gap-2 px-3 py-1 cursor-pointer"
                                  style={{ fontSize: 13 }}
                                  onClick={() => setProfileModalUser({ callsign: m.callsign || m.username, isLocal: (m.callsign || m.username) === (user?.callsign || user?.username) })}
                                  onMouseEnter={e => e.currentTarget.style.background = '#050f1a'}
                                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                >
                                  <HexBadge letter={(m.callsign || '?')[0]} colorKey="blue" size={18} online={isOnline} imageUrl={avatarUrl} />
                                  <span className="truncate" style={{ color: isOnline ? '#94a3b8' : '#374151' }}>
                                    {m.callsign || m.username}
                                  </span>
                                </div>
                              );
                            };
                            return (
                              <>
                                {online.length > 0 && (
                                  <>
                                    <div style={{ fontSize: 9, color: '#1e4060', letterSpacing: '0.25em', padding: '4px 12px 2px' }}>ONLINE — {online.length}</div>
                                    {online.map(renderMember)}
                                  </>
                                )}
                                {offline.length > 0 && (
                                  <>
                                    <div style={{ fontSize: 9, color: '#1e3040', letterSpacing: '0.25em', padding: '4px 12px 2px' }}>OFFLINE — {offline.length}</div>
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
              <div style={{ padding: '20px 14px', fontSize: 13, color: '#0e7490', textAlign: 'center' }}>
                Select a server to see channels
              </div>
            )}
          </div>

          {/* Op channel panel — shown during active operation */}
          {inComms && voiceChannel && activeOp?.launched && (() => {
            const opChannels = channels.filter(c => c.event_id === activeOp.id && (c.channel_kind ?? 0) === 0);
            if (opChannels.length === 0) return null;
            return (
              <div style={{ ...GLASS_PANEL, borderRadius: 8, margin: '8px', padding: '6px 10px' }}>
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

          {/* User footer */}
          <div style={{ borderTop: '1px solid #0e2233', padding: '7px 10px', flexShrink: 0 }}>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setLeftTab(leftTab === 'profile' || leftTab === 'dm' ? null : 'profile')}
                style={{ background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0, padding: 0, position: 'relative' }}
              >
                <HexBadge letter={(user?.callsign || 'U')[0]} colorKey="cyan" size={26} active={leftTab === 'profile' || leftTab === 'dm'} imageUrl={user?.avatar_url ? `${UPLOADS_BASE_URL}${user.avatar_url}` : null} />
                {dmNotif && (
                  <span style={{
                    position: 'absolute', top: -3, right: -3, width: 9, height: 9, borderRadius: '50%',
                    background: '#ef4444', border: '1.5px solid #040c17',
                  }} />
                )}
              </button>
              <div className="flex-1 min-w-0">
                <div className="truncate" style={{ fontSize: 13, fontWeight: 'bold', color: '#67e8f9' }}>{user?.callsign}</div>
                <div style={{ fontSize: 13, color: '#0e7490', letterSpacing: '0.2em' }}>● ONLINE</div>
              </div>
              <button
                onClick={onLogout}
                style={{
                  fontSize: 13, padding: '4px 8px', borderRadius: 3, letterSpacing: '0.2em',
                  background: 'transparent', border: '1px solid #0e2233', color: '#0e7490', cursor: 'pointer', flexShrink: 0,
                }}
                onMouseEnter={e => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.borderColor = '#450a0a'; }}
                onMouseLeave={e => { e.currentTarget.style.color = '#0e7490'; e.currentTarget.style.borderColor = '#0e2233'; }}
              >
                LOGOUT
              </button>
            </div>
          </div>
        </aside>

        {/* ══ CABINET: Profile + Contacts / DM slide-out ════════════════ */}
        {leftTab && (
          <div
            className="depth-surface depth-elev-2"
            style={{
              position: 'absolute', left: 220, top: 0, bottom: 0, width: 260, zIndex: 10,
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
                onConnectionQualityChange={setVoiceConnectionQuality}
                localMutedUserIds={localMutedUsers}
                externalControlsRef={commLinkActionsRef}
                hideMuteButton
                embedded
                overlayActive={isOverlay}
                onRelayRef={commLinkRelayRef}
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

          {/* Op header bar — also the anchor for the Operations/Calendar toggle
              dropdowns below, so neither one permanently eats a row of
              vertical space when there's nothing urgent in it. */}
          {(() => {
            const opsCards = selectedOrg ? getActiveOpsCards(events) : [];
            const upcomingCount = events.filter(e => !e.end_time || new Date(e.end_time) > new Date()).length;
            return (
          <div
            className="flex items-center justify-between px-5 py-3 flex-shrink-0"
            style={{ ...GLASS_PANEL, position: 'relative', zIndex: 2 }}
          >
            <div>
              <div style={{ fontSize: 11, color: '#0e7490', letterSpacing: '0.35em', textTransform: 'uppercase' }}>
                Active Operation
              </div>
              <div style={{ fontSize: 14, fontWeight: 'bold', color: '#e5e7eb', letterSpacing: '0.08em', marginTop: 2 }}>
                {activeOp
                  ? activeOp.name.toUpperCase()
                  : selectedOrg
                    ? `${selectedOrg.callsign.toUpperCase()} — STANDBY`
                    : 'SELECT SERVER'}
              </div>
              {activeOp && (
                <div style={{ fontSize: 13, color: '#0891b2', marginTop: 2, letterSpacing: '0.1em' }}>
                  {new Date(activeOp.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {activeOp.end_time && (
                    <>{' — '}{new Date(activeOp.end_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{' UTC'}</>
                  )}
                </div>
              )}
            </div>

            {/* Comms indicator */}
            <div className="flex items-center gap-2">
              {voiceChannel && inComms && (
                <span style={{ fontSize: 13, color: '#22c55e', letterSpacing: '0.15em' }}>
                  ◉ {voiceChannel.name} — CONNECTED
                </span>
              )}
              {activeChannel && (activeChannel.channel_kind ?? 0) === 1 && (
                <span style={{ fontSize: 13, color: '#0891b2', letterSpacing: '0.15em' }}>
                  # {activeChannel.name}
                </span>
              )}
              {/* Active Operations toggle — was its own always-visible banner row */}
              {selectedOrg && opsCards.length > 0 && (
                <button
                  onClick={() => { setOpsListOpen(o => !o); setCalendarOpen(false); }}
                  className="flex items-center gap-1.5"
                  style={{
                    fontSize: 13, padding: '3px 10px', borderRadius: 3,
                    letterSpacing: '0.15em', cursor: 'pointer', transition: 'all 0.2s',
                    background: opsListOpen ? '#0c1a2a' : '#0a1520',
                    border: `1px solid ${opsListOpen ? '#22d3ee' : '#0e7490'}`,
                    color: opsListOpen ? '#22d3ee' : '#0e7490',
                  }}
                >
                  OPERATIONS
                  <span style={{ fontSize: 10, border: '1px solid currentColor', borderRadius: 3, padding: '0 5px' }}>
                    {opsCards.length}
                  </span>
                </button>
              )}
              {/* Calendar toggle — was its own full-width tab bar further down */}
              {selectedOrg && !watchTarget && (
                <button
                  onClick={() => { setCalendarOpen(o => !o); setOpsListOpen(false); }}
                  className="flex items-center gap-1.5"
                  style={{
                    fontSize: 13, padding: '3px 10px', borderRadius: 3,
                    letterSpacing: '0.15em', cursor: 'pointer', transition: 'all 0.2s',
                    background: calendarOpen ? '#0c1a2a' : '#0a1520',
                    border: `1px solid ${calendarOpen ? '#22d3ee' : '#0e7490'}`,
                    color: calendarOpen ? '#22d3ee' : '#0e7490',
                  }}
                >
                  CALENDAR
                  {upcomingCount > 0 && (
                    <span style={{ fontSize: 10, border: '1px solid currentColor', borderRadius: 3, padding: '0 5px' }}>
                      {upcomingCount}
                    </span>
                  )}
                </button>
              )}
              {/* CA-3d: Overlay button visible whenever we're in the Tauri app (no activeChannel gate).
                  Previously required activeChannel, but overlay is useful as soon as WarRoom is open. */}
              {window.__TAURI__ && (
                <button
                  onClick={toggleOverlay}
                  style={{
                    fontSize: 13, padding: '3px 10px', borderRadius: 3,
                    letterSpacing: '0.15em',
                    cursor: 'pointer',
                    background: isOverlay ? '#0c2a1a' : '#0a1520',
                    border: `1px solid ${isOverlay ? '#16a34a' : '#0e7490'}`,
                    color: isOverlay ? '#22c55e' : '#22d3ee',
                    transition: 'all 0.2s',
                  }}
                >
                  {isOverlay ? 'EXIT OVERLAY' : 'OVERLAY'}
                </button>
              )}
              {inComms && (
                <button
                  onClick={() => { setInComms(false); setVoiceChannel(null); setMonitorChannels([]); setAvailableFreqs([]); setActiveFreqIdx(0); }}
                  style={{
                    fontSize: 13, padding: '3px 10px', borderRadius: 3,
                    letterSpacing: '0.15em',
                    cursor: 'pointer',
                    background: '#1c0a0a',
                    border: '1px solid #450a0a',
                    color: '#ef4444',
                    transition: 'all 0.2s',
                  }}
                >
                  DISCONNECT
                </button>
              )}
              {/* END OPERATION button — for org commanders or the assigned operation commander */}
              {(isCommander || isOpCommander) && activeOp?.launched && (
                <button
                  onClick={() => setEndOpModal(true)}
                  style={{
                    fontSize: 13, padding: '3px 10px', borderRadius: 3,
                    letterSpacing: '0.15em', cursor: 'pointer',
                    background: '#3b0000', border: '1px solid #991b1b', color: '#fca5a5',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#7f1d1d'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = '#3b0000'; }}
                >
                  END OPERATION
                </button>
              )}
            </div>

            {/* Active Operations dropdown — anchored to this header (position: relative above) */}
            {selectedOrg && opsListOpen && opsCards.length > 0 && (
              <ActiveOperationsDropdown
                cards={opsCards}
                onEventClick={(ev) => { handleOpenEventComp(ev); setOpsListOpen(false); }}
              />
            )}

          </div>
            );
          })()}

          {/* Full ops calendar — pushed inline below the header (normal document
              flow) instead of floating over the body, so opening it never covers
              (or gets covered by) the rest of the WarRoom content. Same panel
              ServerHome.jsx shows on the server landing page, not the old
              cramped/collapsed dropdown variant. */}
          {selectedOrg && calendarOpen && !watchTarget && (
            <div className="overflow-y-auto flex-shrink-0" style={{ maxHeight: '60vh', padding: '16px 20px', borderBottom: '1px solid rgba(8,145,178,0.35)' }}>
              <OpsCalendarPanel
                events={events}
                orgId={selectedOrg?.id}
                canScheduleEvents={canScheduleEvents}
                onSchedule={canScheduleEvents ? () => { setPlannerEvent('create'); setCalendarOpen(false); } : null}
                onOpenEvent={handleOpenEventComp}
                onLaunchEvent={handleLaunchFromCard}
                canLaunchEvent={canLaunchEvent}
              />
            </div>
          )}

          {/* Body: comms / text chat / calendar */}
          <div className="flex flex-1 overflow-hidden">

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
                  <div style={{ ...GLASS_PANEL, borderRadius: 8, margin: '8px 8px 0', flexShrink: 0, padding: '6px 14px 8px' }}>
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
                  <TextChat orgId={selectedOrg?.id} channel={activeChannel} user={user} />
                </div>
              ) : !inComms || !voiceChannel ? (
                activeChannel && (activeChannel.channel_kind ?? 0) === 0 ? (
                  /* Viewing a voice channel but not connected */
                  <div className="flex-1 flex items-center justify-center" style={{ background: '#040c17' }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.3 }}>◉</div>
                      <div style={{ fontSize: 13, color: '#0e7490', letterSpacing: '0.2em', marginBottom: 12 }}>
                        {activeChannel.name.toUpperCase()}
                      </div>
                      <button
                        onClick={() => { setVoiceChannel(activeChannel); setInComms(true); }}
                        style={{
                          fontSize: 13, padding: '8px 20px', borderRadius: 3, letterSpacing: '0.2em',
                          background: '#041e2e', border: '1px solid #0891b2', color: '#22d3ee', cursor: 'pointer',
                        }}
                      >
                        CONNECT TO VOICE
                      </button>
                    </div>
                  </div>
                ) : selectedOrg && !activeChannel ? (
                  /* Server landing — shown when a server is selected but no channel is active */
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
                ) : (
                  /* Default: no channel selected, not on server home — full calendar */
                  <div className="flex-1 overflow-y-auto" style={{ padding: '16px 20px' }}>
                    <OpsCalendarPanel
                      events={events}
                      orgId={selectedOrg?.id}
                      canScheduleEvents={canScheduleEvents}
                      onSchedule={() => setPlannerEvent('create')}
                      onOpenEvent={handleOpenEventComp}
                      onLaunchEvent={handleLaunchFromCard}
                      canLaunchEvent={canLaunchEvent}
                    />
                  </div>
                )
              ) : null}
            </div>

          </div>
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
        <span style={{ color: '#0e7490' }}>
          {selectedOrg ? selectedOrg.callsign.toUpperCase() : '—'} // SPECTERCOMS
        </span>
        {appVersion && (
          <span style={{ color: '#0e7490', opacity: 0.6 }}>v{appVersion}</span>
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
