import React, { useState, useRef, useEffect } from 'react';
import {
  Radio, CalendarClock, Bell, Gamepad2, Settings as SettingsIcon, Lock, ShieldCheck, KeyRound,
  MonitorPlay, Layers, Mic, RefreshCw, Rocket, Download, ChevronRight, Eye, Server, MessagesSquare,
} from 'lucide-react';

// v2.0.0 marketing page. Product images in /marketing/v2 are captured from the
// desktop client's dev preview pages (web-portal strip-preview.html /
// stream-preview.html) with mock data only — "Ghost Fleet", Nova, Kestrel… —
// composited over in-game backdrops. Re-shoot them from those pages rather
// than from a live client (transparent windows fade in screen captures, and
// live data has real names in it).
const IMG = '/marketing/v2';

const CLIENT_VERSION = '2.0.0';

function detectPlatform() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  return 'linux';
}

// Fade/slide in once when scrolled into view. Transform + opacity only, so the
// page never shifts layout while it reveals.
function Reveal({ children, className = '', as: Tag = 'div', delay = 0 }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setShown(true); return undefined; }
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setShown(true); obs.disconnect(); }
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return (
    <Tag
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={`transition-[opacity,transform] duration-700 ease-out ${shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'} ${className}`}
    >
      {children}
    </Tag>
  );
}

// Product shot: intrinsic width/height reserve space (no layout shift).
function Shot({ name, w, h, alt, eager = false, className = '' }) {
  return (
    <img
      src={`${IMG}/${name}.webp`}
      width={w}
      height={h}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      fetchpriority={eager ? 'high' : undefined}
      className={`block w-full h-auto rounded-ui-lg border border-cyan-400/15 shadow-[0_20px_60px_rgba(0,0,0,0.55)] ${className}`}
    />
  );
}

function Eyebrow({ children }) {
  return <div className="font-mono text-[12px] uppercase tracking-[0.22em] text-specter-primary-neon mb-3">{children}</div>;
}

function SectionHead({ eyebrow, title, children, center = false }) {
  return (
    <Reveal className={`max-w-2xl ${center ? 'mx-auto text-center' : ''}`}>
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 className="text-[28px] sm:text-[34px] leading-tight font-semibold text-white">{title}</h2>
      {children && <p className="mt-4 text-ui-lg text-specter-text-muted leading-relaxed">{children}</p>}
    </Reveal>
  );
}

function Bullet({ children }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden="true" className="mt-[9px] h-1.5 w-1.5 flex-none rounded-full bg-specter-primary-neon" />
      <span>{children}</span>
    </li>
  );
}

const panel = 'rounded-ui-lg border border-cyan-400/15 bg-[#081828]/80';

// ── Strip cabinets (the five buttons on the bar) ───────────────────────────
const CABINETS = [
  { icon: Radio, title: 'Channels', body: 'Voice and text side by side. Unread badges, who’s in each room, and one click to join.' },
  { icon: CalendarClock, title: 'Operations', body: 'Calendar, Now & soon and History, plus the mission planner and op view.' },
  { icon: Bell, title: 'Notifications', body: 'Ops you signed up for that launch soon, and ops about to launch with open slots.' },
  { icon: Gamepad2, title: 'Games', body: 'Game tools. Star Citizen: your hangar and a ship editor with loadouts and stats.' },
  { icon: SettingsIcon, title: 'Settings', body: 'Audio devices, voice activation, push-to-talk key, timezone and more.' },
];

// ── Overlay demo ───────────────────────────────────────────────────────────
// Mirrors the restyled in-game overlay (GameOverlayWindow.jsx + overlay.css in
// the client): 384px wide at 100%, 36px header, 16:9 stream below, rounded
// navy panel, sans text. Rendered at true size and scaled down with the frame.
const OV_W = 384;
const OV_HEADER = 36;
const OV_SCALES = [0.75, 1, 1.25, 1.5];
const OV_STREAMS = [
  { id: 'Kestrel', img: `${IMG}/game-squad.webp`, pos: '40% 50%', size: 'cover' },
  { id: 'Rook', img: `${IMG}/game-squad.webp`, pos: '92% 70%', size: '220%' },
];

