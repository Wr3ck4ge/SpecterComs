import React, { useState, useEffect, useCallback } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import WarRoom from './components/WarRoom';

import StartupSplashScreen from './components/StartupSplashScreen';
import { invoke } from '@tauri-apps/api/core';

// ─── Tauri Update Checker ──────────────────────────────────────────────────────
let _updateCheckInProgress = false;
async function checkForUpdates() {
  if (!window.__TAURI__) return;
  if (_updateCheckInProgress) return;
  _updateCheckInProgress = true;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (update) {
      console.log(`found update ${update.version} from ${update.date} with notes ${update.body}`);
      // Broadcast via custom event — the in-app banner picks this up and shows
      // an "Install Now" button. No native dialog needed (they throw on some builds).
      window.dispatchEvent(new CustomEvent('specter:update-available', { detail: update }));
    }
  } catch (error) {
    _updateCheckInProgress = false;
    console.error('Failed to check for updates:', error);
  }
}

async function installUpdate(update) {
  try {
    const { exit } = await import('@tauri-apps/plugin-process');
    window.dispatchEvent(new CustomEvent('specter:update-progress', { detail: { status: 'downloading', pct: 0 } }));
    let downloaded = 0;
    let contentLength = 0;
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          contentLength = event.data.contentLength;
          console.log(`started downloading ${event.data.contentLength} bytes`);
          break;
        case 'Progress':
          downloaded += event.data.chunkLength;
          const pct = contentLength ? Math.round((downloaded / contentLength) * 100) : 0;
          window.dispatchEvent(new CustomEvent('specter:update-progress', { detail: { status: 'downloading', pct } }));
          console.log(`downloaded ${downloaded} from ${contentLength}`);
          break;
        case 'Finished':
          console.log('download finished — exiting for installer');
          window.dispatchEvent(new CustomEvent('specter:update-progress', { detail: { status: 'installing' } }));
          break;
      }
    });
    // Exit so the NSIS installer can overwrite the running binary.
    await exit(0);
  } catch (err) {
    console.error('Update install failed:', err);
    window.dispatchEvent(new CustomEvent('specter:update-progress', { detail: { status: 'error', message: err?.message || String(err) } }));
  }
}

// Compare semver strings: returns true if remote > local
function isNewerVersion(remote, local) {
  if (!remote || !local) return false;
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

async function checkVersionFromLogin(latestVersion) {
  if (!window.__TAURI__ || !latestVersion) return;
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    const currentVersion = await getVersion();
    console.log(`Version check: current=${currentVersion}, server=${latestVersion}`);
    if (isNewerVersion(latestVersion, currentVersion)) {
      checkForUpdates();
    }
  } catch (e) {
    console.error('Version check failed:', e);
  }
}

// ─── Design System ─────────────────────────────────────────────────────────────

const Button = ({ children, variant = 'primary', onClick, disabled, type = 'button', full = false }) => {
  const base = `${full ? 'w-full' : ''} px-6 py-2 rounded text-sm font-bold tracking-wider transition-all duration-200 uppercase font-mono`;
  const variants = {
    primary:   'bg-specter-primary-cyan text-specter-bg-surface hover:bg-specter-primary-neon hover:shadow-[0_0_15px_rgba(6,182,212,0.5)]',
    secondary: 'bg-specter-bg-panel text-specter-text-muted hover:text-specter-text-main border border-specter-bg-panel hover:border-specter-primary-dim',
    ghost:     'text-specter-primary-cyan hover:text-specter-primary-neon underline-offset-4 hover:underline',
    danger:    'bg-specter-state-error text-white hover:bg-red-600',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${variants[variant]} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      {children}
    </button>
  );
};

