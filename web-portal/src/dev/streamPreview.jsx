// SV: dev-only gallery for the strip's stream viewer — loaded by
// /stream-preview.html (not a production build input). Renders StripView in a
// full-work-area frame (like stripPreview's WideFrame) with the viewer fed by
// a MOCKED frame source: a canvas test pattern encoded with WebCodecs
// (VideoEncoder, VP8) and handed to the viewer exactly as the engine bridge
// would (base64 frames + config on keyframes), so the real decode path
// (useStripStream → VideoDecoder → canvas) runs. Dashed outlines = the window
// region strip.rs would clip to.
/* eslint-disable react-refresh/only-export-components -- entry module, not a component library */
/* global VideoEncoder, VideoFrame -- WebCodecs */
import { useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../strip.css';
import StripView from '../components/strip/StripView';
import ChannelsCabinet from '../components/strip/ChannelsCabinet';
import { StripFrame, MAIN_WIDTH } from '../components/strip/StripSidePanel';
import { voiceSlots } from '../components/strip/voiceSlots';
import { streamWatchSlots } from '../components/strip/streamSlots';
import StripStreamViewer from '../components/strip/StripStreamViewer';
import { EMPTY_STATE } from '../engine/bridge';

const noop = () => {};
const ORGS = [{ id: 'o1', name: 'Ghost Fleet', member_count: 42, logo_url: null }];
const CHANNELS = [
  { id: 'v1', name: 'Bridge', kind: 'voice', eventId: null, parentId: null, occupants: ['Ghost', 'Nova', 'Kestrel', 'Rook'] },
  { id: 'v2', name: 'Hangar bay', kind: 'voice', eventId: null, parentId: null, occupants: [] },
  { id: 't1', name: 'general', kind: 'text', eventId: null, parentId: null, occupants: [] },
];
const voiceState = (over = {}) => ({
  channelId: 'v1', channelName: 'Bridge', status: 'connected', muted: false, sharing: false,
  roster: ['Ghost', 'Nova', 'Kestrel', 'Rook'], sharers: ['Kestrel', 'Nova'], watchTarget: 'Kestrel', viewer: 'strip', ...over,
});
const engine = (voice = voiceState()) => ({
  connected: true,
  state: { ...EMPTY_STATE, user: { callsign: 'Ghost' }, org: { id: 'o1', callsign: 'Ghost Fleet', canManageChannels: true }, channels: CHANNELS, voice, caps: { deafen: false, overlay: true, share: true } },
  levels: { levels: { Nova: 50 }, speaking: ['Nova'] }, pending: {}, chat: null,
});

// ── Mock frame source ──────────────────────────────────────────────────────
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 6144) s += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + 6144)));
  return s;
}
function drawPattern(ctx, n, w, h) {
  const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
  const bw = w / bars.length;
  bars.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(Math.round(i * bw), 0, Math.ceil(bw), h * 0.62); });
  const g = ctx.createLinearGradient(0, h * 0.62, 0, h);
  g.addColorStop(0, '#0e1a2b'); g.addColorStop(1, '#04070d');
  ctx.fillStyle = g; ctx.fillRect(0, h * 0.62, w, h * 0.38);
  // A bouncing "ship" so motion is visible.
  const t = n / 30;
  const x = (w * 0.1) + ((Math.sin(t * 1.3) + 1) / 2) * w * 0.7;
  const y = h * 0.66 + ((Math.cos(t * 1.9) + 1) / 2) * h * 0.18;
  ctx.fillStyle = '#67daf5';
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 90, y + 22); ctx.lineTo(x, y + 44); ctx.lineTo(x + 20, y + 22); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#e2e8f0';
  ctx.font = `600 ${Math.round(h * 0.05)}px sans-serif`;
  ctx.fillText('Kestrel · test pattern', w * 0.04, h * 0.93);
  ctx.font = `${Math.round(h * 0.04)}px monospace`;
  ctx.fillText(`frame ${String(n).padStart(5, '0')}`, w * 0.72, h * 0.93);
}
// ?debug=1 shows these (headless screenshots have no console).
const MOCK_STATS = { encoder: typeof VideoEncoder !== 'undefined', ticks: 0, chunks: 0, error: null };
/** status: optional engine-stream-status to send; frames: encode the test pattern. */
function mockSource({ status = null, frames = true, corrupt = false } = {}) {
  return {
    subscribe({ onFrame, onStatus }) {
      let stopped = false;
      let timer = null;
      let enc = null;
      if (status) setTimeout(() => !stopped && onStatus({ callsign: 'Kestrel', ...status }), 30);
      if (frames && typeof VideoEncoder !== 'undefined') {
        const W = 1280; const H = 720; const codec = 'vp8';
        const canvas = new OffscreenCanvas(W, H);
        const ctx = canvas.getContext('2d');
        enc = new VideoEncoder({
          output: (chunk) => {
            if (stopped) return;
            MOCK_STATS.chunks += 1;
            const buf = new Uint8Array(chunk.byteLength);
            chunk.copyTo(buf);
            const key = chunk.type === 'key';
            // corrupt: a garbage keyframe → the decoder errors (decode error state).
            const data = corrupt && key ? buf.map((b, i) => (i > 10 ? (b * 31 + i) & 0xff : b)) : buf;
            onFrame({ session: 'mock', key, ts: chunk.timestamp, data: bytesToBase64(data), ...(key ? { config: { codec, width: W, height: H } } : null) });
          },
          error: (e) => { MOCK_STATS.error = String(e?.message || e); console.warn('[mock] encoder error', e); },
        });
        enc.configure({ codec, width: W, height: H, bitrate: 2_500_000, framerate: 30 });
        let n = 0;
        timer = setInterval(() => {
          if (stopped || enc.state !== 'configured') return;
          MOCK_STATS.ticks += 1;
          drawPattern(ctx, n, W, H);
          const vf = new VideoFrame(canvas, { timestamp: n * 33333 });
          enc.encode(vf, { keyFrame: n % 60 === 0 });
          vf.close();
          n += 1;
        }, 33);
      }
      return () => { stopped = true; clearInterval(timer); try { enc?.close(); } catch { /* closed */ } };
    },
  };
}

