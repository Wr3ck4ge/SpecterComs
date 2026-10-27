import { useEffect, useRef } from 'react';
import {
  EV, LEVELS_HZ, LEVELS_LEASE_MS, PATCH_BATCH_MS, STRIP_WINDOW,
  bridgeEmit, bridgeListen,
} from './bridge.js';

// Engine side of the strip↔engine bridge (protocol: ./bridge.js). Mounted by
// WarRoom in the hidden main window. WarRoom hands it:
//   state      EngineState for this render (buildEngineState)
//   getLevels  () => engine-levels frame (buildLevelsFrame), polled at LEVELS_HZ
//   inVoice    whether levels are worth sending at all
//   handlers   { [commandType]: async (args) => result } — throw to fail the
//              command; the thrown message is sent back in the ack
// It never touches voice/overlay logic itself: every command runs one of
// WarRoom's own handlers.

const emitToStrip = (event, payload) =>
  bridgeEmit(STRIP_WINDOW, event, payload).catch((err) => console.warn(`[bridge] emit ${event} failed:`, err));

export default function useEngineBridgeHost({ state, getLevels, inVoice, handlers }) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const getLevelsRef = useRef(getLevels);
  getLevelsRef.current = getLevels;

  const seqRef = useRef(0);
  // Last JSON sent per top-level section, to send only what changed.
  const sentRef = useRef({});
  const patchTimerRef = useRef(null);

  const sendSnapshot = () => {
    const s = stateRef.current;
    const sent = {};
    for (const [k, v] of Object.entries(s)) sent[k] = JSON.stringify(v);
    sentRef.current = sent;
    seqRef.current += 1;
    emitToStrip(EV.STATE, { seq: seqRef.current, state: s });
  };

  // Mount: announce, answer snapshot requests, run commands.
  useEffect(() => {
    sendSnapshot();
    emitToStrip(EV.READY, {});
    const stopSnap = bridgeListen(EV.REQUEST_SNAPSHOT, () => sendSnapshot());
    const stopCmd = bridgeListen(EV.COMMAND, async ({ id, type, args }) => {
      const handler = handlersRef.current?.[type];
      let ack;
      if (!handler) {
        ack = { id, ok: false, error: `Unknown command: ${type}` };
      } else {
        try {
          const result = await handler(args || {});
          ack = { id, ok: true, result: result ?? null };
        } catch (err) {
          ack = { id, ok: false, error: err?.message || String(err) };
        }
      }
      emitToStrip(EV.ACK, ack);
    });
    return () => {
      stopSnap();
      stopCmd();
      if (patchTimerRef.current) clearTimeout(patchTimerRef.current);
    };
    // mount/unmount only; everything live is read through refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Incremental updates: after any render, diff sections and batch a patch.
  useEffect(() => {
    if (patchTimerRef.current) return;
    patchTimerRef.current = setTimeout(() => {
      patchTimerRef.current = null;
      const s = stateRef.current;
      const patch = {};
      let changed = false;
      for (const [k, v] of Object.entries(s)) {
        const json = JSON.stringify(v);
        if (sentRef.current[k] !== json) {
          sentRef.current[k] = json;
          patch[k] = v;
          changed = true;
        }
      }
      if (!changed) return;
      seqRef.current += 1;
      emitToStrip(EV.PATCH, { seq: seqRef.current, patch });
    }, PATCH_BATCH_MS);
  });

  // Levels: only while a strip holds a lease and we're in voice.
  const leaseUntilRef = useRef(0);
  useEffect(() => bridgeListen(EV.LEVELS_LEASE, ({ on }) => {
    leaseUntilRef.current = on ? Date.now() + LEVELS_LEASE_MS : 0;
  }), []);

  useEffect(() => {
    if (!inVoice) return undefined;
    let lastJson = '';
    let streaming = false;
    const id = setInterval(() => {
      const leased = Date.now() < leaseUntilRef.current;
      if (!leased) {
        if (streaming) {
          streaming = false;
          lastJson = '';
          emitToStrip(EV.LEVELS, { levels: {}, speaking: [] });
        }
        return;
      }
      const frame = getLevelsRef.current?.();
      if (!frame) return;
      const json = JSON.stringify(frame);
      if (json === lastJson) return; // silence stays silent without re-sending
      lastJson = json;
      streaming = true;
      emitToStrip(EV.LEVELS, frame);
    }, Math.round(1000 / LEVELS_HZ));
    return () => {
      clearInterval(id);
      if (streaming) emitToStrip(EV.LEVELS, { levels: {}, speaking: [] });
    };
  }, [inVoice]);
}