const Input = ({ label, id, hint, type, ...props }) => {
  const [showPw, setShowPw] = useState(false);
  const isPassword = type === 'password';
  return (
    <div className="flex flex-col gap-1">
      {label && <label htmlFor={id} className="text-xs text-specter-text-muted font-mono uppercase tracking-wider">{label}</label>}
      <div className="relative">
        <input
          id={id}
          type={isPassword ? (showPw ? 'text' : 'password') : type}
          {...props}
          className="bg-specter-bg-panel border border-specter-primary-dim rounded px-3 py-2 text-specter-text-main text-sm font-mono focus:outline-none focus:border-specter-primary-cyan transition-colors w-full"
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setShowPw((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-specter-text-muted hover:text-specter-primary-cyan transition-colors"
            tabIndex={-1}
            aria-label={showPw ? 'Hide password' : 'Show password'}
          >
            {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        )}
      </div>
      {hint && <span className="text-xs text-specter-text-muted font-mono opacity-60">{hint}</span>}
    </div>
  );
};

const Alert = ({ children, type = 'error' }) => {
  const colors = {
    error:   'bg-red-950 border-specter-state-error text-specter-state-error',
    success: 'bg-green-950 border-specter-state-success text-specter-state-success',
  };
  return (
    <div className={`border rounded px-3 py-2 text-xs font-mono ${colors[type]}`}>{children}</div>
  );
};

const Card = ({ children, className = '' }) => (
  <div className={`bg-specter-bg-panel border border-specter-primary-dim rounded-lg p-4 ${className}`}>
    {children}
  </div>
);

const isTauriRuntimeActive = () => Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__);

// ─── Auth Screen ───────────────────────────────────────────────────────────────

