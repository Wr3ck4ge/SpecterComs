// TRAY: the engine tells Rust whether the user is in a voice channel, so the
// tray icon can show it (src-tauri/src/tray_activity.rs: the brand tray set —
// in-voice, mic-muted, streaming-live — and the tooltip
// "SpecterComs — in <channel> (<server>), sharing your screen, muted").
// BRAND: precedence for the icon is live (sharing) > muted > active > idle;
// the muted / sharing flags go along so the tooltip can list them all.
// The engine is the authority on voice, and Rust owns the tray, so this works
// with the strip open, hidden or destroyed. Rust debounces the changes (a
// reconnect doesn't flicker); unmounting the engine (logout) resets to idle.

import { useEffect } from 'react';

const inTauri = () => typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);

/** { state: 'idle' | 'active' | 'muted' | 'live', label, muted, sharing } for the tray. Pure. */
export function trayActivityFor({ inVoice = false, muted = false, sharing = false, channelName = null, orgName = null } = {}) {
  if (!inVoice) return { state: 'idle', label: '', muted: false, sharing: false };
  const ch = (channelName || '').trim() || 'voice';
  const org = (orgName || '').trim();
  const state = sharing ? 'live' : muted ? 'muted' : 'active';
  return { state, label: org ? `${ch} (${org})` : ch, muted: Boolean(muted), sharing: Boolean(sharing) };
}

async function send(state, label, muted = false, sharing = false) {
  if (!inTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_tray_activity', { state, label, muted, sharing });
  } catch (err) {
    console.warn('set_tray_activity failed:', err);
  }
}

export default function useTrayActivity(input) {
  const { state, label, muted, sharing } = trayActivityFor(input);
  useEffect(() => { send(state, label, muted, sharing); }, [state, label, muted, sharing]);
  // The engine going away (logout unmounts WarRoom) leaves no voice behind.
  useEffect(() => () => { send('idle', ''); }, []);
}
