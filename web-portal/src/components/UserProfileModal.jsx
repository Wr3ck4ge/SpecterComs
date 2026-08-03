// UserProfileModal.jsx — Overlay modal for viewing user profiles in the War Room roster
import React, { useEffect } from 'react';

export default function UserProfileModal({
  targetUser,
  avatarUrl,
  isLocal,
  localAudioLevel,
  gainValue,
  onGainChange,
  userRole,
  canKick,
  canBan,
  canMute,
  isFriend,
  isLocallyMuted,
  isInChannel,
  onClose,
  onAddFriend,
  onDirectMessage,
  onLocalMute,
  onGlobalMute,
  onKickFromChannel,
  onKickFromServer,
  onBan,
  onReportVoice,
  canReportVoice,
}) {
  // Close on Escape key
  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const avatarLetter = (targetUser || '?')[0].toUpperCase();

  const btnBase = {
    display: 'block',
    width: '100%',
    padding: '8px 12px',
    marginBottom: 6,
    background: 'rgba(8, 145, 178, 0.08)',
    border: '1px solid #0e3a4e',
    borderRadius: 6,
    color: '#94a3b8',
    fontSize: 12,
    letterSpacing: '0.08em',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'border-color 0.15s, color 0.15s',
  };

  const btnDanger = {
    ...btnBase,
    background: 'rgba(239, 68, 68, 0.06)',
    border: '1px solid #3f1515',
    color: '#f87171',
  };

  const btnBan = {
    ...btnBase,
    background: 'rgba(185, 28, 28, 0.06)',
    border: '1px solid #2c0e0e',
    color: '#ef4444',
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Card — stop clicks from propagating to the backdrop */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          maxWidth: 340,
          width: '100%',
          background: '#041e2e',
          border: '1px solid #0e3a4e',
          borderRadius: 12,
          padding: 24,
          position: 'relative',
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            background: 'none',
            border: 'none',
            color: '#4b5563',
            fontSize: 18,
            cursor: 'pointer',
            lineHeight: 1,
            padding: '2px 6px',
          }}
          title="Close"
        >
          ✕
        </button>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
          <div style={{
            width: 64,
            height: 64,
            borderRadius: '50%',
            background: '#0891b2',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            boxShadow: '0 0 12px rgba(8,145,178,0.35)',
            overflow: 'hidden',
          }}>
            {avatarUrl ? (
              <img src={avatarUrl} alt={targetUser} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
            ) : (
              <span style={{ fontSize: 26, fontWeight: 'bold', color: '#fff', fontFamily: 'monospace' }}>
                {avatarLetter}
              </span>
            )}
          </div>
          <div>
            <div style={{ fontSize: 18, color: '#e5e7eb', fontWeight: 600, letterSpacing: '0.04em' }}>
              {targetUser}
            </div>
            {userRole && (
              <div style={{ fontSize: 11, color: '#22d3ee', letterSpacing: '0.12em', marginTop: 3 }}>
                {userRole.toUpperCase()}
              </div>
            )}
            {isLocal && (
              <div style={{ fontSize: 10, color: '#0e7490', letterSpacing: '0.1em', marginTop: 2 }}>
                YOU
              </div>
            )}
          </div>
        </div>

        {/* Local user: voice controls */}
        {isLocal ? (
          <div>
            <div style={{
              fontSize: 10,
              color: '#0e7490',
              letterSpacing: '0.2em',
              marginBottom: 10,
              borderBottom: '1px solid #0e3a4e',
              paddingBottom: 6,
            }}>
              YOUR VOICE
            </div>

            {/* Mic level bar */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: '#4b5563', letterSpacing: '0.08em', marginBottom: 4 }}>
                MIC LEVEL
              </div>
              <div style={{ height: 6, background: '#0e1c2c', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${localAudioLevel ?? 0}%`,
                  background: (localAudioLevel ?? 0) > 60 ? '#22c55e' : '#0891b2',
                  borderRadius: 3,
                  transition: 'width 80ms linear, background-color 200ms',
                }} />
              </div>
            </div>

            {/* Gain slider */}
            <div>
              <div style={{ fontSize: 10, color: '#4b5563', letterSpacing: '0.08em', marginBottom: 6 }}>
                MIC GAIN: {Math.round((gainValue ?? 1) * 100)}%
              </div>
              <input
                type="range"
                min="0"
                max="2"
                step="0.05"
                value={gainValue ?? 1}
                onChange={e => onGainChange && onGainChange(parseFloat(e.target.value))}
                style={{ width: '100%', accentColor: '#0891b2', cursor: 'pointer' }}
              />
            </div>
          </div>
        ) : (
          /* Remote user: action buttons */
          <div>
            <button style={btnBase} onClick={onDirectMessage}>
              ✉ MESSAGE
            </button>
            {!isFriend && (
              <button style={btnBase} onClick={onAddFriend}>
                + ADD FRIEND
              </button>
            )}
            <button style={{ ...btnBase, ...(isLocallyMuted ? { borderColor: '#0e7490', color: '#22d3ee' } : {}) }} onClick={onLocalMute}>
              🔇 {isLocallyMuted ? 'UNMUTE (LOCAL)' : 'MUTE (LOCAL)'}
            </button>
            {canMute && (
              <button style={btnBase} onClick={onGlobalMute}>
                🔇 MUTE (GLOBAL)
              </button>
            )}

            {/* Available to any user, not just mods — reporting is what
                surfaces misconduct in the first place, it shouldn't require
                permissions someone might not have. */}
            {canReportVoice && (
              <button style={{ ...btnDanger, marginTop: 4 }} onClick={onReportVoice} title="Attach the last minute of call audio to a report">
                ⚠ REPORT (VOICE)
              </button>
            )}

            {(canKick || canBan) && (
              <div style={{ borderTop: '1px solid #0e2030', margin: '10px 0' }} />
            )}
            {canKick && isInChannel && (
              <button style={btnDanger} onClick={onKickFromChannel}>
                ⚡ KICK FROM CHANNEL
              </button>
            )}
            {canKick && (
              <button style={{ ...btnDanger, marginBottom: 6 }} onClick={onKickFromServer}>
                ⚡ KICK FROM SERVER
              </button>
            )}
            {canBan && (
              <button style={btnBan} onClick={onBan}>
                ✕ BAN
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