function AuthScreen({ onLogin }) {
  const [mode, setMode] = useState('login'); // 'login' | 'register' | 'forgot'
  const [form, setForm] = useState({ callsign: '', global_tag: '', email: '', password: '' });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const switchMode = (m) => { setMode(m); setError(null); setSuccess(null); };

  const handleForgotSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);
    const { error } = await api.forgotPassword(form.email);
    setLoading(false);
    if (error) return setError(error);
    setSuccess('If an account with that email exists, a reset link has been sent.');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);

    let hwid = 'browser-fallback-hwid';
    try {
      hwid = await invoke('get_hwid');
    } catch (err) {
      console.warn('HWID native call failed, using fallback:', err);
    }

    if (mode === 'register') {
      const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const payload = { callsign: form.callsign, email: form.email, password: form.password, hwid, timezone: userTimezone };
      if (form.global_tag) payload.global_tag = form.global_tag;

      const { data, error } = await api.register(payload);
      setLoading(false);
      if (error) {
        if (error === 'User already exists') {
          setMode('login');
          setForm((f) => ({ callsign: '', global_tag: '', email: f.email, password: '' }));
          setSuccess('An account with that callsign or email already exists. Please log in.');
          return;
        }
        return setError(error);
      }
      setSuccess(`Operator ${data.user.callsign} registered. Proceed to login.`);
      setMode('login');
      setForm({ callsign: '', global_tag: '', email: form.email, password: '' });
    } else {
      const { data, error } = await api.login({ email: form.email, password: form.password, hwid });
      setLoading(false);
      if (error) return setError(error);
      localStorage.setItem('specter_token', data.token);
      localStorage.setItem('specter_user', JSON.stringify(data.user));
      // Save credentials so the app can restore the session on next launch
      if (window.__TAURI__) {
        await invoke('save_credentials', { email: form.email, password: form.password }).catch((err) => {
          console.log('Saving credentials failed:', err);
        });
      }
      // Trigger update check if server reports a newer version
      if (data.latest_version) checkVersionFromLogin(data.latest_version);
      onLogin(data.user);
    }
  };

  // ── Forgot Password view ────────────────────────────────────────────────────
  if (mode === 'forgot') {
    return (
      <div className="min-h-screen bg-specter-bg-deep flex items-center justify-center bg-grid-pattern bg-[size:40px_40px]">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center space-y-1">
            <div className="text-specter-primary-cyan font-mono text-3xl font-bold tracking-[0.3em]">SPECTERCOMS</div>
            <div className="text-specter-text-muted font-mono text-xs tracking-widest">SECURE VOICE & TEXT</div>
          </div>
          <Card>
            <div className="mb-5">
              <div className="text-specter-primary-cyan font-mono text-xs uppercase tracking-widest mb-1">Password Reset</div>
              <div className="text-specter-text-muted font-mono text-xs">Enter the email associated with your account. If it exists, a reset link will be sent.</div>
            </div>
            <form onSubmit={handleForgotSubmit} className="space-y-4">
              <Input label="Email" id="forgot-email" type="email" value={form.email} onChange={set('email')}
                placeholder="email@example.com" required autoComplete="email" />
              {error   && <Alert type="error">{error}</Alert>}
              {success && <Alert type="success">{success}</Alert>}
              <Button type="submit" full disabled={loading || !!success}>
                {loading ? 'Sending...' : 'Send Reset Link'}
              </Button>
            </form>
            <div className="mt-4 text-center">
              <button type="button" onClick={() => switchMode('login')}
                className="text-specter-text-muted hover:text-specter-primary-cyan text-xs font-mono uppercase tracking-wider transition-colors">
                ← Back to Login
              </button>
            </div>
          </Card>
          <p className="text-center text-specter-text-muted text-xs font-mono">Zero-Trust. End-to-End Encrypted.</p>
        </div>
      </div>
    );
  }

  // ── Login / Register view ───────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-specter-bg-deep flex items-center justify-center bg-grid-pattern bg-[size:40px_40px]">
      <div className="w-full max-w-sm space-y-6">
        {/* Logo / Brand */}
        <div className="text-center space-y-1">
          <div className="text-specter-primary-cyan font-mono text-3xl font-bold tracking-[0.3em]">SPECTERCOMS</div>
          <div className="text-specter-text-muted font-mono text-xs tracking-widest">SECURE VOICE & TEXT</div>
        </div>

        <Card>
          {/* Tab Switch */}
          <div className="flex mb-6 border-b border-specter-primary-dim">
            {['login', 'register'].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className={`flex-1 py-2 text-xs font-mono uppercase tracking-wider transition-colors ${
                  mode === m
                    ? 'text-specter-primary-cyan border-b-2 border-specter-primary-cyan -mb-px'
                    : 'text-specter-text-muted hover:text-specter-text-main'
                }`}
              >
                {m === 'login' ? 'Log In' : 'Create Account'}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' ? (
              <>
                <Input label="Username" id="callsign" type="text" value={form.callsign} onChange={set('callsign')}
                  placeholder="e.g. Ghost_1" required autoComplete="username"
                  hint="3–32 chars · letters, numbers, and underscores only" />
                <Input label="Email" id="email" type="email" value={form.email} onChange={set('email')}
                  placeholder="email@example.com" required autoComplete="email" />
              </>
            ) : (
              <Input label="Email" id="email" type="email" value={form.email} onChange={set('email')}
                placeholder="email@example.com" required autoComplete="email" />
            )}

            <div className="space-y-1">
              <Input label="Password" id="password" type="password" value={form.password} onChange={set('password')}
                placeholder="Min. 8 characters" required autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                hint={mode === 'register' ? 'Minimum 8 characters' : undefined} />
              {mode === 'login' && (
                <div className="text-right">
                  <button type="button" onClick={() => switchMode('forgot')}
                    className="text-specter-text-muted hover:text-specter-primary-cyan text-xs font-mono transition-colors">
                    Forgot password?
                  </button>
                </div>
              )}
            </div>

            {error   && <Alert type="error">{error}</Alert>}
            {success && <Alert type="success">{success}</Alert>}

            <Button type="submit" full disabled={loading}>
              {loading ? 'Authenticating...' : mode === 'login' ? 'Log In' : 'Create Account'}
            </Button>
          </form>
        </Card>

        <p className="text-center text-specter-text-muted text-xs font-mono">
          Zero-Trust. End-to-End Encrypted.
        </p>
      </div>
    </div>
  );
}

