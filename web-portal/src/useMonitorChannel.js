/**
 * useMonitorChannel — lightweight RX-only audio monitor for a secondary channel.
 *
 * Connects to a channel via WebTransport and plays incoming audio at a reduced
 * volume.
 *
 * Usage:
 *   const { roster, currentSpeaker } = useMonitorChannel({ org, channel, volume: 0.3 });
 *
 * The hook is designed to be used multiple times in parallel — each instance
 * manages its own transport and AudioContext.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from './api';

// ── Minimal proto3 decoder (mirrors CommLink.jsx's decodeAudioFrameProto) ──
function decodeAudioFrameProto(bytes) {
  let pos = 0, opusBytes = null, isGlobalBroadcast = false;
  while (pos < bytes.length) {
    let tag = 0, shift = 0;
    while (pos < bytes.length) { const b = bytes[pos++]; tag |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) break; }
    const fieldNumber = tag >>> 3, wireType = tag & 0x07;
    if (wireType === 0) {
      let val = 0; shift = 0;
      while (pos < bytes.length) { const b = bytes[pos++]; val |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) break; }
      if (fieldNumber === 4) isGlobalBroadcast = val !== 0;
    } else if (wireType === 2) {
      let len = 0; shift = 0;
      while (pos < bytes.length) { const b = bytes[pos++]; len |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) break; }
      const data = bytes.slice(pos, pos + len); pos += len;
      if (fieldNumber === 1) opusBytes = data;
    } else { break; }
  }
  return { opusBytes, isGlobalBroadcast };
}

// ── Hook ─────────────────────────────────────────────────────────────────────
export default function useMonitorChannel({ org, channel, volume = 0.3, enabled = true }) {
  const [roster, setRoster] = useState([]);
  const [currentSpeaker, setCurrentSpeaker] = useState(null);
  const [connected, setConnected] = useState(false);

  const transportRef = useRef(null);
  const audioCtxRef = useRef(null);
  const gainNodeRef = useRef(null);
  const opusDecoderRef = useRef(null);
  const currentSpeakerRef = useRef(null);
  const speakerTimerRef = useRef(null);
  const volumeRef = useRef(volume);
  useEffect(() => {
    volumeRef.current = volume;
    // Apply immediately to the gain node if it exists (browser path live update)
    if (gainNodeRef.current && audioCtxRef.current) {
      gainNodeRef.current.gain.setTargetAtTime(volume, audioCtxRef.current.currentTime, 0.02);
    }
  }, [volume]);

  // ── Play an Opus frame at the monitor volume ──────────────────────────────
  const playOpusFrame = useCallback(async (opusBytes) => {
    // Tauri path: invoke play_frame with volume
    if (window.__TAURI__) {
      const b64 = btoa(String.fromCharCode(...opusBytes));
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        invoke('plugin:specter-audio|play_frame', { data: b64, volume: volumeRef.current, streamId: channel.id }).catch(() => {});
      } catch {}
      return;
    }

    // Browser path: Web Audio API with a GainNode
    if (!audioCtxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtxRef.current = new AC();
      gainNodeRef.current = audioCtxRef.current.createGain();
      gainNodeRef.current.gain.value = volumeRef.current;
      gainNodeRef.current.connect(audioCtxRef.current.destination);
    }
    if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume().catch(() => {});
    gainNodeRef.current.gain.value = volumeRef.current;

    if (!opusDecoderRef.current) {
      try {
        const { OpusDecoder } = await import('opus-decoder');
        const dec = new OpusDecoder();
        await dec.ready;
        opusDecoderRef.current = dec;
      } catch { return; }
    }
    try {
      const { channelData, samplesDecoded, sampleRate } = opusDecoderRef.current.decodeFrame(opusBytes);
      if (!samplesDecoded) return;
      const buf = audioCtxRef.current.createBuffer(1, samplesDecoded, sampleRate || 48_000);
      buf.getChannelData(0).set(channelData[0]);
      const src = audioCtxRef.current.createBufferSource();
      src.buffer = buf;
      src.connect(gainNodeRef.current);
      src.start();
    } catch {}
  }, []);

  // ── Parse roster stream messages ─────────────────────────────────────────
  const handleRosterMsg = useCallback((msg) => {
    if (msg.type === 'Snapshot') {
      setRoster(msg.data || []);
    } else if (msg.type === 'Join') {
      setRoster(prev => prev.includes(msg.data) ? prev : [...prev, msg.data]);
    } else if (msg.type === 'Leave') {
      setRoster(prev => prev.filter(u => u !== msg.data));
    } else if (msg.type === 'Speaking') {
      const { callsign, level } = msg.data || {};
      if (!callsign || level < 10) return;

      if (currentSpeakerRef.current !== callsign) {
        currentSpeakerRef.current = callsign;
        setCurrentSpeaker(callsign);
      }

      // Reset silence timer — clear speaker after 1.5 s of no Speaking messages
      if (speakerTimerRef.current) clearTimeout(speakerTimerRef.current);
      speakerTimerRef.current = setTimeout(() => {
        currentSpeakerRef.current = null;
        setCurrentSpeaker(null);
      }, 1500);
    }
  }, []);

  // ── Read datagrams (audio) ────────────────────────────────────────────────
  const readDatagrams = useCallback(async (transport) => {
    const reader = transport.datagrams.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.length < 2) continue;
        if (value[0] === 0xFF) continue; // control datagrams, ignore
        try {
          const { opusBytes } = decodeAudioFrameProto(value);
          if (opusBytes && opusBytes.length > 0) playOpusFrame(opusBytes);
        } catch {}
      }
    } catch {}
  }, [playOpusFrame]);

  // ── Read roster stream ────────────────────────────────────────────────────
  const readRosterStream = useCallback(async (stream) => {
    const reader = stream.getReader();
    let buf = new Uint8Array(0);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // Concatenate chunks
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf); next.set(value, buf.length);
        buf = next;
        // Parse newline-delimited JSON
        let nl;
        while ((nl = buf.indexOf(0x0a)) !== -1) {
          const line = new TextDecoder().decode(buf.slice(0, nl)).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { handleRosterMsg(JSON.parse(line)); } catch {}
        }
      }
    } catch {}
  }, [handleRosterMsg]);

  const readIncomingStreams = useCallback(async (transport) => {
    try {
      const reader = transport.incomingUnidirectionalStreams.getReader();
      while (true) {
        const { value: stream, done } = await reader.read();
        if (done) break;
        // First byte identifies stream type: 0x01 = roster
        const probe = stream.getReader();
        const { value: firstChunk } = await probe.read();
        probe.releaseLock();
        if (firstChunk && firstChunk[0] === 0x01) {
          readRosterStream(stream);
        }
        // Other stream types (video etc.) are ignored for monitor channels
      }
    } catch {}
  }, [readRosterStream]);

  // ── Connect / disconnect lifecycle ───────────────────────────────────────
  useEffect(() => {
    if (!enabled || !org?.id || !channel?.id) return;

    let disposed = false;
    let transport = null;

    const connect = async () => {
      try {
        const { data, error } = await api.getOrgToken(org.id, channel.id);
        if (error || !data?.token) return;
        const base = (data.media_url || 'https://localhost:4434').replace(/\/$/, '');
        const url = `${base}/specter?token=${data.token}&channel_id=${channel.id}`;
        transport = new WebTransport(url);
        transportRef.current = transport;
        await transport.ready;
        if (disposed) { transport.close(); return; }
        setConnected(true);
        readDatagrams(transport);
        readIncomingStreams(transport);
        // Monitor closure
        transport.closed.then(() => {
          if (!disposed) setConnected(false);
        }).catch(() => { if (!disposed) setConnected(false); });
      } catch {
        if (!disposed) setConnected(false);
      }
    };

    connect();

    return () => {
      disposed = true;
      setConnected(false);
      setRoster([]);
      setCurrentSpeaker(null);
      currentSpeakerRef.current = null;
      if (speakerTimerRef.current) clearTimeout(speakerTimerRef.current);
      try { transportRef.current?.close(); } catch {}
      transportRef.current = null;
      // Drop the native per-channel Opus decoder — without this it lives
      // forever keyed by channel id, and a much-later reconnect to this same
      // channel resumes decoding on a stale decoder instead of a fresh one.
      if (window.__TAURI__ && channel?.id) {
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('plugin:specter-audio|clear_stream', { streamId: channel.id }).catch(() => {});
        }).catch(() => {});
      }
      if (opusDecoderRef.current) { opusDecoderRef.current.free?.(); opusDecoderRef.current = null; }
      if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null; gainNodeRef.current = null; }
    };
  }, [enabled, org?.id, channel?.id, readDatagrams, readIncomingStreams]);

  return { roster, currentSpeaker, connected };
}