const LIVE = mockSource();
const SCENARIOS = [
  { id: 'sv-default', title: 'SV — watching in the strip (default size, above the bar)', source: LIVE },
  { id: 'sv-expanded', title: 'SV — expanded (up to 70% of the work area)', source: LIVE, expanded: true },
  { id: 'sv-waiting-key', title: 'SV — waiting for channel key (MLS key recovery)', source: mockSource({ status: { status: 'waiting-key', message: 'Waiting for channel key…' }, frames: false }) },
  { id: 'sv-connecting', title: 'SV — connecting (no frames yet)', source: mockSource({ frames: false }) },
  { id: 'sv-ended', title: 'SV — sharer stopped sharing (last picture dimmed)', source: LIVE, voice: voiceState({ sharers: ['Nova'] }), delayVoice: true },
  { id: 'sv-left', title: 'SV — sharer left the channel', source: mockSource({ frames: false }), voice: voiceState({ sharers: ['Nova'], roster: ['Ghost', 'Nova', 'Rook'] }) },
  { id: 'sv-error', title: 'SV — decode error with retry', source: mockSource({ corrupt: true }) },
  { id: 'sv-cabinet', title: 'SV — Channels cabinet open: viewer minimised above it (Watch + overlay buttons per sharer)', source: LIVE, cabinet: 'channels' },
  { id: 'sv-collapsed', title: 'SV — pinned, strip lost focus: only the viewer stays (bar out of the region)', source: LIVE, collapsed: true },
  { id: 'sv-bar-chip', title: 'SV — no viewer: the bar offers "watch" (Kestrel +1)', source: LIVE, noViewer: true, voice: voiceState({ watchTarget: null, viewer: null }) },
  { id: 'sv-grow-down', title: 'SV — taskbar at the top (viewer below the bar)', source: LIVE, grow: 'down' },
];