function BrowserNotSupported() {
  return (
    <div className="min-h-screen bg-specter-bg-deep flex items-center justify-center bg-grid-pattern bg-[size:40px_40px] px-4">
      <Card className="w-full max-w-xl space-y-4 text-center">
        <div className="text-specter-primary-cyan font-mono text-xs uppercase tracking-widest">Desktop Client Required</div>
        <div className="text-specter-text-main font-mono text-lg font-bold tracking-wide">SPECTERCOMS APP IS NOT AVAILABLE IN A BROWSER</div>
        <div className="text-specter-text-muted font-mono text-xs">Install and launch the signed desktop client to access operations, channels, and voice.</div>
        <div>
          <Button onClick={() => window.location.href = '/api/downloads?platform=windows'}>Download Windows Client</Button>
        </div>
      </Card>
    </div>
  );
}

// ─── Root App ──────────────────────────────────────────────────────────────────

function AppContent({ isTauriRuntime }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pendingUpdate, setPendingUpdate] = useState(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] = useState(null); // { status, pct?, message? }

  useEffect(() => {
    // On initial load, try to restore session from saved credentials (Tauri only)
    if (window.__TAURI__) {
      invoke('load_credentials')
        .then(creds => {
          if (creds && creds.email && creds.password) {
            console.log('Attempting to log in with saved credentials...');
            return invoke('get_hwid').then(hwid => 
              api.login({ email: creds.email, password: creds.password, hwid: hwid || 'browser-fallback-hwid' })
            );
          }
          return Promise.reject('No saved credentials');
        })
        .then(({ data, error }) => {
          if (error) throw new Error(error);
          localStorage.setItem('specter_token', data.token);
          localStorage.setItem('specter_user', JSON.stringify(data.user));
          if (data.latest_version) checkVersionFromLogin(data.latest_version);
          setUser(data.user);
        })
        .catch(err => {
          console.log('Auto-login failed:', err.message || err);
          if (String(err?.message || err) !== 'No saved credentials') {
            // Clear potentially stale data if auto-login failed for a real reason.
            localStorage.removeItem('specter_token');
            localStorage.removeItem('specter_user');
          }
        })
        .finally(() => {
          setLoading(false);
        });
    } else {
      // For web, check for existing token in localStorage
      const token = localStorage.getItem('specter_token');
      const storedUser = localStorage.getItem('specter_user');
      if (token && storedUser) {
        try {
          setUser(JSON.parse(storedUser));
        } catch {
          localStorage.removeItem('specter_token');
          localStorage.removeItem('specter_user');
        }
      }
      setLoading(false);
    }

    // Run update check on startup (after a short delay)
    setTimeout(checkForUpdates, 3000);

    const handleAuthExpired = () => {
      setUser(null);
      if (window.__TAURI__) {
        invoke('delete_credentials').catch(() => {});
      }
    };
    window.addEventListener('specter:auth-expired', handleAuthExpired);

    const handleUpdateAvailable = (e) => setPendingUpdate(e.detail);
    window.addEventListener('specter:update-available', handleUpdateAvailable);

    const handleUpdateProgress = (e) => {
      setUpdateProgress(e.detail);
      if (e.detail.status !== 'downloading') setInstallingUpdate(false);
    };
    window.addEventListener('specter:update-progress', handleUpdateProgress);

    return () => {
      window.removeEventListener('specter:auth-expired', handleAuthExpired);
      window.removeEventListener('specter:update-available', handleUpdateAvailable);
      window.removeEventListener('specter:update-progress', handleUpdateProgress);
    };
  }, []);

  const navigate = useNavigate();
  const handleLogin = (loggedInUser) => setUser(loggedInUser);
  const handleLogout = async () => {
    if (window.__TAURI__) await invoke('delete_credentials').catch(() => {});
    localStorage.removeItem('specter_token');
    localStorage.removeItem('specter_user');
    setUser(null);
  };

  if (loading) {
    return <StartupSplashScreen />;
  }

  return (
    <>
      {pendingUpdate && isTauriRuntime && (
        <div className={`fixed ${window.__TAURI__ ? 'top-7' : 'top-0'} left-0 right-0 z-[9998] flex items-center justify-between px-4 py-2 bg-specter-primary-cyan text-specter-bg-surface text-xs font-mono font-bold tracking-wider`}>
          <span>
            {updateProgress?.status === 'downloading' && updateProgress.pct > 0
              ? `DOWNLOADING UPDATE v${pendingUpdate.version} — ${updateProgress.pct}%`
              : updateProgress?.status === 'installing'
              ? `INSTALLING UPDATE v${pendingUpdate.version}…`
              : updateProgress?.status === 'error'
              ? `UPDATE FAILED — ${updateProgress.message || 'unknown error'}`
              : `UPDATE AVAILABLE — v${pendingUpdate.version}`}
          </span>
          {!installingUpdate && updateProgress?.status !== 'installing' && (
            <button
              onClick={async () => { setInstallingUpdate(true); setUpdateProgress(null); await installUpdate(pendingUpdate); }}
              className="ml-4 px-3 py-1 rounded bg-specter-bg-surface text-specter-primary-cyan hover:bg-specter-bg-panel transition-colors uppercase"
            >
              {updateProgress?.status === 'error' ? 'Retry' : 'Install Now'}
            </button>
          )}
          {!installingUpdate && (
            <button onClick={() => { setPendingUpdate(null); setUpdateProgress(null); }} className="ml-2 opacity-70 hover:opacity-100">✕</button>
          )}
        </div>
      )}
    <Routes>
      <Route path="/" element={
        user
          ? <Navigate to="/dashboard" replace />
          : isTauriRuntime
            ? <Navigate to="/auth" replace />
            : <BrowserNotSupported />
      } />

      <Route path="/auth" element={
        user ? <Navigate to="/dashboard" replace /> : <AuthScreen onLogin={handleLogin} />
      } />

      <Route path="/dashboard" element={
        user
          ? isTauriRuntime
            ? <WarRoom user={user} onLogout={handleLogout} initialConnectOrgId={null} />
            : <BrowserNotSupported />
          : <Navigate to="/auth" replace />
      } />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}

