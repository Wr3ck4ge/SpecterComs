import React from 'react';
import ReactDOM from 'react-dom/client';
// Slim stylesheet, not index.css — see the note at the top of strip.css.
import './strip.css';
import StripApp from './components/strip/StripApp.jsx';

// Same reason as overlay.jsx: the shared chunk is wrapped in a top-level-await
// IIFE (vite-plugin-top-level-await), and without a TLA in this entry its
// imports could be undefined when this module runs.
await Promise.resolve();

// The strip has no visible console in release builds: forward warnings,
// errors and uncaught failures to setup_errors.log (same client_log command
// the main window's trace logging uses) so strip problems are diagnosable.
function stripLog(level, args) {
  const msg = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('client_log', { msg: `[strip] ${level}: ${msg}` }))
    .catch(() => {});
}
if (window.__TAURI_INTERNALS__) {
  for (const level of ['warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { orig(...args); stripLog(level, args); };
  }
  window.addEventListener('error', (e) => stripLog('uncaught', [e.error || e.message]));
  window.addEventListener('unhandledrejection', (e) => stripLog('unhandled rejection', [e.reason]));
}

class StripErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('[strip render crash]', error, info);
  }
  render() {
    if (this.state.error) {
      // Docked at the bottom so it lands inside the default window region.
      return (
        <div className="h-full flex flex-col justify-end p-1.5">
          <div data-strip-region className="strip-panel p-3 font-ui text-ui-sm text-red-300">
            The strip hit an error: {this.state.error?.message || String(this.state.error)}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('strip-root')).render(
  <React.StrictMode>
    <StripErrorBoundary>
      <StripApp />
    </StripErrorBoundary>
  </React.StrictMode>,
);
