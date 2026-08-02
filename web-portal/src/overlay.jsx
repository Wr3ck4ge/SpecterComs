import React from 'react';
import ReactDOM from 'react-dom/client';
// Intentionally NOT importing index.css here. index.css applies heavy CSS rules
// globally (backdrop-filter on many classes, text-shadow on every body element,
// Tailwind preflight) that add unnecessary GPU compositor work and can interfere
// with the overlay window's rendering. The overlay uses only inline styles.
import GameOverlayWindow from './components/GameOverlayWindow.jsx';

// CRITICAL: The shared chunk wraps all exports in a __tla async IIFE.
// Without a top-level await here the correct Promise.all([__tla]).then(...) wrapper
// is not emitted for this entry, so all imports would be undefined at execution time.
await Promise.resolve();

// overlay-ready is now emitted from GameOverlayWindow's mount useEffect after
// requestAnimationFrame, ensuring the first frame is actually painted before
// WarRoom moves the window on-screen. Emitting early (here, before React mounts)
// caused the window to slide on-screen while still showing a white blank surface.

// Error Boundary: React 18 silently unmounts the entire tree on any render crash
// when there is no ErrorBoundary, leaving a blank window with no visible indication.
// This boundary catches errors from GameOverlayWindow and renders them visibly.
class OverlayErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      const err = this.state.error;
      return React.createElement('div', {
        style: {
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: '#7f1d1d', color: '#fca5a5',
          font: '10px/1.5 monospace', padding: '6px 8px',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          zIndex: 9999, overflow: 'auto',
        },
      }, 'OVERLAY RENDER ERROR:\n' + (err.stack || err.message || String(err)));
    }
    return this.props.children;
  }
}

// Update the boot-status bar injected by overlay.html inline script
const bootEl = document.getElementById('overlay-boot-status');
if (bootEl) {
  bootEl.style.background = '#1e3a5f';
  bootEl.style.color = '#93c5fd';
  bootEl.textContent = '[overlay.jsx] Module loaded — mounting React...';
}

try {
  const rootElement = document.getElementById('overlay-root');
  if (!rootElement) {
    if (bootEl) {
      bootEl.innerHTML = '<b style="color:#f87171">FATAL: #overlay-root not found</b>';
      bootEl.style.display = 'block';
    }
  } else {
    ReactDOM.createRoot(rootElement).render(
      React.createElement(React.StrictMode, null,
        React.createElement(OverlayErrorBoundary, null,
          React.createElement(GameOverlayWindow),
        ),
      ),
    );
    // Success — hide boot status after a delay so React has time to commit its
    // first paint to the WebView2 compositor. rAF fires BEFORE React's scheduler
    // (which uses MessageChannel), so the rAF would hide the bar before React
    // has mounted any content. Use a 1500ms timeout instead.
    if (bootEl) setTimeout(() => { bootEl.style.display = 'none'; }, 1500);
  }
} catch (err) {
  if (bootEl) {
    bootEl.innerHTML = '<b style="color:#f87171">RENDER ERROR: ' + err.message + '</b><pre style="color:#fcd34d;font-size:9px;white-space:pre-wrap">' + (err.stack || '') + '</pre>';
    bootEl.style.color = '#f87171';
    bootEl.style.display = 'block';
  }
}