export default function App() {
  const [isTauriRuntime, setIsTauriRuntime] = useState(() => isTauriRuntimeActive());
  const [runtimeProbeDone, setRuntimeProbeDone] = useState(() => isTauriRuntimeActive());

  useEffect(() => {
    if (isTauriRuntime) {
      setRuntimeProbeDone(true);
      return;
    }

    let alive = true;
    const probeRuntime = async () => {
      for (let i = 0; i < 120 && alive; i += 1) {
        if (isTauriRuntimeActive()) {
          setIsTauriRuntime(true);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };

    probeRuntime().finally(() => {
      if (alive) setRuntimeProbeDone(true);
    });

    return () => {
      alive = false;
    };
  }, [isTauriRuntime]);

  // Non-Tauri (web browser): show web app immediately without waiting for probes.
  // Tauri injects __TAURI_INTERNALS__ synchronously before any JS runs, so if it's
  // absent at first render this is definitively a browser context.
  if (!isTauriRuntimeActive()) {
    return (
      <BrowserRouter>
        <AppContent isTauriRuntime={false} />
      </BrowserRouter>
    );
  }

  if (!runtimeProbeDone) {
    return null;
  }

  return (
    <BrowserRouter>
      <AppContent isTauriRuntime={isTauriRuntime} />
    </BrowserRouter>
  );
}
