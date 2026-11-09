import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

class RootErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, message: '' }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: error?.message || String(error) }
  }

  componentDidCatch(error, info) {
    console.error('[root render crash]', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-specter-bg-deep flex items-center justify-center p-6">
          <div className="max-w-xl w-full bg-specter-bg-panel border border-specter-state-error rounded p-4 text-specter-text-main font-mono">
            <div className="text-specter-state-error text-xs tracking-widest mb-2">UI BOOT FAILURE</div>
            <div className="text-xs opacity-90 break-words">{this.state.message || 'Unknown render error'}</div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 px-3 py-2 text-xs rounded border border-specter-primary-dim text-specter-primary-cyan hover:text-specter-primary-neon"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// Disable F5 / Ctrl+R / Ctrl+Shift+R hard-refresh shortcuts —
// prevents accidental Reload which kills an active voice channel without running cleanup.
document.addEventListener('keydown', e => {
  if (
    e.key === 'F5' ||
    (e.ctrlKey && (e.key === 'r' || e.key === 'R')) ||
    (e.metaKey && (e.key === 'r' || e.key === 'R'))
  ) {
    e.preventDefault();
  }
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
)
