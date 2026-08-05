import React, { useState, useRef, useEffect } from 'react';

// Real pixel dimensions from GameOverlayWindow.jsx — the mockup renders its
// header/preview at these exact sizes, then scales the whole thing down with
// one CSS transform, so proportions (and text) match the actual overlay
// instead of an arbitrarily-large "marketing" size.
const OVERLAY_REAL_W = 384;
const OVERLAY_REAL_HEADER_H = 32;
const OVERLAY_REAL_STREAM_H = 216;
// The backdrop screenshot is treated as a 2560×1440 desktop — this is what
// "reasonable scale" is computed against, regardless of how wide the frame
// actually renders on the page.
const REFERENCE_SCREEN_W = 2560;

const OVERLAY_SCALE_STEPS = [0.75, 1, 1.25, 1.5];
// Horizontally centered (50 - 15/2). Vertically, centered on the HEADER row
// (where 3 of the 4 annotation dots point) rather than the pill's full
// header+preview bounding box, so the callout dots land at the frame's true
// center instead of sitting above it. Matches the annotation math below —
// update both together if either changes.
const OVERLAY_BASE_LEFT = 42.5; // %
const OVERLAY_BASE_TOP = 48.9;  // %

// Stand-ins for teammates' streams — reuses the two real screenshots we have.
// Swap in more entries once more screenshots are on hand.
const OVERLAY_STREAM_OPTIONS = [
  { id: null, label: '— NONE —' },
  { id: 'MACADEN', label: 'MACADEN', img: '/marketing/overlay-teammate-feed.jpg', pos: '60% 45%' },
  { id: 'BLINMUNCHER', label: 'BLINMUNCHER', img: '/marketing/overlay-demo-bg.jpg', pos: '30% 55%' },
  { id: 'SCOTTISHGIMP289', label: 'SCOTTISHGIMP289', img: '/marketing/overlay-stream-corridor.jpg', pos: '50% 35%' },
  { id: 'CAPT_NORDMEAT', label: 'CAPT_NORDMEAT', img: '/marketing/overlay-stream-squad.jpg', pos: '45% 45%' },
];

// Frequency demo — mirrors the real primary-channel + liaison-frequency model
// from WarRoom.jsx: index 0 is always the primary group channel (always
// connected); everything after it is a liaison frequency the user's role
// grants for an operation. Only one channel is ever the active TX target —
// everything else is still audible, just passively monitored at lower volume
// (see WarRoom.jsx's "PASSIVE FREQ RX" monitor instances).
const FREQ_CHANNELS = [
  { id: 0, label: 'ALPHA SQUAD', kind: 'primary' },
  { id: 1, label: 'COMMAND', kind: 'liaison' },
  { id: 2, label: 'BRAVO FIRETEAM', kind: 'liaison' },
  { id: 3, label: 'RECON', kind: 'liaison' },
];

// Group builder demo — a simplified mirror of OperationPlanner.jsx's real
// GroupPlanner: a nested tree of groups, each with roles that carry a 1-5
// ducking priority (server-side in media-rust's mixer: priority speech drops
// everyone else's gain ~-20dB and cascades to descendant channels) and an
// exclusive commander flag, plus liaison frequencies each authorized for a
// specific set of group/role combos (role_refs).
const PRIORITY_LABELS = ['LOW', 'MED-LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const PRIORITY_COLORS = ['#64748b', '#0891b2', '#22d3ee', '#f59e0b', '#ef4444'];
const GROUP_BUILDER_DATA = {
  general: {
    nodes: [
      { id: 'root', parent: null, tier: 1, name: 'OPERATION ALPHA',
        roles: [
          { name: 'Team Lead', priority: 5, commander: true },
          { name: 'Comms Officer', priority: 3, commander: false },
        ] },
      { id: 'assault', parent: 'root', tier: 2, name: 'ASSAULT TEAM',
        roles: [
          { name: 'Breacher', priority: 2, commander: false },
          { name: 'Rifleman', priority: 1, commander: false },
        ] },
      { id: 'overwatch', parent: 'root', tier: 2, name: 'OVERWATCH',
        roles: [
          { name: 'Spotter', priority: 2, commander: false },
        ] },
    ],
    freqs: [
      { name: 'COMMAND NET', authorized: ['OPERATION ALPHA › Team Lead', 'ASSAULT TEAM › Breacher', 'OVERWATCH › Spotter'] },
      { name: 'ASSAULT NET', authorized: ['ASSAULT TEAM › Breacher', 'ASSAULT TEAM › Rifleman'] },
    ],
  },
  starcitizen: {
    nodes: [
      { id: 'root', parent: null, tier: 1, name: 'IDRIS WING',
        roles: [
          { name: 'Wing Commander', priority: 5, commander: true },
          { name: 'XO', priority: 3, commander: false },
        ] },
      { id: 'bridge', parent: 'root', tier: 2, name: 'BRIDGE CREW',
        roles: [
          { name: 'Pilot', priority: 3, commander: false },
          { name: 'Turret Gunner', priority: 1, commander: false },
        ] },
      { id: 'boarding', parent: 'root', tier: 2, name: 'BOARDING PARTY',
        roles: [
          { name: 'FTL Breacher', priority: 2, commander: false },
        ] },
    ],
    freqs: [
      { name: 'FLEET COMMAND', authorized: ['IDRIS WING › Wing Commander', 'BRIDGE CREW › Pilot'] },
      { name: 'BOARDING NET', authorized: ['BOARDING PARTY › FTL Breacher', 'IDRIS WING › XO'] },
    ],
  },
};

// Pricing is tentative and not shown on the homepage yet — see
// docs/PRICING_MODEL_2026_05_28.md and services/identity-node/src/utils/orgTiers.ts
// for the current figures when it's time to re-add a pricing section.

const ONBOARDING_CARDS = [
  {
    id: '01', color: 'text-specter-primary-cyan', border: 'rgba(6,182,212,0.4)',
    title: 'Create Account',
    body: 'Sign up at spectercoms.net — no download required. Create your callsign, verify your email, and you\'re on the Discover page ready to find a server.',
    cta: 'enter',
  },
  {
    id: '02', color: 'text-specter-primary-neon', border: 'rgba(163,230,53,0.4)',
    title: 'Join a Server',
    body: 'Browse public servers in Discover, or accept an invite link from your group. Once inside you can view channels, members, and scheduled operations from your browser.',
  },
  {
    id: '03', color: 'text-amber-400', border: 'rgba(245,158,11,0.4)',
    title: 'Download App',
    body: 'Install the desktop client for voice, in-game overlay, and operations tooling. The installer requests only what it needs — nothing is collected silently.',
    permissions: true,
    cta: 'download',
  },
];

const FEATURES = [
  {
    id: '01', color: 'text-specter-primary-neon', border: 'rgba(163,230,53,0.4)',
    title: 'Follow the Action',
    body: "Picture-in-picture screensharing lets you watch a teammate's view without leaving your game. Follow your squad lead's calls in real time — no alt-tabbing, no guessing.",
  },
  {
    id: '02', color: 'text-specter-state-error', border: 'rgba(239,68,68,0.4)',
    title: 'Leaders Cut Through',
    body: "Command channel priority means when your leader speaks, everyone hears it. Background chatter steps aside automatically — critical calls land clean, every time.",
  },
  {
    id: '03', color: 'text-specter-state-success', border: 'rgba(34,197,94,0.4)',
    title: 'Plan Across Time Zones',
    body: "Operations and briefings display in each member's local time automatically. Your global team shows up together — no confusion, no missed briefs.",
  },
  {
    id: '04', color: 'text-specter-primary-cyan', border: 'rgba(6,182,212,0.4)',
    title: 'Your Data Stays Yours',
    body: "We don't track your activity, train on your voice, or sell your habits. You're a customer, not the product — abuse reports still get handled.",
  },
];

function detectPlatform() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  return 'linux';
}

