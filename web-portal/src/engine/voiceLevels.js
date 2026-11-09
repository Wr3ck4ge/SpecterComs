import { useEffect, useRef, useState } from 'react';
import { LEVELS_HZ } from './bridge.js';

// Engine phase 0: live voice levels without React state.
//
// The mic level arrives every ~20 ms and each remote speaker's 'Speaking'
// message up to 10×/s. Kept as React state, every one of those re-rendered
// CommLink and the whole hidden WarRoom (rebuilding the engine state and
// arming the bridge's JSON diff) — up to ~80 renders/s in a busy channel, for
// a window nobody sees. Instead CommLink writes them into one mutable object
// (createLiveVoiceLevels), shared with WarRoom through a ref, and the
// consumers sample it: the bridge's levels lease timer (EV.LEVELS, 10 Hz),
// the overlay feed (10 Hz, only on change) and — only while the engine
// window is actually on screen (SPECTER_DEV_ENGINE_UI) — the legacy UI via
// useSampledVoiceLevels.

/**
 * The live object CommLink writes and everyone else reads.
 *   localLevel     0..100 mic meter
 *   micRms         raw PCM RMS from the native capture callback
 *   localSpeaking  VAD/gate open (and not muted)
 *   remoteLevels   { [callsign]: { level, ts } } — replaced (not mutated) on
 *                  every update, so it can be handed out as a snapshot
 *   version        bumps on any change
 *   remoteVersion  bumps when localSpeaking or remoteLevels change (what
 *                  the overlay shows)
 */
export function createLiveVoiceLevels() {
  return { localLevel: 0, micRms: 0, localSpeaking: false, remoteLevels: {}, version: 0, remoteVersion: 0 };
}

export const EMPTY_VOICE_LEVELS = Object.freeze({
  localLevel: 0, micRms: 0, localSpeaking: false, remoteLevels: Object.freeze({}), version: -1,
});

/**
 * Whether this (engine) window is on screen. In production the engine window
 * is never shown, so this stays false and costs one isVisible() call at mount;
 * only SPECTER_DEV_ENGINE_UI's "Show engine (dev)" makes it visible (it also
 * focuses it, which is what flips this to true). While visible it re-checks
 * every 2 s to notice a hide. Outside Tauri: the page's visibility.
 */
export function useEngineWindowVisible() {
  const [visible, setVisible] = useState(() => typeof window !== 'undefined' && !window.__TAURI__ && document.visibilityState === 'visible');
  useEffect(() => {
    let disposed = false;
    if (!window.__TAURI__) {
      const onVis = () => setVisible(document.visibilityState === 'visible');
      document.addEventListener('visibilitychange', onVis);
      return () => document.removeEventListener('visibilitychange', onVis);
    }
    const check = () => {
      import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow().isVisible())
        .then((v) => { if (!disposed) setVisible(Boolean(v) && document.visibilityState !== 'hidden'); })
        .catch(() => {});
    };
    check();
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      disposed = true;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);
  useEffect(() => {
    if (!visible || !window.__TAURI__) return undefined;
    const id = setInterval(() => {
      import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow().isVisible())
        .then((v) => { if (!v) setVisible(false); })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [visible]);
  return visible;
}

/**
 * React-state copy of the live levels for UI that renders them, refreshed at
 * LEVELS_HZ and only when something changed, and only while `active` (in
 * voice and the window is on screen). Inactive → EMPTY_VOICE_LEVELS, so the
 * hidden production engine never re-renders for levels.
 */
export function useSampledVoiceLevels(getLive, active) {
  const [snap, setSnap] = useState(EMPTY_VOICE_LEVELS);
  const getLiveRef = useRef(getLive);
  getLiveRef.current = getLive;
  useEffect(() => {
    if (!active) {
      setSnap(EMPTY_VOICE_LEVELS);
      return undefined;
    }
    const sample = () => {
      const live = getLiveRef.current?.() || null;
      setSnap((prev) => {
        if (!live) return prev === EMPTY_VOICE_LEVELS ? prev : EMPTY_VOICE_LEVELS;
        if (prev.version === live.version && prev.live === live) return prev;
        return {
          localLevel: live.localLevel,
          micRms: live.micRms,
          localSpeaking: live.localSpeaking,
          remoteLevels: live.remoteLevels,
          version: live.version,
          live,
        };
      });
    };
    sample();
    const id = setInterval(sample, Math.round(1000 / LEVELS_HZ));
    return () => clearInterval(id);
  }, [active]);
  return snap;
}
