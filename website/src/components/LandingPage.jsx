import React, { useState } from 'react';

// Pricing is tentative and not shown on the homepage yet — see
// docs/PRICING_MODEL_2026_05_28.md and services/identity-node/src/utils/orgTiers.ts
// for the current figures when it's time to re-add a pricing section.

const ONBOARDING_STEPS = [
  {
    id: '01',
    title: 'Create Your Account',
    body: 'Sign up in the web portal to unlock server discovery and membership management.',
  },
  {
    id: '02',
    title: 'Discover and Join a Server',
    body: 'Use the Discover tab after login to browse public servers and join the one your team uses.',
  },
  {
    id: '03',
    title: 'Download the Desktop App',
    body: 'After joining a server, install the client for voice channels, overlay, and live operations features.',
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
            <div className="flex justify-center mb-6">
                <img
                  src="/SpecterComsLogo.png?v=20260703a"
                  alt="SpecterComs"
                  className="h-56 sm:h-72 w-auto drop-shadow-[0_0_30px_rgba(6,182,212,0.5)]"
                />
            </div>
            <div className="inline-block border border-specter-state-warning/50 text-specter-state-warning bg-specter-state-warning/10 px-4 py-1 text-xs uppercase tracking-widest mb-4">
                SpecterComs // Zero-Trust Voice Network
            </div>
            <h1 className="text-4xl sm:text-6xl font-bold text-white tracking-widest uppercase">
                Take Back Your <span className="text-specter-primary-cyan drop-shadow-[0_0_15px_rgba(6,182,212,0.5)]">Comms</span>
            </h1>
            <p className="max-w-3xl mx-auto text-base sm:text-lg text-specter-text-muted leading-relaxed">
              SpecterComs starts in the web portal: create your account, discover servers, and join your team. Once you are in a server, install the desktop client for voice, overlay, and operations tooling.
            </p>
        </div>

          <div className="w-full max-w-4xl bg-black/50 border border-specter-primary-dim/30 rounded-xl p-4 sm:p-6 backdrop-blur-sm">
            <div className="text-specter-primary-cyan text-xs uppercase tracking-widest mb-4">How to Get Started</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-left">
            {ONBOARDING_STEPS.map((step) => (
              <div key={step.id} className="border border-zinc-800 bg-black/40 rounded p-4">
              <div className="text-specter-primary-neon text-xs font-bold tracking-widest mb-2">{step.id}</div>
              <div className="text-specter-text-main font-bold text-sm uppercase tracking-wide mb-2">{step.title}</div>
              <p className="text-zinc-400 text-xs leading-relaxed">{step.body}</p>
              </div>
            ))}
            </div>
          </div>

        <div className="flex flex-col sm:flex-row gap-6 w-full justify-center mt-4">
            <button
                onClick={onEnter}
                className="px-10 py-4 bg-specter-primary-cyan text-black hover:bg-white transition-all uppercase tracking-widest text-lg font-bold shadow-[0_0_20px_rgba(6,182,212,0.4)]"
            >
              Create Account / Sign In
            </button>
            <button
                    onClick={handleDownload}
                    className="px-10 py-4 border border-specter-primary-dim text-specter-text-muted hover:text-white hover:border-specter-primary-cyan transition-colors uppercase tracking-widest text-lg font-bold flex justify-center items-center gap-3"
                >
                Already Joined? Download Client
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                </button>
        </div>
          <p className="text-xs text-specter-text-muted mt-[-8px]">New users should create an account first to access Discover and join a server.</p>
        {downloadError && (
            <p className="text-specter-state-error text-sm font-mono mt-2">{downloadError}</p>
        )}

        {/* Feature Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-16 w-full text-left">
            <div className="bg-black/50 p-6 border border-zinc-800 backdrop-blur-sm">
                <div className="text-specter-primary-neon font-bold text-xl mb-3 tracking-widest uppercase">01 // Follow the Action</div>
                <p className="text-sm text-zinc-400 leading-relaxed">Picture-in-picture screensharing lets you watch a teammate's view without leaving your game. Follow your squad lead's calls in real time — no alt-tabbing, no guessing, no getting left behind.</p>
            </div>
            <div className="bg-black/50 p-6 border border-zinc-800 backdrop-blur-sm">
                <div className="text-specter-state-error font-bold text-xl mb-3 tracking-widest uppercase">02 // Leaders Cut Through</div>
                <p className="text-sm text-zinc-400 leading-relaxed">Command channel priority means when your leader speaks, everyone hears it. Background chatter automatically steps aside so critical calls land clean — every time, no exceptions.</p>
            </div>
            <div className="bg-black/50 p-6 border border-zinc-800 backdrop-blur-sm">
                <div className="text-specter-state-success font-bold text-xl mb-3 tracking-widest uppercase">03 // Plan Across Time Zones</div>
                <p className="text-sm text-zinc-400 leading-relaxed">Schedule operations and briefings that automatically display in each member's local time. Coordinate your global team without the confusion — everyone shows up, no one misses the brief.</p>
            </div>
            <div className="bg-black/50 p-6 border border-zinc-800 backdrop-blur-sm">
                <div className="text-specter-primary-cyan font-bold text-xl mb-3 tracking-widest uppercase">04 // Your Data Stays Yours</div>
                <p className="text-sm text-zinc-400 leading-relaxed">We don't track your activity, train on your voice, or sell your habits. You're a customer — not the product. We do maintain the ability to act on abuse reports, so bad actors can be handled and the platform stays clean for everyone.</p>
            </div>
        </div>

      </main>

      <footer className="text-center p-6 text-zinc-600 text-xs border-t border-zinc-900 mt-auto z-10 relative">
        &copy; 2026 SpecterComs. End-to-End Encrypted. Data-Broker Free.
      </footer>
    </div>
  );
};

export default LandingPage;