const LandingPage = ({ onEnter }) => {
  const [downloadError, setDownloadError] = useState('');

  // ── Overlay mockup interactivity: drag, rescale, passthrough toggle ──────
  // Mirrors GameOverlayWindow.jsx's own scale-cycle button and passthrough
  // hotkey so visitors can feel how the real HUD behaves, not just read about it.
  const overlayFrameRef = useRef(null);
  const overlayDragRef = useRef(null);
  const [overlayPos, setOverlayPos] = useState({ left: OVERLAY_BASE_LEFT, top: OVERLAY_BASE_TOP });
  const [overlayScale, setOverlayScale] = useState(1);
  const [overlayPassthrough, setOverlayPassthrough] = useState(true);
  const [overlayInteracted, setOverlayInteracted] = useState(false);
  const [overlayPickerOpen, setOverlayPickerOpen] = useState(false);
  const [overlayWatching, setOverlayWatching] = useState('MACADEN');
  const [overlayFrameWidth, setOverlayFrameWidth] = useState(960);

  // Track the frame's actual rendered width so the pill's transform: scale()
  // can convert "384px against a 2560px desktop" into the right on-page size,
  // whatever width the marketing section happens to render at.
  useEffect(() => {
    const el = overlayFrameRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setOverlayFrameWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fraction of frame width/height the pill occupies at its real 384px size
  // and 1x scale — independent of overlayFrameWidth, since both the pill and
  // the "screen" it sits on shrink together (see comment near the constants).
  const overlayWidthPct = (OVERLAY_REAL_W / REFERENCE_SCREEN_W) * 100;
  const overlayGameScale = overlayFrameWidth / REFERENCE_SCREEN_W;

  const handleOverlayPointerDown = (e) => {
    const frame = overlayFrameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    overlayDragRef.current = {
      startX: e.clientX, startY: e.clientY,
      startLeft: overlayPos.left, startTop: overlayPos.top,
      rectW: rect.width, rectH: rect.height,
    };
    setOverlayInteracted(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const handleOverlayPointerMove = (e) => {
    const ds = overlayDragRef.current;
    if (!ds) return;
    const dxPct = ((e.clientX - ds.startX) / ds.rectW) * 100;
    const dyPct = ((e.clientY - ds.startY) / ds.rectH) * 100;
    const pillWidthPct = overlayWidthPct * overlayScale;
    const maxLeft = Math.max(100 - pillWidthPct, 0);
    setOverlayPos({
      left: Math.min(Math.max(ds.startLeft + dxPct, 0), maxLeft),
      top: Math.min(Math.max(ds.startTop + dyPct, 0), 85),
    });
  };
  const handleOverlayPointerUp = () => { overlayDragRef.current = null; };

  const cycleOverlayScale = (e) => {
    e.stopPropagation();
    setOverlayInteracted(true);
    setOverlayScale((prev) => OVERLAY_SCALE_STEPS[(OVERLAY_SCALE_STEPS.indexOf(prev) + 1) % OVERLAY_SCALE_STEPS.length]);
  };

  const toggleOverlayPassthrough = () => {
    setOverlayInteracted(true);
    setOverlayPickerOpen(false);
    setOverlayPassthrough((v) => !v);
  };

  const selectOverlayStream = (id) => {
    setOverlayInteracted(true);
    setOverlayWatching(id);
    setOverlayPickerOpen(false);
  };

  // ── Frequency demo: which channel is currently the active TX target ──────
  const [activeFreqIdx, setActiveFreqIdx] = useState(0);
  const [freqInteracted, setFreqInteracted] = useState(false);
  const selectFreq = (i) => {
    setFreqInteracted(true);
    setActiveFreqIdx(i);
  };

  // ── Group builder demo: tree + selected node + editable priority/commander ──
  const [groupPreset, setGroupPreset] = useState('general');
  const [groupTree, setGroupTree] = useState(() => JSON.parse(JSON.stringify(GROUP_BUILDER_DATA.general.nodes)));
  const [selectedNodeId, setSelectedNodeId] = useState('root');
  const [groupInteracted, setGroupInteracted] = useState(false);

  const switchGroupPreset = (preset) => {
    setGroupPreset(preset);
    setGroupTree(JSON.parse(JSON.stringify(GROUP_BUILDER_DATA[preset].nodes)));
    setSelectedNodeId(GROUP_BUILDER_DATA[preset].nodes[0].id);
    setGroupInteracted(false);
  };
  const selectGroupNode = (id) => { setGroupInteracted(true); setSelectedNodeId(id); };
  const setRolePriority = (roleIdx, priority) => {
    setGroupInteracted(true);
    setGroupTree((prev) => prev.map((n) => n.id !== selectedNodeId ? n : {
      ...n, roles: n.roles.map((r, i) => i === roleIdx ? { ...r, priority } : r),
    }));
  };
  const toggleCommander = (roleIdx) => {
    setGroupInteracted(true);
    setGroupTree((prev) => prev.map((n) => n.id !== selectedNodeId ? n : {
      ...n, roles: n.roles.map((r, i) => ({ ...r, commander: i === roleIdx ? !r.commander : false })),
    }));
  };
  const selectedGroupNode = groupTree.find((n) => n.id === selectedNodeId) || groupTree[0];
  const groupFreqs = GROUP_BUILDER_DATA[groupPreset].freqs;

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
  return (
    <div className="min-h-screen bg-specter-bg-deep text-specter-text-main flex flex-col font-mono relative overflow-x-hidden bg-grid-pattern bg-[size:40px_40px]">
      {/* Background glow effects */}
      <div className="absolute top-[-20%] left-[-10%] w-1/2 h-1/2 bg-specter-primary-cyan/10 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-1/2 h-1/2 bg-specter-primary-neon/5 blur-[120px] rounded-full pointer-events-none" />

      {/* Header */}
      <header className="w-full flex justify-between items-center p-6 sm:p-10 relative z-10">
        <div className="flex items-center gap-4">
            <img
              src="/SpecterComsLogo.png?v=20260703a"
              alt="SpecterComs"
              className="h-10 w-auto drop-shadow-[0_0_8px_rgba(6,182,212,0.5)]"
            />
            <div className="hidden sm:block text-specter-text-muted text-xs tracking-widest pt-1 border-l border-specter-primary-dim pl-4">SECURE COMMS</div>
        </div>
        <div>
          <button
            onClick={onEnter}
            className="px-6 py-2 border border-specter-primary-cyan text-specter-primary-cyan hover:bg-specter-primary-cyan hover:text-black transition-colors uppercase tracking-widest text-sm font-bold shadow-[0_0_10px_rgba(6,182,212,0.2)]"
          >
            Login / Create Account
          </button>
        </div>
      </header>

      {/* Main Hero */}
      <main className="flex-1 flex flex-col items-center justify-center p-6 text-center z-10 max-w-5xl mx-auto space-y-10">

        <div className="space-y-6">
            <div className="flex justify-center -mt-[120px] -mb-[64px] sm:-mb-[80px]">
                <img
                  src="/SpecterComsBanner.png?v=20260801b"
                  alt="SpecterComs — Built to Connect. Engineered to Perform."
                  className="h-[320px] sm:h-[416px] w-auto drop-shadow-[0_0_30px_rgba(6,182,212,0.5)]"
                />
            </div>
        </div>

        {/* Buttons (left) + description (right) on wide screens; stacked, text-first, on mobile */}
        <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6 sm:gap-10 w-full max-w-4xl mx-auto">
          <div className="order-2 sm:order-1 flex flex-col gap-3 w-full sm:w-60 flex-shrink-0">
            <button
              onClick={onEnter}
              className="w-full px-8 py-3 bg-specter-primary-cyan text-black hover:bg-white transition-all uppercase tracking-widest text-sm font-bold shadow-[0_0_20px_rgba(6,182,212,0.4)]"
            >
              Create Account / Sign In
            </button>
            <button
              onClick={handleDownload}
              className="w-full px-8 py-3 border border-specter-primary-dim text-specter-text-muted hover:text-white hover:border-specter-primary-cyan transition-colors uppercase tracking-widest text-sm font-bold flex justify-center items-center gap-2"
            >
              Already Joined? Download Client
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            </button>
            {downloadError && <p className="text-specter-state-error text-xs font-mono">{downloadError}</p>}
          </div>
          <p className="order-1 sm:order-2 flex-1 text-base sm:text-lg text-specter-text-muted leading-relaxed text-center sm:text-left">
            SpecterComs is built to keep large in-game teams organized — command priority, an in-game overlay, and scheduled operations in one client. Create your account, discover servers, and join your team. Once you're in a server, install the desktop client for voice, overlay, and operations tooling.
          </p>
        </div>

        {/* Onboarding step cards — accordion style matching the feature section */}
        <style>{`
          .onboard-row { display: flex; gap: 6px; height: 300px; width: 100%; }
          .onboard-item { position: relative; flex: 1; overflow: hidden; cursor: default; transition: flex 0.5s cubic-bezier(0.4,0.2,0.2,1); border: 1px solid rgba(63,63,70,0.7); background: rgba(0,0,0,0.5); }
          .onboard-item:hover { flex: 3.5; }
          .onboard-tab { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; writing-mode: vertical-rl; transform: rotate(180deg); letter-spacing: 0.25em; font-size: 11px; font-weight: bold; text-transform: uppercase; transition: opacity 0.25s; white-space: nowrap; }
          .onboard-item:hover .onboard-tab { opacity: 0; }
          .onboard-detail { position: absolute; inset: 0; padding: 18px; display: flex; flex-direction: column; justify-content: flex-start; opacity: 0; transform: translateX(10px); transition: opacity 0.35s ease 0.08s, transform 0.35s ease 0.08s; overflow-y: auto; }
          .onboard-item:hover .onboard-detail { opacity: 1; transform: translateX(0); }
        `}</style>
        <div className="onboard-row w-full text-left">
          {ONBOARDING_CARDS.map((c) => (
            <div key={c.id} className="onboard-item" style={{ borderColor: c.border }}>
              <div className={`onboard-tab ${c.color}`}>{c.id} // {c.title}</div>
              <div className="onboard-detail">
                <div className={`${c.color} font-bold text-sm tracking-widest uppercase mb-2`}>{c.title}</div>
                <p className="text-xs text-zinc-300 leading-relaxed mb-3">{c.body}</p>
                {c.permissions && (
                  <ul className="text-[11px] text-zinc-400 leading-5 list-disc pl-4 space-y-0.5 mb-3">
                    <li>Microphone for voice</li>
                    <li>Screen capture when sharing</li>
                    <li>Global hotkeys (PTT &amp; overlay)</li>
                    <li>Overlay window (always-on-top, click-through)</li>
                    <li>Network for auth, voice &amp; signed updates</li>
                  </ul>
                )}
                {c.cta === 'enter' && (
                  <button onClick={onEnter} className={`mt-auto self-start text-[11px] px-3 py-1.5 border font-bold uppercase tracking-widest transition-colors hover:bg-white/5 ${c.color}`} style={{ borderColor: c.border }}>
                    Create Account / Sign In
                  </button>
                )}
                {c.cta === 'download' && (
                  <button onClick={handleDownload} className={`mt-auto self-start text-[11px] px-3 py-1.5 border font-bold uppercase tracking-widest transition-colors hover:bg-white/5 ${c.color}`} style={{ borderColor: c.border }}>
                    Download Client
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Overlay Showcase — mockup built to match the real in-game HUD pixel-for-pixel
            (see GameOverlayWindow.jsx) since the overlay can't be screenshotted from
            inside a live game session for marketing use. Intro copy was dropped —
            the interactive demo (drag/resize/passthrough + pinned callouts) explains
            itself better than a static paragraph did. */}

        {/* Full-bleed demo stage — breaks out of the max-w-5xl column so the backdrop
            reads as a real fullscreen game window rather than a small boxed screenshot.
            `main` already centers its children (items-center), so a plain w-screen
            child is enough — no extra left/transform offset, which double-centers
            and pushes the frame off-screen on one side. */}
        <div className="relative w-screen">
        <div className="mx-auto px-4 sm:px-10" style={{ maxWidth: 'min(1700px, calc((93.5vh - 56px) * 16 / 9))' }}>

          <style>{`
            @keyframes overlay-drag-hint {
              0%, 100% { box-shadow: inset 0 1px 0 rgba(34,211,238,0.06), 0 0 0 1px rgba(34,211,238,0.16), 0 0 18px rgba(34,211,238,0.22); }
              50% { box-shadow: inset 0 1px 0 rgba(34,211,238,0.1), 0 0 0 1.5px rgba(34,211,238,0.5), 0 0 24px rgba(34,211,238,0.5); }
            }
            .overlay-drag-hint { animation: overlay-drag-hint 1.8s ease-in-out infinite; cursor: grab; }
            .overlay-drag-hint:active { cursor: grabbing; }
            @keyframes overlay-toggle-hint {
              0%, 100% { box-shadow: 0 0 0 0 rgba(245,158,11,0.35); }
              50% { box-shadow: 0 0 0 5px rgba(245,158,11,0); }
            }
            button.overlay-drag-hint { animation: overlay-toggle-hint 1.8s ease-in-out infinite; cursor: pointer; }
            @keyframes overlay-demo-glow {
              0%, 100% { box-shadow: 0 0 22px 4px rgba(250,204,21,0.55); }
              50% { box-shadow: 0 0 34px 8px rgba(250,204,21,0.85); }
            }
            .overlay-demo-glow { animation: overlay-demo-glow 1.6s ease-in-out infinite; }
          `}</style>

          {/* Passthrough toggle — sits above the mock "gameplay" frame. ON means clicks
              pass straight through to the game underneath, same as the real hotkey, so
              the pill below is fully inert (pointer-events: none) until you switch it OFF. */}
          <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
            <div className="text-[10px] uppercase tracking-widest text-zinc-500">
              {overlayPassthrough ? 'Turn passthrough off to interact with the overlay' : 'Drag header to move · click % to resize · click channel to switch stream'}
            </div>
            <button
              onClick={toggleOverlayPassthrough}
              className={`flex items-center gap-2 px-3 py-1.5 rounded border text-[11px] uppercase tracking-widest font-bold transition-colors ${overlayPassthrough && !overlayInteracted ? 'overlay-drag-hint' : ''}`}
              style={{
                color: overlayPassthrough ? '#f59e0b' : '#64748b',
                borderColor: overlayPassthrough ? 'rgba(245,158,11,0.5)' : 'rgba(100,116,139,0.4)',
                background: overlayPassthrough ? 'rgba(245,158,11,0.08)' : 'transparent',
              }}
            >
              <span style={{
                width: 7, height: 7, borderRadius: 999, flexShrink: 0,
                background: overlayPassthrough ? '#f59e0b' : '#334155',
                boxShadow: overlayPassthrough ? '0 0 6px #f59e0b' : 'none',
              }} />
              Passthrough {overlayPassthrough ? 'ON' : 'OFF'}
            </button>
          </div>

          <div
            ref={overlayFrameRef}
            className="relative w-full rounded-xl overflow-hidden border border-zinc-800"
            style={{
              aspectRatio: '16/9',
              backgroundImage: "url('/marketing/overlay-demo-bg.jpg')",
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }}
          >
            {/* Vignette so the overlay pill stays legible over the gameplay backdrop */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ background: 'linear-gradient(120deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.05) 45%, transparent 65%)' }}
            />
            <div
              className="absolute bottom-0 left-0 right-0 h-1/3 pointer-events-none"
              style={{ background: 'linear-gradient(0deg, rgba(0,0,0,0.6), transparent)' }}
            />

            {/* Overlay mockup — colors/layout mirror GameOverlayWindow.jsx exactly:
                #030a13 pill background, cyan glow border, header with channel name +
                speaker chip + passthrough badge, 16:9 stream preview beneath. */}
            <div
              className="absolute select-none"
              style={{
                left: `${overlayPos.left}%`, top: `${overlayPos.top}%`,
                // Rendered at its true 384px size, then scaled down by how much the
                // frame itself is scaled down from an assumed 2560px-wide desktop —
                // times the user's own 75–150% overlay scale on top of that.
                width: OVERLAY_REAL_W, zIndex: 2,
                transform: `scale(${overlayGameScale * overlayScale})`, transformOrigin: 'top left',
                // Passthrough ON = clicks fall straight through to the "game" behind it,
                // exactly like the real overlay's click-through mode — so nothing here
                // (drag, resize, stream picker) is reachable until it's switched OFF.
                pointerEvents: overlayPassthrough ? 'none' : 'auto',
                opacity: overlayPassthrough ? 0.94 : 1,
                filter: overlayPassthrough ? 'saturate(0.85)' : 'none',
                transition: 'opacity 0.25s, filter 0.25s',
              }}
            >
              <div
                // Demo-only visibility aid — not part of the real overlay's look,
                // it's just here so the pill pops against a busy screenshot until
                // a visitor starts interacting with it.
                className={`font-mono ${!overlayInteracted ? 'overlay-demo-glow' : ''}`}
                style={{ borderRadius: 6, background: '#030a13', transition: 'box-shadow 0.4s' }}
              >
              <div
                onPointerDown={handleOverlayPointerDown}
                onPointerMove={handleOverlayPointerMove}
                onPointerUp={handleOverlayPointerUp}
                onPointerCancel={handleOverlayPointerUp}
                className={!overlayPassthrough && !overlayInteracted ? 'overlay-drag-hint' : ''}
                style={{
                  display: 'flex', alignItems: 'center', height: OVERLAY_REAL_HEADER_H, padding: '0 10px', gap: 6,
                  background: '#030a13',
                  border: '1px solid rgba(56,189,248,0.35)',
                  borderRadius: (overlayPickerOpen || overlayWatching) ? '6px 6px 0 0' : 6,
                  cursor: 'grab', touchAction: 'none',
                }}
              >
                <span style={{ color: '#0e7490', fontSize: 10 }}>◈</span>
                <button
                  onClick={() => setOverlayPickerOpen((v) => !v)}
                  onPointerDown={(e) => e.stopPropagation()}
                  style={{
                    background: 'transparent', border: 'none', color: '#22d3ee', fontSize: 12,
                    letterSpacing: '0.06em', flex: 1, whiteSpace: 'nowrap', textAlign: 'left',
                    cursor: 'pointer', padding: 0, fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 4,
                  }}
                >
                  ALPHA SQUAD
                  <span style={{ color: '#475569', fontSize: 9 }}>{overlayPickerOpen ? '▲' : '▼'}</span>
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '2px 9px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 20, flexShrink: 0 }}>
                  <span style={{ fontSize: 8, color: '#22c55e' }}>◉</span>
                  <span style={{ fontSize: 10, color: '#22c55e', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>CMDR_NORDMEAT</span>
                </div>
                {overlayPassthrough && (
                  <span style={{
                    fontSize: 8, color: '#f59e0b', flexShrink: 0, padding: '1px 5px',
                    border: '1px solid rgba(245,158,11,0.4)', borderRadius: 3, background: 'rgba(245,158,11,0.08)',
                    letterSpacing: '0.08em',
                  }}>PASS</span>
                )}
                <button
                  onClick={cycleOverlayScale}
                  onPointerDown={(e) => e.stopPropagation()}
                  style={{
                    background: 'transparent', border: '1px solid transparent', color: '#475569', fontSize: 9,
                    cursor: 'pointer', padding: '2px 4px', borderRadius: 4, flexShrink: 0, letterSpacing: '0.04em',
                    fontFamily: 'monospace',
                  }}
                  title="Click to resize"
                >
                  {Math.round(overlayScale * 100)}%
                </button>
                <span style={{ color: '#475569', fontSize: 13, flexShrink: 0 }}>✕</span>
              </div>

              {/* Stream picker popup — only reachable with passthrough off */}
              {overlayPickerOpen && (
                <div
                  onPointerDown={(e) => e.stopPropagation()}
                  style={{
                    background: '#030a13', border: '1px solid rgba(56,189,248,0.35)', borderTop: 'none',
                    borderRadius: overlayWatching ? 0 : '0 0 6px 6px', padding: '6px 4px',
                  }}
                >
                  {OVERLAY_STREAM_OPTIONS.map((opt) => (
                    <div
                      key={opt.label}
                      onClick={() => selectOverlayStream(opt.id)}
                      style={{
                        padding: '4px 10px', cursor: 'pointer', fontSize: 10, letterSpacing: '0.06em',
                        borderRadius: 3, display: 'flex', alignItems: 'center', gap: 5,
                        color: overlayWatching === opt.id ? '#22d3ee' : '#94a3b8',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(8,145,178,0.1)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <span style={{ color: overlayWatching === opt.id ? '#22d3ee' : 'transparent', fontSize: 8 }}>▶</span>
                      {opt.label}
                    </div>
                  ))}
                </div>
              )}
              {overlayWatching && (() => {
                const active = OVERLAY_STREAM_OPTIONS.find((o) => o.id === overlayWatching);
                if (!active) return null;
                return (
                  <div
                    style={{
                      position: 'relative', width: '100%', aspectRatio: '16/9',
                      border: '1px solid rgba(56,189,248,0.35)', borderTop: 'none',
                      borderRadius: '0 0 6px 6px', overflow: 'hidden',
                    }}
                  >
                    {/* Deliberately a different screenshot than the backdrop — this pane
                        represents a teammate's feed, a distinct view from your own. */}
                    <div
                      style={{
                        position: 'absolute', inset: 0,
                        backgroundImage: `url('${active.img}')`,
                        backgroundSize: 'cover',
                        backgroundPosition: active.pos,
                        filter: 'saturate(0.85) brightness(0.9)',
                      }}
                    />
                    {/* Faint blue receive-tint distinguishes "teammate's feed" from the sharp backdrop behind it */}
                    <div style={{ position: 'absolute', inset: 0, background: 'rgba(8,40,60,0.18)' }} />
                    <div style={{ position: 'absolute', top: 4, left: 6, fontSize: 8, color: 'rgba(226,232,240,0.65)', letterSpacing: '0.1em', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
                      {active.label}
                    </div>
                    <span
                      onClick={() => selectOverlayStream(null)}
                      style={{
                        position: 'absolute', bottom: 6, right: 6, fontSize: 8, color: '#ef4444',
                        background: 'rgba(0,0,0,0.65)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: 3,
                        padding: '2px 6px', letterSpacing: '0.1em', cursor: 'pointer',
                      }}
                    >
                      ✕ STOP
                    </span>
                  </div>
                );
              })()}
              </div>
            </div>

            {/* Annotation callouts — SVG viewBox (0-100 x, 0-56.25 y) maps 1:1 onto the
                16:9 frame's percentage width/height, so line endpoints line up with the
                percentage-positioned pill above without any px math. Lines use
                non-scaling-stroke at a real 2.5px so they stay clearly visible no
                matter how wide the full-bleed frame renders. */}
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none"
              viewBox="0 0 100 56.25" preserveAspectRatio="none"
              style={{ zIndex: 3, opacity: overlayInteracted ? 0 : 1, transition: 'opacity 0.4s' }}
            >
              {[
                { x1: 27, y1: 15, x2: 50.5, y2: 28.125 }, // WHO'S TALKING → speaker chip
                { x1: 27, y1: 24, x2: 45,   y2: 28.125 }, // CHANNEL/FREQUENCY → channel button
                { x1: 27, y1: 33, x2: 42.5, y2: 32.97 },  // PICTURE-IN-PICTURE → preview panel
                { x1: 73, y1: 15, x2: 55,   y2: 28.125 }, // PASSTHROUGH → PASS badge
                { x1: 73, y1: 24, x2: 56,   y2: 28.125 }, // SCALES TO YOUR SETUP → % resize button
              ].map((l, i) => (
                <g key={i} style={{ filter: 'drop-shadow(0 0 3px rgba(34,211,238,0.85))' }}>
                  <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="#67e8f9" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
                  <circle cx={l.x2} cy={l.y2} r="1" fill="#0a1520" stroke="#67e8f9" strokeWidth="0.4" />
                </g>
              ))}
            </svg>
            <div
              className="absolute inset-0"
              style={{ zIndex: 3, opacity: overlayInteracted ? 0 : 1, transition: 'opacity 0.4s', pointerEvents: 'none' }}
            >
              {[
                { left: '3%',  top: '26.7%', label: 'WHO’S TALKING',       body: 'Live speaker indicator' },
                { left: '3%',  top: '42.7%', label: 'CHANNEL / FREQUENCY', body: 'Which voice line you’re on' },
                { left: '3%',  top: '58.7%', label: 'PICTURE-IN-PICTURE',  body: 'A teammate’s stream, no tabbing out' },
                { left: '74%', top: '26.7%', label: 'PASSTHROUGH',         body: 'Hotkey — clicks pass straight to your game' },
                { left: '74%', top: '42.7%', label: 'SCALES TO YOUR SETUP', body: 'Click % to cycle 75–150%, true to scale' },
              ].map((c, i) => (
                <div
                  key={i}
                  className="absolute rounded"
                  style={{
                    left: c.left, top: c.top, width: '23%', transform: 'translateY(-50%)',
                    background: 'rgba(3,10,19,0.88)', border: '1px solid rgba(103,232,249,0.5)',
                    padding: '6px 9px', boxShadow: '0 0 12px rgba(0,0,0,0.5)',
                  }}
                >
                  <div className="text-[12px] font-bold uppercase tracking-widest text-cyan-200 leading-tight">{c.label}</div>
                  <div className="text-[11px] text-white leading-tight mt-1">{c.body}</div>
                </div>
              ))}
            </div>

            <div className="absolute bottom-3 left-3 text-[10px] uppercase tracking-widest text-zinc-600" style={{ zIndex: 3 }}>
              Mockup — the overlay renders live over your game, not as a picture-in-picture window. Yellow glow is a demo aid only, not part of the real overlay.
            </div>
          </div>
        </div>
        </div>

        {/* Feature accordion — collapsed items show as vertical side tabs; hovering
            expands that tab and fades in its detail copy while the others shrink back. */}
        <style>{`
          .accordion-row { display: flex; gap: 6px; height: 260px; }
          .accordion-item {
            position: relative; flex: 1; overflow: hidden; cursor: default;
            transition: flex 0.5s cubic-bezier(0.4, 0.2, 0.2, 1);
            border: 1px solid rgba(63,63,70,0.7);
          }
          .accordion-item:hover { flex: 3.2; }
          .accordion-tab-label {
            position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
            writing-mode: vertical-rl; transform: rotate(180deg);
            letter-spacing: 0.25em; font-size: 11px; font-weight: bold; text-transform: uppercase;
            transition: opacity 0.25s;
            white-space: nowrap;
          }
          .accordion-item:hover .accordion-tab-label { opacity: 0; }
          .accordion-detail {
            position: absolute; inset: 0; padding: 20px; display: flex; flex-direction: column; justify-content: center;
            opacity: 0; transform: translateX(10px);
            transition: opacity 0.35s ease 0.08s, transform 0.35s ease 0.08s;
          }
          .accordion-item:hover .accordion-detail { opacity: 1; transform: translateX(0); }
        `}</style>
        <div className="accordion-row mt-16 w-full text-left">
            {FEATURES.map((f) => (
              <div key={f.id} className="accordion-item bg-black/50 backdrop-blur-sm" style={{ borderColor: f.border }}>
                <div className={`accordion-tab-label ${f.color}`}>{f.id} // {f.title}</div>
                <div className="accordion-detail">
                  <div className={`${f.color} font-bold text-lg tracking-widest uppercase mb-2`}>{f.title}</div>
                  <p className="text-sm text-zinc-300 leading-relaxed">{f.body}</p>
                </div>
              </div>
            ))}
        </div>

        {/* Frequencies — same treatment as the overlay demo: a live interactive
            widget with pinned tooltip callouts that teach the mechanic, then fade
            once you've clicked something yourself. */}
        <div className="w-full max-w-5xl mt-20">
          <style>{`
            @keyframes freq-tip-hint {
              0%, 100% { opacity: 1; }
              50% { opacity: 0.5; }
            }
            .freq-tip { animation: freq-tip-hint 2s ease-in-out infinite; }
          `}</style>
          <div className="text-specter-primary-cyan text-xs uppercase tracking-widest mb-2 text-center">Core Feature</div>
          <h2 className="text-2xl sm:text-3xl font-bold text-white uppercase tracking-widest mb-8 text-center">
            Frequencies
          </h2>

          <div className="rounded-xl border border-zinc-800 bg-black/50 backdrop-blur-sm p-6 sm:p-10">
            <div className="flex flex-wrap justify-center gap-x-10 gap-y-16">
              {FREQ_CHANNELS.map((ch, i) => {
                const isActive = activeFreqIdx === i;
                const tip = freqInteracted ? null : (
                  i === 0 ? { label: 'PRIMARY · ACTIVE TX', body: "Always connected — right now it's also where you're transmitting" } :
                  i === 1 ? { label: 'FREQUENCY', body: 'Extra channel your role grants for this operation' } :
                  i === 2 ? { label: 'PASSIVE MONITOR', body: "You still hear this, just quieter, until you switch to it" } :
                  null
                );
                return (
                  <div key={ch.id} className="relative">
                    {tip && (
                      <div
                        className="freq-tip absolute left-1/2"
                        style={{
                          bottom: '100%', transform: 'translateX(-50%)', marginBottom: 16, width: 190,
                          background: 'rgba(3,10,19,0.92)', border: '1px solid rgba(103,232,249,0.5)',
                          borderRadius: 6, padding: '7px 10px', boxShadow: '0 0 12px rgba(0,0,0,0.5)',
                        }}
                      >
                        <div className="text-[10px] font-bold uppercase tracking-widest text-cyan-300 leading-tight">{tip.label}</div>
                        <div className="text-[9px] text-zinc-300 leading-tight mt-1">{tip.body}</div>
                        <div style={{
                          position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
                          width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
                          borderTop: '6px solid rgba(103,232,249,0.5)',
                        }} />
                      </div>
                    )}
                    <button
                      onClick={() => selectFreq(i)}
                      className="flex flex-col items-center gap-2 px-5 py-4 rounded-lg border transition-all"
                      style={{
                        minWidth: 150, cursor: 'pointer',
                        background: isActive ? 'rgba(34,197,94,0.08)' : 'rgba(8,20,33,0.6)',
                        borderColor: isActive ? 'rgba(34,197,94,0.5)' : 'rgba(56,189,248,0.25)',
                      }}
                    >
                      <span style={{ fontSize: 9, letterSpacing: '0.2em', color: ch.kind === 'primary' ? '#0e7490' : '#475569' }}>
                        {ch.kind === 'primary' ? 'PRIMARY CHANNEL' : 'FREQUENCY'}
                      </span>
                      <span style={{ fontSize: 14, fontWeight: 'bold', letterSpacing: '0.08em', color: isActive ? '#4ade80' : '#94a3b8' }}>
                        {ch.label}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span style={{
                          width: 6, height: 6, borderRadius: 999,
                          background: isActive ? '#22c55e' : '#0e7490',
                          boxShadow: isActive ? '0 0 6px #22c55e' : 'none',
                        }} />
                        <span style={{ fontSize: 9, letterSpacing: '0.15em', color: isActive ? '#22c55e' : '#0e7490' }}>
                          {isActive ? 'ACTIVE TX' : 'MONITORING'}
                        </span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="text-center text-[10px] uppercase tracking-widest text-zinc-500 mt-10">
              Click any frequency to switch who you're transmitting to — everything else keeps playing, just quieter
            </div>
          </div>
        </div>

        {/* Group Builder — simplified mirror of OperationPlanner.jsx's real
            GroupPlanner: a nested group tree, per-role ducking priority (1-5,
            server-enforced in media-rust's mixer — priority speech drops
            everyone else ~-20dB and cascades to descendant channels) plus an
            exclusive Operation Commander flag, and liaison frequencies each
            authorized for specific group/role combos. Two tabs show the same
            mechanic in a generic team and a Star Citizen fleet. */}
        <div className="w-full max-w-5xl mt-20">
          <div className="text-center mb-6">
            <div className="text-zinc-500 text-xs tracking-widest uppercase mb-1.5">
              Keep Large Groups <span className="text-specter-primary-cyan">Organized</span>
            </div>
            <h2 className="text-xl sm:text-2xl font-bold text-white uppercase tracking-widest">
              Group Builder
            </h2>
          </div>

          <div className="flex justify-center gap-2 mb-8">
            {[
              { id: 'general', label: 'General Usage' },
              { id: 'starcitizen', label: 'Star Citizen' },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => switchGroupPreset(t.id)}
                className="px-4 py-1.5 rounded border text-xs uppercase tracking-widest font-bold transition-colors"
                style={{
                  color: groupPreset === t.id ? '#22d3ee' : '#64748b',
                  borderColor: groupPreset === t.id ? 'rgba(34,211,238,0.5)' : 'rgba(100,116,139,0.3)',
                  background: groupPreset === t.id ? 'rgba(34,211,238,0.08)' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-zinc-800 bg-black/50 backdrop-blur-sm p-6 sm:p-8">
            <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6">

              {/* Tree */}
              <div className="flex flex-col gap-2">
                {groupTree.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => selectGroupNode(n.id)}
                    className="text-left rounded-lg border px-3 py-2 transition-colors"
                    style={{
                      marginLeft: n.parent ? 20 : 0, cursor: 'pointer',
                      background: selectedNodeId === n.id ? 'rgba(34,211,238,0.1)' : 'rgba(8,20,33,0.5)',
                      borderColor: selectedNodeId === n.id ? 'rgba(34,211,238,0.5)' : 'rgba(56,189,248,0.2)',
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span style={{ fontSize: 8, color: '#0e7490', border: '1px solid #0e7490', borderRadius: 3, padding: '1px 4px', letterSpacing: '0.1em', flexShrink: 0 }}>
                        TIER {n.tier}
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 'bold', color: selectedNodeId === n.id ? '#22d3ee' : '#cbd5e1', letterSpacing: '0.05em' }}>
                        {n.name}
                      </span>
                    </div>
                    <div style={{ fontSize: 9, color: '#64748b', marginTop: 3, letterSpacing: '0.08em' }}>
                      {n.roles.length} ROLE{n.roles.length === 1 ? '' : 'S'}
                    </div>
                  </button>
                ))}
              </div>

              {/* Node editor — priority + commander per role */}
              <div>
                <div className="text-xs uppercase tracking-widest text-zinc-500 mb-3">
                  Editing — <span className="text-cyan-300">{selectedGroupNode.name}</span>
                </div>
                <div className="flex flex-col gap-3">
                  {selectedGroupNode.roles.map((r, i) => (
                    <div key={r.name} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-black/30 px-4 py-3 flex-wrap">
                      <div className="relative flex items-center gap-2">
                        {i === 0 && !groupInteracted && (
                          <div
                            className="freq-tip absolute left-0"
                            style={{
                              bottom: '100%', marginBottom: 14, width: 190,
                              background: 'rgba(3,10,19,0.92)', border: '1px solid rgba(255,215,0,0.5)',
                              borderRadius: 6, padding: '7px 10px', boxShadow: '0 0 12px rgba(0,0,0,0.5)',
                            }}
                          >
                            <div className="text-[10px] font-bold uppercase tracking-widest leading-tight" style={{ color: '#ffd700' }}>Operation Commander</div>
                            <div className="text-[9px] text-zinc-300 leading-tight mt-1">Exclusive — ★ moves to whichever role you click</div>
                            <div style={{
                              position: 'absolute', top: '100%', left: 14,
                              width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
                              borderTop: '6px solid rgba(255,215,0,0.5)',
                            }} />
                          </div>
                        )}
                        <button
                          onClick={() => toggleCommander(i)}
                          title="Operation Commander (exclusive)"
                          style={{ fontSize: 15, color: r.commander ? '#ffd700' : '#334155', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
                        >★</button>
                        <span style={{ fontSize: 13, color: '#e5e7eb', letterSpacing: '0.04em' }}>{r.name}</span>
                      </div>
                      <div className="relative flex items-center gap-1.5">
                        {i === 0 && !groupInteracted && (
                          <div
                            className="freq-tip absolute right-0"
                            style={{
                              bottom: '100%', marginBottom: 14, width: 200,
                              background: 'rgba(3,10,19,0.92)', border: '1px solid rgba(103,232,249,0.5)',
                              borderRadius: 6, padding: '7px 10px', boxShadow: '0 0 12px rgba(0,0,0,0.5)',
                            }}
                          >
                            <div className="text-[10px] font-bold uppercase tracking-widest text-cyan-300 leading-tight">Ducking Priority</div>
                            <div className="text-[9px] text-zinc-300 leading-tight mt-1">1–5 — higher ducks everyone else's volume when this role speaks</div>
                            <div style={{
                              position: 'absolute', top: '100%', right: 14,
                              width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
                              borderTop: '6px solid rgba(103,232,249,0.5)',
                            }} />
                          </div>
                        )}
                        {[1, 2, 3, 4, 5].map((p) => (
                          <button
                            key={p}
                            onClick={() => setRolePriority(i, p)}
                            title={PRIORITY_LABELS[p - 1]}
                            style={{
                              width: 22, height: 22, borderRadius: 4, fontSize: 10, fontWeight: 'bold', cursor: 'pointer',
                              color: r.priority === p ? '#000' : PRIORITY_COLORS[p - 1],
                              background: r.priority === p ? PRIORITY_COLORS[p - 1] : 'transparent',
                              border: `1px solid ${PRIORITY_COLORS[p - 1]}`,
                            }}
                          >
                            {p}
                          </button>
                        ))}
                        <span style={{ fontSize: 9, color: PRIORITY_COLORS[r.priority - 1], marginLeft: 4, letterSpacing: '0.08em', minWidth: 62 }}>
                          {PRIORITY_LABELS[r.priority - 1]}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Liaison frequencies — authorized roles per frequency */}
            <div className="mt-8 pt-6 border-t border-zinc-800">
              <div className="text-xs uppercase tracking-widest text-zinc-500 mb-3">Frequencies</div>
              <div className="flex flex-wrap gap-4">
                {groupFreqs.map((f, fi) => (
                  <div key={f.name} className="relative rounded-lg border border-zinc-800 bg-black/30 px-4 py-3" style={{ minWidth: 220 }}>
                    {fi === 0 && !groupInteracted && (
                      <div
                        className="freq-tip absolute left-0"
                        style={{
                          bottom: '100%', marginBottom: 14, width: 210,
                          background: 'rgba(3,10,19,0.92)', border: '1px solid rgba(103,232,249,0.5)',
                          borderRadius: 6, padding: '7px 10px', boxShadow: '0 0 12px rgba(0,0,0,0.5)',
                        }}
                      >
                        <div className="text-[10px] font-bold uppercase tracking-widest text-cyan-300 leading-tight">Frequency</div>
                        <div className="text-[9px] text-zinc-300 leading-tight mt-1">Its own channel — only the roles listed below can join it</div>
                        <div style={{
                          position: 'absolute', top: '100%', left: 14,
                          width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
                          borderTop: '6px solid rgba(103,232,249,0.5)',
                        }} />
                      </div>
                    )}
                    <div style={{ fontSize: 12, fontWeight: 'bold', color: '#22d3ee', letterSpacing: '0.08em' }}>{f.name}</div>
                    <div style={{ fontSize: 9, color: '#64748b', marginTop: 4, letterSpacing: '0.05em' }}>AUTHORIZED ROLES</div>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {f.authorized.map((a) => (
                        <span key={a} style={{ fontSize: 9, color: '#94a3b8', background: 'rgba(8,145,178,0.1)', border: '1px solid rgba(8,145,178,0.3)', borderRadius: 3, padding: '2px 6px' }}>
                          {a}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="text-center text-[10px] uppercase tracking-widest text-zinc-500 mt-8">
              Click a group to select it, ★ to set its commander, or 1–5 to set how hard a role cuts through
            </div>
          </div>
        </div>

      </main>

      <footer className="text-center p-6 text-zinc-600 text-xs border-t border-zinc-900 mt-auto z-10 relative space-y-3">
        <div className="max-w-md mx-auto space-y-1.5">
          <a
            href="https://github.com/Wr3ck4ge/SpecterComs"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-zinc-400 hover:text-specter-primary-cyan transition-colors tracking-widest uppercase text-[11px] font-bold"
          >
            <svg className="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
            github.com/Wr3ck4ge/SpecterComs
          </a>
          <p className="text-zinc-600 text-[11px] leading-relaxed">
            A public snapshot of the app's code — client, backend, and voice encryption — kept in sync with what's actually running in production. Deployment secrets, API keys, and infra config are stripped before each export.
          </p>
        </div>
        <p>&copy; 2026 SpecterComs. End-to-End Encrypted. Data-Broker Free.</p>
      </footer>
    </div>
  );
};

export default LandingPage;
