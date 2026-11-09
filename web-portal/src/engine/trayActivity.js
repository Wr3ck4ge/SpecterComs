// TRAY: the engine tells Rust whether the user is in a voice channel, so the
// tray icon can show it (src-tauri/src/tray_activity.rs: a green dot, a red
// one while muted, and the tooltip "SpecterComs — in <channel> (<server>)").
// The engine is the authority on voice, and Rust owns the tray, so this works
// with the strip open, hidden or destroyed. Rust debounces the changes (a
// reconnect doesn't flicker); unmounting the engine (logout) resets to idle.

import { useEffect } from 'react';

const inTauri = () => typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);

/** { state: 'idle' | 'active' | 'muted', label } for the tray. Pure. */
export function trayActivityFor({ inVoice = false, muted = false, channelName = null, orgName = null } = {}) {
  if (!inVoice) return { state: 'idle', label: '' };
  const ch = (channelName || '').trim() || 'voice';
  const org = (orgName || '').trim();
  return { state: muted ? 'muted' : 'active', label: org ? `${ch} (${org})` : ch };
}

async function send(state, label) {
  if (!inTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_tray_activity', { state, label });
  } catch (err) {
    console.warn('set_tray_activity failed:', err);
  }
}

export default function useTrayActivity(input) {
  const { state, label } = trayActivityFor(input);
  useEffect(() => { send(state, label); }, [state, label]);
  // The engine going away (logout unmounts WarRoom) leaves no voice behind.
  useEffect(() => () => { send('idle', ''); }, []);
}