function Scenario({ s, w, h, bare }) {
  const ref = useRef(null);
  const [rects, setRects] = useState([]);
  const [cabinet, setCabinet] = useState(s.cabinet ?? null);
  const [expanded, setExpanded] = useState(Boolean(s.expanded));
  const [open, setOpen] = useState(!s.noViewer);
  // sv-ended: let a few frames draw first, then the sharer "stops".
  const [voiceOver, setVoiceOver] = useState(s.delayVoice ? null : s.voice || null);
  useLayoutEffect(() => {
    if (!s.delayVoice) return undefined;
    const t = setTimeout(() => setVoiceOver(s.voice), 1200);
    return () => clearTimeout(t);
  }, [s]);
  const eng = engine(voiceOver || voiceState(open ? {} : { watchTarget: null, viewer: null }));
  const measure = () => {
    const frame = ref.current?.getBoundingClientRect();
    if (!frame) return;
    const next = [...ref.current.querySelectorAll('[data-strip-region]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left - frame.left - 6), y: Math.round(r.top - frame.top - 6), w: Math.round(r.width + 12), h: Math.round(r.height + 12) };
    }).filter((r) => r.w > 12 && r.h > 12);
    setRects((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  };
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const [onRegion] = useState(() => () => measureRef.current());
  useLayoutEffect(() => {
    const t = setTimeout(measure, 450);
    return () => clearTimeout(t);
  });
  const grow = s.grow || 'up';
  const slots = [
    ...voiceSlots({ engine: eng, pickerOpen: false, onOpenChannels: noop, onToggleOverlay: noop, onShareClick: noop }),
    ...streamWatchSlots({ engine: eng, viewerOpen: open, onWatch: () => setOpen(true), onOpenChannels: () => setCabinet('channels') }),
  ];
  const v = eng.state.voice;
  const main = (
    <StripView
      auth="in" orgs={ORGS} activeOrgId="o1" grow={grow}
      cabinet={cabinet}
      onSelectOrg={noop} onInstallUpdate={noop} onDismissHint={noop}
      onCloseCabinet={() => setCabinet(null)}
      onToggleCabinet={(id) => setCabinet((c) => (c === id ? null : id))}
      onRegionChange={onRegion}
      viewportWidth={w} viewportHeight={h}
      barSlots={slots}
      collapsed={Boolean(s.collapsed)}
      renderCabinet={(id, { onClose }) => (id === 'channels' ? (
        <ChannelsCabinet engine={eng} onCommand={noop} focus={null} onFocus={noop}
          onCreateChannel={async () => ({ error: null })} onDeleteChannel={async () => ({ error: null })}
          onClose={onClose} pane={null} paneWidth={0} expand="left" maxHeight={Math.min(680, h - 110 - 90)} paneMinHeight={360} />
      ) : null)}
      streamViewer={open ? (ctx) => (
        <StripStreamViewer callsign="Kestrel" voice={v} channelName={v.channelName} {...ctx}
          expanded={expanded} onToggleExpand={() => setExpanded((x) => !x)}
          onOpenOverlay={() => setOpen(false)} onClose={() => setOpen(false)} onRetry={noop}
          onShow={() => setCabinet(null)} source={s.source} />
      ) : null}
    />
  );
  const barRect = grow === 'down'
    ? { x: w - 8 - MAIN_WIDTH, y: 8, w: MAIN_WIDTH, h: h - 16 }
    : { x: w - 8 - MAIN_WIDTH, y: 8, w: MAIN_WIDTH, h: h - 16 };
  return (
    <figure className="m-0 space-y-2" data-scenario={s.id}>
      {!bare && <figcaption className="font-ui text-ui-sm text-slate-300">{s.title} · {w}×{h}</figcaption>}
      <div ref={ref} className="relative overflow-hidden" style={{ width: w, height: h, transform: 'translateZ(0)', outline: bare ? undefined : '1px solid rgba(255,255,255,0.08)' }}>
        <StripFrame layout={{ expand: 'left', grow, barRect }} grow={grow}>{main}</StripFrame>
        {rects.map((r, i) => (
          <div key={i} className="pointer-events-none absolute border border-dashed border-amber-300/50"
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
        ))}
      </div>
    </figure>
  );
}

function DebugLine() {
  const [, tick] = useState(0);
  useLayoutEffect(() => { const t = setInterval(() => tick((n) => n + 1), 250); return () => clearInterval(t); }, []);
  return <pre className="absolute left-2 top-2 text-xs text-amber-200">{JSON.stringify(MOCK_STATS)}</pre>;
}

function Preview() {
  const params = new URLSearchParams(window.location.search);
  const only = params.get('only');
  const bare = params.get('bare') === '1';
  const list = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  const bg = { background: 'radial-gradient(circle at 30% 20%, #3b4a63 0%, #1b2333 45%, #0d1018 100%)' };
  if (bare && list.length) {
    return (
      <div className="fixed inset-0 overflow-hidden" style={bg}>
        {params.get('debug') === '1' && <DebugLine />}
        <Scenario s={list[0]} w={Number(params.get('w')) || window.innerWidth} h={Number(params.get('h')) || window.innerHeight} bare />
      </div>
    );
  }
  const w = Number(params.get('w')) || 1366;
  const h = Number(params.get('h')) || 728;
  return (
    <div className="fixed inset-0 overflow-auto p-6" style={bg}>
      <div className="flex flex-wrap gap-6">
        {list.map((s) => <Scenario key={s.id} s={s} w={w} h={h} />)}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Preview />);