function OverlayDemo() {
  const frameRef = useRef(null);
  const dragRef = useRef(null);
  const [frameW, setFrameW] = useState(960);
  const [pos, setPos] = useState({ left: 58, top: 8 });
  const [scale, setScale] = useState(1);
  const [pass, setPass] = useState(true);
  const [picker, setPicker] = useState(false);
  const [watching, setWatching] = useState('Kestrel');

  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setFrameW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The frame stands in for a 1920px-wide game; on small screens keep the HUD legible.
  const gameScale = Math.max(frameW / 1920, 0.42);
  const pillPct = ((OV_W * gameScale * scale) / Math.max(frameW, 1)) * 100;

  const onDown = (e) => {
    const r = frameRef.current.getBoundingClientRect();
    dragRef.current = { x: e.clientX, y: e.clientY, left: pos.left, top: pos.top, w: r.width, h: r.height };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({
      left: Math.min(Math.max(d.left + ((e.clientX - d.x) / d.w) * 100, 0), Math.max(100 - pillPct, 0)),
      top: Math.min(Math.max(d.top + ((e.clientY - d.y) / d.h) * 100, 0), 70),
    });
  };
  const onUp = () => { dragRef.current = null; };
  const active = OV_STREAMS.find((s) => s.id === watching);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <p className="text-ui-sm text-specter-text-subtle">
          {pass ? 'Passthrough is on: clicks go to the game. Turn it off to try the overlay.' : 'Drag the header to move it, click the % to resize, click the channel to switch streams.'}
        </p>
        <button
          type="button"
          onClick={() => { setPass((v) => !v); setPicker(false); }}
          aria-pressed={pass}
          className={`inline-flex items-center gap-2 rounded-ui-row border px-3 py-1.5 text-ui-sm font-semibold transition-colors ${pass ? 'border-amber-400/50 bg-amber-400/10 text-amber-300' : 'border-slate-500/40 text-slate-300 hover:border-cyan-400/50'}`}
        >
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${pass ? 'bg-amber-400' : 'bg-slate-600'}`} />
          Passthrough {pass ? 'on' : 'off'}
        </button>
      </div>
      <div
        ref={frameRef}
        className="relative w-full overflow-hidden rounded-ui-lg border border-cyan-400/15"
        style={{ aspectRatio: '16 / 9', backgroundImage: `url('${IMG}/game-corridor.webp')`, backgroundSize: 'cover', backgroundPosition: 'center' }}
        role="img"
        aria-label="Interactive mock-up of the SpecterComs in-game overlay showing a teammate's stream over a game"
      >
        <div
          className="absolute select-none"
          style={{
            left: `${pos.left}%`, top: `${pos.top}%`, width: OV_W,
            transform: `scale(${gameScale * scale})`, transformOrigin: 'top left',
            pointerEvents: pass ? 'none' : 'auto',
            fontFamily: '"Segoe UI Variable", "Segoe UI", Inter, system-ui, sans-serif',
          }}
        >
          <div className="overflow-hidden" style={{ borderRadius: 10, background: '#081828', color: '#ecf9ff', boxShadow: '0 8px 30px rgba(0,0,0,0.5)' }}>
            <div
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
              style={{ height: OV_HEADER, display: 'flex', alignItems: 'center', gap: 6, padding: '0 6px 0 8px', cursor: 'grab', touchAction: 'none' }}
            >
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setPicker((v) => !v)}
                style={{ flex: '1 1 auto', minWidth: 32, height: 28, padding: '0 6px', display: 'flex', alignItems: 'center', gap: 6, borderRadius: 6, fontSize: 13, fontWeight: 600, background: 'transparent', color: 'inherit', textAlign: 'left' }}
              >
                <span style={{ color: '#22d3ee', fontSize: 11 }}>◈</span>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Bridge</span>
                <span style={{ color: '#86a9bd', fontSize: 9 }}>{picker ? '▲' : '▼'}</span>
              </button>
              <span style={{ height: 24, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 6, borderRadius: 9999, background: 'rgba(34,197,94,0.14)', border: '1px solid rgba(74,222,128,0.45)', flexShrink: 0 }}>
                <span style={{ color: '#4ade80', fontSize: 8 }}>◉</span>
                <span style={{ color: '#4ade80', fontSize: 12, fontWeight: 600 }}>Nova</span>
              </span>
              {pass && (
                <span style={{ flexShrink: 0, padding: '1px 6px', border: '1px solid rgba(245,158,11,0.5)', borderRadius: 6, background: 'rgba(245,158,11,0.14)', color: '#fbbf24', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em' }}>PASS</span>
              )}
              <span style={{ color: '#86a9bd', fontSize: 14, flexShrink: 0 }} aria-hidden="true">⠿</span>
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setScale((s) => OV_SCALES[(OV_SCALES.indexOf(s) + 1) % OV_SCALES.length])}
                style={{ minWidth: 44, height: 26, borderRadius: 6, fontSize: 12, fontWeight: 600, color: '#86a9bd', background: 'transparent', flexShrink: 0 }}
                aria-label="Cycle overlay size"
              >
                {Math.round(scale * 100)}%
              </button>
              <span style={{ color: '#86a9bd', fontSize: 14, padding: '0 6px', flexShrink: 0 }} aria-hidden="true">✕</span>
            </div>
            {picker && (
              <div style={{ borderTop: '1px solid rgba(95,209,240,0.24)', padding: 4, display: 'flex', flexDirection: 'column', gap: 2 }} onPointerDown={(e) => e.stopPropagation()}>
                {[{ id: null }, ...OV_STREAMS].map((s) => (
                  <button
                    key={s.id || 'none'}
                    type="button"
                    onClick={() => { setWatching(s.id); setPicker(false); }}
                    style={{ height: 30, padding: '0 8px', display: 'flex', alignItems: 'center', gap: 8, borderRadius: 8, fontSize: 13, textAlign: 'left', color: watching === s.id ? '#ecf9ff' : '#b7d1df', background: watching === s.id ? 'rgba(6,182,212,0.14)' : 'transparent' }}
                  >
                    <span style={{ width: 16, textAlign: 'center', fontSize: 10, color: watching === s.id ? '#22d3ee' : '#86a9bd' }}>{s.id ? '▶' : '—'}</span>
                    <span style={{ flex: 1 }}>{s.id || 'No stream'}</span>
                    {s.id && watching === s.id && <span style={{ fontSize: 12, color: '#22d3ee' }}>Watching</span>}
                  </button>
                ))}
              </div>
            )}
            {active && (
              <div style={{ position: 'relative', aspectRatio: '16 / 9', borderTop: '1px solid rgba(95,209,240,0.24)', backgroundImage: `url('${active.img}')`, backgroundSize: active.size, backgroundPosition: active.pos, backgroundColor: '#000' }}>
                <button
                  type="button"
                  onClick={() => setWatching(null)}
                  style={{ position: 'absolute', right: 8, bottom: 8, height: 26, padding: '0 10px', borderRadius: 6, border: '1px solid rgba(239,68,68,0.5)', background: 'rgba(0,0,0,0.72)', color: '#fca5a5', fontSize: 12, fontWeight: 600 }}
                >
                  ✕ Stop
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <p className="mt-2 text-ui-xs text-specter-text-subtle">Mock-up for illustration. In the app the overlay is its own always-on-top window over your game.</p>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────
const NAV = [
  { href: '#bar', label: 'The bar' },
  { href: '#operations', label: 'Operations' },
  { href: '#star-citizen', label: 'Star Citizen' },
  { href: '#security', label: 'Security' },
  { href: '#whats-new', label: 'What’s new' },
];

const WHATS_NEW = [
  { icon: Layers, title: 'The tray bar is the app', body: 'The old full window is gone. SpecterComs opens as a bar docked above your taskbar, and everything you need slides out of it.' },
  { icon: Lock, title: 'End-to-end encrypted voice', body: 'Every voice channel, including operation channels, is now end-to-end encrypted, with replay protection. Voice requires v2.0.0.' },
  { icon: Radio, title: 'Channels and real chat', body: 'Voice and text in one cabinet that widens as you open a room. Encrypted chat with unread badges, and Overlay and Screenshare buttons on the bar while you’re in voice.' },
  { icon: MonitorPlay, title: 'Stream viewer', body: 'Watch a teammate’s screenshare right above the bar, expand it, or send it to the game overlay.' },
  { icon: CalendarClock, title: 'Operations, rebuilt', body: 'Calendar, Now & soon and History tabs. A guided mission planner that grows out of the bar, and a tree-first op view where you sign up inside the tree.' },
  { icon: Rocket, title: 'Ship sign-up from your hangar', body: 'For Star Citizen ops, pick a ship from your hangar, then your seat. Hangar and ship editor live under Games.' },
  { icon: Mic, title: 'Adaptive voice activation', body: 'Learns your background noise and only opens your mic for speech, with RNNoise noise suppression. Manual threshold and push-to-talk are still there.' },
  { icon: RefreshCw, title: 'Quiet auto-updates', body: 'The client checks for updates at startup and every few hours, downloads them in the background, and shows “Restart to update” when one is ready.' },
];

const LandingPage = ({ onEnter }) => {
  const [downloadError, setDownloadError] = useState('');

  const handleDownload = async () => {
    setDownloadError('');
    const platform = detectPlatform();
    try {
      const res = await fetch(`/api/downloads?platform=${platform}`, { method: 'HEAD' });
      if (res.ok) {
        window.location.href = `/api/downloads?platform=${platform}`;
      } else {
        setDownloadError('Download not available for your platform. Please try again later.');
      }
    } catch {
      setDownloadError('Download service is temporarily unavailable.');
    }
  };

  const DownloadButton = ({ big = false }) => (
    <button
      type="button"
      onClick={handleDownload}
      className={`inline-flex items-center justify-center gap-2 rounded-ui-md bg-specter-primary-cyan font-semibold text-[#03121c] transition-colors hover:bg-specter-primary-neon ${big ? 'px-6 py-3 text-ui-lg' : 'px-4 py-2 text-ui-base'}`}
    >
      <Download size={big ? 18 : 16} aria-hidden="true" />
      Download for Windows
    </button>
  );

  return (
    <div className="mkt relative min-h-screen overflow-x-hidden bg-specter-bg-deep font-ui text-ui-base text-specter-text-main">
      {/* Backdrop: the brand's network texture, kept faint behind everything. */}
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 bg-cover bg-center opacity-50" style={{ backgroundImage: `url('${IMG}/bg-network.webp')` }} />
      <div aria-hidden="true" className="pointer-events-none fixed -top-1/4 -left-1/4 h-3/4 w-3/4 rounded-full bg-cyan-500/10 blur-[140px]" />

      {/* Nav */}
      <header className="sticky top-0 z-30 border-b border-white/5 bg-[#020913]/80 backdrop-blur-md">
        <nav className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6" aria-label="Main">
          <a href="#top" className="flex items-center gap-2 font-semibold text-white">
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8.66 5v10L12 22l-8.66-5V7z" fill="rgba(34,211,238,0.12)" stroke="#22d3ee" strokeWidth="2" /></svg>
            SpecterComs
          </a>
          <div className="ml-4 hidden gap-5 text-ui-sm text-specter-text-subtle lg:flex">
            {NAV.map((n) => <a key={n.href} href={n.href} className="hover:text-white transition-colors">{n.label}</a>)}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={onEnter} className="rounded-ui-row px-3 py-1.5 text-ui-sm font-semibold text-specter-text-muted hover:text-white transition-colors">
              Sign in
            </button>
            <button type="button" onClick={handleDownload} className="hidden sm:inline-flex items-center gap-1.5 rounded-ui-row border border-cyan-400/40 px-3 py-1.5 text-ui-sm font-semibold text-specter-primary-neon hover:bg-cyan-400/10 transition-colors">
              <Download size={14} aria-hidden="true" /> Download
            </button>
          </div>
        </nav>
      </header>

      <main id="top" className="relative z-10">
        {/* ── Hero ───────────────────────────────────────────────────────── */}
        <section className="mx-auto max-w-6xl px-4 pt-12 sm:px-6 sm:pt-16">
          <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.15fr]">
            <div>
              <img src={`${IMG}/brand-banner.webp`} width="960" height="297" alt="SpecterComs" className="mb-6 h-auto w-full max-w-[360px] drop-shadow-[0_0_24px_rgba(6,182,212,0.35)]" fetchpriority="high" />
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-ui-xs font-semibold text-emerald-300">
                <Lock size={12} aria-hidden="true" /> New in v{CLIENT_VERSION}: end-to-end encrypted voice
              </div>
              <h1 className="text-[34px] leading-[1.1] sm:text-[46px] font-semibold tracking-tight text-white">
                Squad comms that live in your taskbar.
              </h1>
              <p className="mt-5 max-w-xl text-ui-lg sm:text-[18px] sm:leading-8 text-specter-text-muted">
                SpecterComs is voice, chat and operation planning for squads and gaming orgs. It runs as a slim bar above your Windows taskbar, stays out of your game, and encrypts voice, video and text end to end.
              </p>
              <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                <DownloadButton big />
                <button type="button" onClick={onEnter} className="inline-flex items-center justify-center gap-2 rounded-ui-md border border-white/15 px-6 py-3 text-ui-lg font-semibold text-white hover:border-cyan-400/50 hover:bg-white/5 transition-colors">
                  Create account / Sign in
                </button>
              </div>
              {downloadError && <p role="alert" className="mt-3 text-ui-sm text-red-400">{downloadError}</p>}
              <p className="mt-4 text-ui-sm text-specter-text-subtle">
                Desktop app for Windows · v{CLIENT_VERSION} is required for voice · updates install with one restart
              </p>
            </div>
            <Reveal>
              <Shot
                eager
                name="hero-desktop" w={1760} h={1140}
                alt="A game running on a Windows desktop. The SpecterComs bar sits just above the taskbar showing the server Ghost Fleet and Nova talking, with Kestrel's live screenshare in a viewer above it."
              />
            </Reveal>
          </div>
        </section>

        {/* ── The bar ───────────────────────────────────────────────────── */}
        <section id="bar" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-24 sm:px-6 sm:pt-32">
          <SectionHead eyebrow="The tray bar" title="One bar. Everything slides out of it.">
            Click the tray icon and the bar appears above your taskbar: your server’s logo and name, who’s talking, live streams and ops, and five cabinets. Panels open where there’s room and get out of the way when you go back to your game.
          </SectionHead>
          <Reveal className="mt-10 grid items-center gap-8 lg:grid-cols-[minmax(0,420px)_1fr]">
            <div>
              <Shot name="bar" w={696} h={189} alt="The SpecterComs bar: Ghost Fleet server logo and name, a Nova +1 speaking chip, stream and overlay buttons, and the Channels, Operations, Notifications, Games and Settings icons." />
              <p className="mt-3 text-ui-sm text-specter-text-subtle">The bar’s top row changes with what’s happening: who’s talking, a stream to watch, a live op, or an update waiting.</p>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2">
              {CABINETS.map(({ icon: Icon, title, body }) => (
                <li key={title} className={`${panel} flex gap-3 p-4`}>
                  <Icon size={20} className="mt-0.5 flex-none text-specter-primary-neon" aria-hidden="true" />
                  <div>
                    <div className="font-semibold text-white">{title}</div>
                    <div className="mt-1 text-ui-sm text-specter-text-subtle leading-relaxed">{body}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Reveal>
        </section>

        {/* ── Channels ──────────────────────────────────────────────────── */}
        <section id="channels" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-24 sm:px-6 sm:pt-32">
          <SectionHead eyebrow="Channels" title="Voice and chat in one cabinet.">
            Open Channels to see every voice room and who’s in it. Click once to look inside, twice to join. Text channels open a real chat next to the list, with unread counts on every channel and on the bar.
          </SectionHead>
          <div className="mt-10 grid items-start gap-6 md:grid-cols-[1fr_1.6fr]">
            <Reveal>
              <Shot name="channels-voice" w={732} h={633} alt="Inside the Bridge voice channel: Connected with a lock icon, four people, Nova and Rook speaking, a stream icon next to Kestrel, and Mute and Leave buttons." />
              <p className="mt-3 text-ui-sm text-specter-text-subtle">The lock next to “Connected” means your channel key is in place and voice is end-to-end encrypted.</p>
            </Reveal>
            <Reveal delay={120}>
              <Shot name="channels-chat" w={1392} h={1086} alt="The Channels cabinet widened to show the #general chat beside the channel list, with unread badges of 3 and 12 on other text channels." />
            </Reveal>
          </div>
          <Reveal className={`${panel} mt-8 grid gap-6 p-6 md:grid-cols-3`}>
            <div>
              <div className="flex items-center gap-2 font-semibold text-white"><Mic size={18} className="text-specter-primary-neon" aria-hidden="true" /> Adaptive voice activation</div>
              <p className="mt-2 text-ui-sm text-specter-text-subtle leading-relaxed">Auto mode learns your background noise and only sends when it hears a voice, so fans, hum and typing stay off the air. RNNoise-based suppression cleans up what’s left.</p>
            </div>
            <div>
              <div className="flex items-center gap-2 font-semibold text-white"><SettingsIcon size={18} className="text-specter-primary-neon" aria-hidden="true" /> Your choice of trigger</div>
              <p className="mt-2 text-ui-sm text-specter-text-subtle leading-relaxed">Prefer control? Set a manual threshold with a live meter, or use push-to-talk on any key.</p>
            </div>
            <div>
              <div className="flex items-center gap-2 font-semibold text-white"><Radio size={18} className="text-specter-primary-neon" aria-hidden="true" /> Leaders cut through</div>
              <p className="mt-2 text-ui-sm text-specter-text-subtle leading-relaxed">In an operation, high-priority roles duck everyone else while they talk, so the call that matters lands clean.</p>
            </div>
          </Reveal>
        </section>

        {/* ── Streams & overlay ─────────────────────────────────────────── */}
        <section id="streams" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-24 sm:px-6 sm:pt-32">
          <SectionHead eyebrow="Streams & overlay" title="See what your squad sees, without alt-tabbing.">
            Share your screen or a single window from the bar. Teammates watch it in a viewer right above the bar, expand it, or send it to the game overlay, a small always-on-top HUD with the channel, who’s talking and the stream.
          </SectionHead>
          <div className="mt-10 grid gap-8 lg:grid-cols-2">
            <Reveal>
              <Shot name="stream-expanded" w={1600} h={900} alt="An expanded stream viewer showing Kestrel's live screenshare of a squad boarding a ship, docked above the SpecterComs bar." />
              <p className="mt-3 text-ui-sm text-specter-text-subtle">The stream viewer: watch, expand, or move it into the overlay with one click.</p>
            </Reveal>
            <Reveal delay={120}>
              <OverlayDemo />
            </Reveal>
          </div>
          <Reveal className="mt-6">
            <ul className="grid gap-3 text-ui-sm text-specter-text-muted sm:grid-cols-2 lg:grid-cols-4">
              <li className={`${panel} p-4`}><span className="font-semibold text-white">Passthrough hotkey.</span> Clicks go straight to your game until you need the overlay.</li>
              <li className={`${panel} p-4`}><span className="font-semibold text-white">Sized for your screen.</span> Cycle 75–150% with one click.</li>
              <li className={`${panel} p-4`}><span className="font-semibold text-white">Who’s talking.</span> A live speaker chip in the header.</li>
              <li className={`${panel} p-4`}><span className="font-semibold text-white">Encrypted.</span> Stream video is encrypted before it leaves the sharer’s PC.</li>
            </ul>
          </Reveal>
        </section>

        {/* ── Operations ────────────────────────────────────────────────── */}
        <section id="operations" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-24 sm:px-6 sm:pt-32">
          <SectionHead eyebrow="Operations" title="Plan the op. Run it from the same bar.">
            The Operations cabinet holds your server’s calendar, what’s live now and coming soon, and history. Times show in each member’s own timezone. Create an op and a guided planner grows out of the bar, one step at a time.
          </SectionHead>
          <div className="mt-10 grid items-start gap-6 md:grid-cols-[0.8fr_1.6fr]">
            <Reveal className="grid gap-6">
              <Shot name="ops-now" w={693} h={888} alt="The Operations cabinet on the Now & soon tab: Operation Thunderstrike live, Convoy Escort and a mining run with Launch buttons, and later ops." />
              <Shot name="notifications" w={672} h={414} alt="The Notifications cabinet listing a live op, an op launching in 18 minutes, and an op with 3 open slots and a Join button." />
            </Reveal>
            <Reveal delay={120} className="grid gap-6">
              <Shot name="planner-groups" w={1464} h={1382} alt="The mission planner on the Groups step: a tree with Command at the bottom, Escort Wing and Cargo above it, and three flights on top, with the selected group's settings on the right and step navigation above the bar." />
            </Reveal>
          </div>
          <div className="mt-6 grid items-start gap-6 md:grid-cols-2">
            <Reveal>
              <Shot name="planner-comms" w={1356} h={857} alt="The planner's Comms step: frequencies FREQ A, MEDEVAC and LOGI, each listing the roles allowed to reach it." />
            </Reveal>
            <Reveal delay={120}>
              <ul className="space-y-3 text-ui-base text-specter-text-muted leading-relaxed">
                <Bullet><span className="font-semibold text-white">Groups as a tree.</span> The top tier sits at the bottom and groups that report to it stack above. Drag a group onto another to move it. Link groups that work together.</Bullet>
                <Bullet><span className="font-semibold text-white">Roles and priority.</span> Set slots per role, pick the commander, and give leaders priority so they cut through.</Bullet>
                <Bullet><span className="font-semibold text-white">Frequencies.</span> Extra channels only the roles you choose can reach, by keybind, mid-op.</Bullet>
                <Bullet><span className="font-semibold text-white">Presets.</span> Save a layout once and reuse it for the next op.</Bullet>
                <Bullet><span className="font-semibold text-white">Tree-first op view.</span> Members open an op as its tree, zoom into a group, and sign up for a seat right there.</Bullet>
                <Bullet><span className="font-semibold text-white">Launch.</span> One click builds the op’s voice channels from the tree.</Bullet>
              </ul>
            </Reveal>
          </div>
        </section>

        {/* ── Star Citizen ──────────────────────────────────────────────── */}
        <section id="star-citizen" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-24 sm:px-6 sm:pt-32">
          <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.1fr]">
            <div>
              <SectionHead eyebrow="Star Citizen" title="Fleet ops, with your actual ships.">
                Planners set the ships each group flies. Members sign up by picking a ship from their hangar, then a seat, and the op tracks who brings what.
              </SectionHead>
              <Reveal>
                <ul className="mt-6 space-y-3 text-ui-base text-specter-text-muted leading-relaxed">
                  <Bullet><span className="font-semibold text-white">Hangar.</span> Keep your ships in Games → Star Citizen → Hangar, with names and images from community data.</Bullet>
                  <Bullet><span className="font-semibold text-white">Ship editor.</span> Seats, loadouts and combat stats for each ship you own.</Bullet>
                  <Bullet><span className="font-semibold text-white">Ship composition.</span> Planners set how many of which ship each group needs, and close matches can be approved.</Bullet>
                  <Bullet><span className="font-semibold text-white">Sign up in three steps.</span> Ship, role, confirm, inside the op’s tree.</Bullet>
                </ul>
                <p className="mt-4 text-ui-sm text-specter-text-subtle">Ship details and stats come from community data sources and fill in as they become available. Not every ship has full stats yet.</p>
              </Reveal>
            </div>
            <Reveal delay={120}>
              <Shot name="event-ship-signup" w={1182} h={1194} alt="An op's tree zoomed in on Escort Wing, flying Hornet F7Cs, with a sign-up panel asking you to assign a ship from your hangar: Lucky Strike fills a Hornet slot, Arrow is an approved similar ship, and a Cutlass Black isn't a match." />
            </Reveal>
          </div>
        </section>

        {/* ── Security ──────────────────────────────────────────────────── */}
        <section id="security" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-24 sm:px-6 sm:pt-32">
          <SectionHead eyebrow="Security" title="Encrypted end to end. Voice included.">
            As of v{CLIENT_VERSION}, voice, screen sharing and text are encrypted on your PC and decrypted on your teammates’ PCs. Our servers route the traffic, but they don’t have the keys.
          </SectionHead>
          <Reveal className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div className={`${panel} p-5`}>
              <MessagesSquare size={20} className="text-specter-primary-neon" aria-hidden="true" />
              <h3 className="mt-3 font-semibold text-white">Text, DMs and op chat</h3>
              <p className="mt-2 text-ui-sm text-specter-text-subtle leading-relaxed">Messages use MLS (RFC 9420, via OpenMLS). Each channel is an MLS group, and the server relays ciphertext it can’t read.</p>
            </div>
            <div className={`${panel} p-5`}>
              <Lock size={20} className="text-specter-primary-neon" aria-hidden="true" />
              <h3 className="mt-3 font-semibold text-white">Voice, in every channel</h3>
              <p className="mt-2 text-ui-sm text-specter-text-subtle leading-relaxed">New in 2.0. Audio is encrypted with ChaCha20-Poly1305 using per-session keys derived from the channel’s MLS group. Each frame carries a counter and a timestamp, so recorded audio can’t be replayed into the channel. The voice server forwards encrypted frames and never decodes your audio.</p>
            </div>
            <div className={`${panel} p-5`}>
              <ShieldCheck size={20} className="text-specter-primary-neon" aria-hidden="true" />
              <h3 className="mt-3 font-semibold text-white">No unencrypted fallback</h3>
              <p className="mt-2 text-ui-sm text-specter-text-subtle leading-relaxed">If a channel key isn’t ready, the client stays silent and shows “Waiting for channel key…” until it is. Clients older than v{CLIENT_VERSION} are refused from voice with an update prompt.</p>
            </div>
            <div className={`${panel} p-5`}>
              <MonitorPlay size={20} className="text-specter-primary-neon" aria-hidden="true" />
              <h3 className="mt-3 font-semibold text-white">Screen sharing</h3>
              <p className="mt-2 text-ui-sm text-specter-text-subtle leading-relaxed">Stream video is encrypted with a key derived from the channel’s MLS group before it leaves the sharer’s PC.</p>
            </div>
            <div className={`${panel} p-5`}>
              <KeyRound size={20} className="text-specter-primary-neon" aria-hidden="true" />
              <h3 className="mt-3 font-semibold text-white">Keys stay on your PC</h3>
              <p className="mt-2 text-ui-sm text-specter-text-subtle leading-relaxed">Your encryption keys are created on your computer. The local encryption state is sealed with a key kept in the Windows credential store.</p>
            </div>
            <div className={`${panel} p-5`}>
              <Eye size={20} className="text-specter-primary-neon" aria-hidden="true" />
              <h3 className="mt-3 font-semibold text-white">What the server still sees</h3>
              <p className="mt-2 text-ui-sm text-specter-text-subtle leading-relaxed">Encryption covers content, not everything. To run your server we still handle account details, server and channel membership, who is connected and when someone is transmitting (for speaking indicators and priority), and operation plans, rosters and calendars.</p>
            </div>
          </Reveal>
          <Reveal className="mt-6 flex items-start gap-3 text-ui-sm text-specter-text-subtle">
            <Server size={18} className="mt-0.5 flex-none text-specter-text-subtle" aria-hidden="true" />
            <p>We don’t sell your data, track your activity for ads, or train anything on your voice. Abuse reports are still handled. The client’s source is published on GitHub so you can check how it works.</p>
          </Reveal>
        </section>

        {/* ── What's new in 2.0 ────────────────────────────────────────── */}
        <section id="whats-new" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-24 sm:px-6 sm:pt-32">
          <SectionHead eyebrow={`v${CLIENT_VERSION}`} title="What’s new in 2.0" />
          <Reveal className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {WHATS_NEW.map(({ icon: Icon, title, body }) => (
              <div key={title} className={`${panel} p-5`}>
                <Icon size={20} className="text-specter-primary-neon" aria-hidden="true" />
                <h3 className="mt-3 font-semibold text-white">{title}</h3>
                <p className="mt-2 text-ui-sm text-specter-text-subtle leading-relaxed">{body}</p>
              </div>
            ))}
          </Reveal>
        </section>

        {/* ── Get started / download ───────────────────────────────────── */}
        <section id="download" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-24 sm:px-6 sm:py-32">
          <Reveal className={`${panel} overflow-hidden`}>
            <div className="grid gap-0 lg:grid-cols-[1.2fr_1fr]">
              <div className="p-6 sm:p-10">
                <Eyebrow>Get started</Eyebrow>
                <h2 className="text-[28px] sm:text-[34px] leading-tight font-semibold text-white">Up and running in three steps.</h2>
                <ol className="mt-6 space-y-5">
                  {[
                    { n: 1, t: 'Create an account', b: 'Sign up here on the website and verify your email. Your callsign is 3–32 letters, numbers or underscores, and your email is never shown to other users.', cta: <button type="button" onClick={onEnter} className="mt-2 inline-flex items-center gap-1 text-ui-sm font-semibold text-specter-primary-neon hover:text-white">Create account <ChevronRight size={14} aria-hidden="true" /></button> },
                    { n: 2, t: 'Join a server', b: 'Browse public servers in Discover, or open an invite link from your group.' },
                    { n: 3, t: 'Install the app', b: 'Voice, chat, the overlay and operations all live in the desktop app. Sign in and the bar appears above your taskbar.' },
                  ].map((s) => (
                    <li key={s.n} className="flex gap-4">
                      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full border border-cyan-400/40 font-mono text-ui-sm text-specter-primary-neon">{s.n}</span>
                      <div>
                        <div className="font-semibold text-white">{s.t}</div>
                        <p className="mt-1 text-ui-sm text-specter-text-subtle leading-relaxed">{s.b}</p>
                        {s.cta}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="border-t border-white/5 bg-[#020913]/50 p-6 sm:p-10 lg:border-l lg:border-t-0">
                <div className="font-mono text-ui-xs uppercase tracking-[0.2em] text-specter-text-subtle">Windows desktop app</div>
                <div className="mt-2 text-[26px] font-semibold text-white">SpecterComs {CLIENT_VERSION}</div>
                <p className="mt-1 text-ui-sm font-semibold text-amber-300">Required for voice</p>
                <div className="mt-5"><DownloadButton big /></div>
                {downloadError && <p role="alert" className="mt-3 text-ui-sm text-red-400">{downloadError}</p>}
                <ul className="mt-6 space-y-2.5 text-ui-sm text-specter-text-subtle leading-relaxed">
                  <Bullet><span className="text-specter-text-muted">Already on 1.10?</span> Your client offers 2.0.0 by itself. Accept the update; after the restart, SpecterComs lives in the tray bar. Click the tray icon to open it.</Bullet>
                  <Bullet>Older clients can still use text, but voice requires {CLIENT_VERSION}, so everyone in your server needs to update.</Bullet>
                  <Bullet>Updates are signed and download in the background. When one is ready, the bar shows “Restart to update”.</Bullet>
                  <Bullet>Voice frames are time-stamped, so keep Windows’ clock set automatically. A clock more than 30 seconds off can make you silent to others.</Bullet>
                </ul>
                <details className="mt-5 text-ui-sm text-specter-text-subtle">
                  <summary className="cursor-pointer font-semibold text-specter-text-muted hover:text-white">What the installer asks for</summary>
                  <ul className="mt-3 space-y-1.5 pl-1">
                    <li>Microphone, for voice</li>
                    <li>Screen capture, only when you share</li>
                    <li>Global hotkeys, for push-to-talk and the overlay</li>
                    <li>An always-on-top, click-through overlay window</li>
                    <li>Network access for sign-in, voice and signed updates</li>
                  </ul>
                </details>
              </div>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/5 px-4 py-8 text-center text-ui-xs text-specter-text-subtle">
        <div className="mx-auto max-w-md space-y-2">
          <a
            href="https://github.com/Wr3ck4ge/SpecterComs"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-ui-sm font-semibold text-specter-text-muted hover:text-specter-primary-neon transition-colors"
          >
            <svg className="h-3.5 w-3.5 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" /></svg>
            github.com/Wr3ck4ge/SpecterComs
          </a>
          <p className="leading-relaxed">
            Not open source: this isn’t licensed for reuse or redistribution. The repo is a snapshot of the app’s actual code, published for transparency so anyone can see how it’s built.
          </p>
          <p>&copy; 2026 SpecterComs. End-to-end encrypted voice and text. Data-broker free.</p>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
