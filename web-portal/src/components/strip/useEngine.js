import { useCallback, useEffect, useRef, useState } from 'react';
import {
  COMMAND_TIMEOUT_MS, EMPTY_STATE, ENGINE_WINDOW, EV, LEVELS_LEASE_MS,
  bridgeEmit, bridgeListen,
} from '../../engine/bridge.js';

// Strip side of the strip↔engine bridge (protocol: src/engine/bridge.js).
//
//   const engine = useEngine({ enabled, wantLevels });
//   engine.connected   true once an engine-state has arrived
//   engine.state       EngineState (EMPTY_STATE until then)
//   engine.levels      latest engine-levels frame { levels, speaking }
//   engine.pending     { [key]: { type, args, status: 'pending' | 'error', error } }
//                      key = command type + its main argument (see cmdKey),
//                      so the UI can show "joining…" / "failed" on the right row
//   engine.epoch       increments on each engine-ready (P2A: re-send subscriptions)
//   engine.chat        latest engine-chat { channelId, loading, rows } (P2A) or null
//   engine.send(type, args, { timeoutMs?, timeoutMessage? })
//                      → Promise<result>; rejects with the ack's error
//   engine.clearError(key)
//   engine.resync()    ask for a fresh snapshot (e.g. when the strip is shown)

const engineEmit = (event, payload) =>
  bridgeEmit(ENGINE_WINDOW, event, payload).catch((err) => console.warn(`[bridge] emit ${event} failed:`, err));

export const cmdKey = (type, args = {}) => `${type}:${args.channelId ?? args.callsign ?? args.orgId ?? ''}`;

let cmdCounter = 0;
const newId = () => `${Date.now().toString(36)}-${(cmdCounter += 1)}`;

export default function useEngine({ enabled = true, wantLevels = false } = {}) {
  const [state, setState] = useState(EMPTY_STATE);
  const [connected, setConnected] = useState(false);
  const [levels, setLevels] = useState({ levels: {}, speaking: [] });
  const [pending, setPending] = useState({});
  // P2A: engine-chat for the subscribed text channel (text.select).
  const [chat, setChat] = useState(null);
  // P2A: bumped on every engine-ready (a fresh engine has no subscriptions).
  const [epoch, setEpoch] = useState(0);
  const seqRef = useRef(0);
  const waitersRef = useRef(new Map()); // id → { resolve, reject, timer, key }

  const resync = useCallback(() => { if (enabled) engineEmit(EV.REQUEST_SNAPSHOT, {}); }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      setState(EMPTY_STATE);
      setChat(null);
      return undefined;
    }
    const stops = [
      bridgeListen(EV.STATE, ({ seq, state: s }) => {
        seqRef.current = seq;
        setState({ ...EMPTY_STATE, ...s });
        setConnected(true);
      }),
      bridgeListen(EV.PATCH, ({ seq, patch }) => {
        // A gap means a missed patch (or a fresh engine): resync.
        if (seq !== seqRef.current + 1) { engineEmit(EV.REQUEST_SNAPSHOT, {}); return; }
        seqRef.current = seq;
        setState((prev) => ({ ...prev, ...patch }));
      }),
      bridgeListen(EV.READY, () => { setEpoch((n) => n + 1); engineEmit(EV.REQUEST_SNAPSHOT, {}); }),
      bridgeListen(EV.LEVELS, ({ levels: l, speaking }) => setLevels({ levels: l || {}, speaking: speaking || [] })),
      bridgeListen(EV.CHAT, ({ channelId, loading, rows }) => setChat({ channelId, loading: Boolean(loading), rows: rows || [] })),
      bridgeListen(EV.ACK, ({ id, ok, error, result }) => {
        const w = waitersRef.current.get(id);
        if (!w) return;
        waitersRef.current.delete(id);
        clearTimeout(w.timer);
        if (ok) w.resolve(result); else w.reject(new Error(error || 'Failed'));
      }),
    ];
    engineEmit(EV.REQUEST_SNAPSHOT, {});
    const waiters = waitersRef.current;
    return () => {
      stops.forEach((stop) => stop());
      for (const w of waiters.values()) clearTimeout(w.timer);
      waiters.clear();
    };
  }, [enabled]);

  // Levels lease: renewed while wanted, released when not.
  useEffect(() => {
    if (!enabled || !wantLevels) return undefined;
    engineEmit(EV.LEVELS_LEASE, { on: true });
    const t = setInterval(() => engineEmit(EV.LEVELS_LEASE, { on: true }), LEVELS_LEASE_MS / 2);
    return () => {
      clearInterval(t);
      engineEmit(EV.LEVELS_LEASE, { on: false });
      setLevels({ levels: {}, speaking: [] });
    };
  }, [enabled, wantLevels]);

  const send = useCallback((type, args = {}, { timeoutMs = COMMAND_TIMEOUT_MS, timeoutMessage } = {}) => {
    const key = cmdKey(type, args);
    const id = newId();
    setPending((p) => ({ ...p, [key]: { type, args, status: 'pending', error: null } }));
    const settle = (error) => setPending((p) => {
      if (p[key]?.args !== args) return p; // superseded by a newer send
      const next = { ...p };
      if (error) next[key] = { type, args, status: 'error', error };
      else delete next[key];
      return next;
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waitersRef.current.delete(id);
        reject(new Error(timeoutMessage || 'SpecterComs didn\'t answer. Try again.'));
      }, timeoutMs);
      waitersRef.current.set(id, { resolve, reject, timer, key });
      engineEmit(EV.COMMAND, { id, type, args });
    }).then(
      (result) => { settle(null); return result; },
      (err) => { settle(err.message); throw err; },
    );
  }, []);

  const clearError = useCallback((key) => setPending((p) => {
    if (!p[key] || p[key].status !== 'error') return p;
    const next = { ...p };
    delete next[key];
    return next;
  }), []);

  return { connected, state, levels, pending, chat, epoch, send, clearError, resync };
}
