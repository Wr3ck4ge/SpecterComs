import React, { useState, useEffect, useCallback } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import WarRoom from './components/WarRoom';

import StartupSplashScreen from './components/StartupSplashScreen';
import { invoke } from '@tauri-apps/api/core';
import { saveChannelMessages } from './messageStore';

// Drains whatever the Rust background sync task (tray_light mode) collected
// into msgcache.rs while the window was closed, into messageStore.js's
// IndexedDB — the existing chat UI already reads history from there, so this
// is the only integration point needed rather than a second history system.
// Read-then-clear (not read-and-delete-together): only clears the Rust-side
// cache after every channel's messages are confirmed saved, so a mid-drain
// failure re-drains the same messages next launch instead of losing them.
async function drainMessageCache() {
  if (!window.__TAURI__) return;
  try {
    const byChannel = await invoke('msgcache_read_all');
    const channelIds = Object.keys(byChannel || {});
    if (channelIds.length === 0) return;
    for (const channelId of channelIds) {
      await saveChannelMessages(channelId, byChannel[channelId]);
    }
    await invoke('msgcache_clear_all');
  } catch (err) {
    console.log('Message cache drain failed:', err);
  }
}

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
      if (data.refresh_token) localStorage.setItem('specter_refresh_token', data.refresh_token);
      localStorage.setItem('specter_user', JSON.stringify(data.user));
      // Save encrypted revocable session state for next launch.
      if (window.__TAURI__) {
        await invoke('save_credentials', { token: data.token, refreshToken: data.refresh_token || null, user: data.user }).catch((err) => {
          console.log('Saving session failed:', err);
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
        <div className="text-left bg-specter-bg-panel border border-specter-primary-dim rounded p-3">
          <div className="text-specter-primary-cyan text-[10px] uppercase tracking-widest font-mono mb-2">Installer Permission Notice</div>
          <ul className="text-specter-text-muted text-xs font-mono leading-5 list-disc pl-4 space-y-1">
            <li>Microphone access for voice communications</li>
            <li>Screen/window capture access when sharing is started by you</li>
            <li>Global hotkeys for push-to-talk and overlay controls</li>
            <li>Overlay window permissions (always-on-top and click-through modes)</li>
            <li>Network access to SpecterComs services for auth, messaging, voice, and updates</li>
          </ul>
          <div className="text-[10px] text-zinc-500 font-mono mt-2">Capture and mic permissions are requested at runtime when features are used, not silently at install time.</div>
        </div>
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
  const [forceSettingsPrompt, setForceSettingsPrompt] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] = useState(null); // { status, pct?, message? }

  useEffect(() => {
    // Sync the saved close-behavior setting to Rust on every launch — it
    // can't read localStorage itself, and its in-memory default ("quit") is
    // only updated when SettingsUI.jsx's Save button runs, which won't have
    // happened yet this session for a returning user with a saved preference.
    // Independent of login state (a device-level app setting, not account data).
    if (window.__TAURI__) {
      const savedCloseBehavior = localStorage.getItem('specter_close_behavior');
      if (savedCloseBehavior) {
        invoke('set_close_behavior', { mode: savedCloseBehavior }).catch(() => {});
      }
      // Covers both a cold app start and a tray_light reopen — the latter
      // destroys and rebuilds the webview (see build_main_window in Rust),
      // so this same mount-time effect runs again naturally either way.
      drainMessageCache();
    }
  }, []);

  useEffect(() => {
    // On initial load, try to restore an encrypted saved session (Tauri only).
    if (window.__TAURI__) {
      invoke('load_credentials')
        .then(async saved => {
          if (saved && saved.token && saved.user) {
            // Primary path: token-based persisted session (no password at rest).
            // The saved access token is very likely stale by now (30 min TTL) —
            // redeem the refresh token first so this actually survives past a
            // single short session instead of just replaying a dead token.
            if (saved.refresh_token) {
              const { data: refreshed, error: refreshError } = await api.refresh(saved.refresh_token);
              if (!refreshError && refreshed?.token) {
                localStorage.setItem('specter_token', refreshed.token);
                localStorage.setItem('specter_refresh_token', refreshed.refresh_token);
                localStorage.setItem('specter_user', JSON.stringify(saved.user));
                invoke('save_credentials', { token: refreshed.token, refreshToken: refreshed.refresh_token, user: saved.user }).catch(() => {});
                return api.getMyProfile();
              }
              // Refresh token itself is dead (expired past its 30-day life, or
              // revoked) — nothing left to silently recover, fall through to a
              // real login.
              return Promise.reject('No saved session');
            }
            localStorage.setItem('specter_token', saved.token);
            localStorage.setItem('specter_user', JSON.stringify(saved.user));
            return api.getMyProfile();
          }

          if (saved && saved.email && saved.password) {
            // Backward-compat migration path from older builds.
            console.log('Attempting one-time migration from legacy saved credentials...');
            return invoke('get_hwid').then(hwid => 
              api.login({ email: saved.email, password: saved.password, hwid: hwid || 'browser-fallback-hwid' })
            );
          }
          return Promise.reject('No saved session');
        })
        .then(({ data, error }) => {
          // Profile validation path from token restore returns getMyProfile() shape.
          if (data && !error && data.user == null && data.callsign) {
            setUser(data);
            return;
          }

          if (error) throw new Error(error);
          localStorage.setItem('specter_token', data.token);
          if (data.refresh_token) localStorage.setItem('specter_refresh_token', data.refresh_token);
          localStorage.setItem('specter_user', JSON.stringify(data.user));
          // Migrate legacy saved credentials to token-based persisted session.
          invoke('save_credentials', { token: data.token, refreshToken: data.refresh_token || null, user: data.user }).catch(() => {});
          if (data.latest_version) checkVersionFromLogin(data.latest_version);
          setUser(data.user);
        })
        .catch(err => {
          console.log('Auto-login failed:', err.message || err);
          if (String(err?.message || err) !== 'No saved session') {
            // Clear potentially stale data if auto-login failed for a real reason.
            localStorage.removeItem('specter_token');
            localStorage.removeItem('specter_refresh_token');
            localStorage.removeItem('specter_user');
            invoke('delete_credentials').catch(() => {});
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

    // A 401 already cleared specter_token/specter_user (see fetchWithAuth in
    // api.js) before this fires. Try one silent refresh — using the still-live
    // specter_refresh_token, which that same 401 handling deliberately leaves
    // alone — before giving up and forcing a real re-login. This is what turns
    // "the 30-min access token expired mid-session" from a forced logout into
    // an invisible recovery.
    const forceLogout = () => {
      setUser(null);
      localStorage.removeItem('specter_refresh_token');
      if (window.__TAURI__) invoke('delete_credentials').catch(() => {});
    };
    const handleAuthExpired = () => {
      const refreshToken = localStorage.getItem('specter_refresh_token');
      if (!refreshToken) { forceLogout(); return; }

      api.refresh(refreshToken).then(({ data, error }) => {
        if (error || !data?.token) { forceLogout(); return; }
        localStorage.setItem('specter_token', data.token);
        localStorage.setItem('specter_refresh_token', data.refresh_token);
        // Re-fetch the profile rather than trusting a stale closure over this
        // component's user state (this handler is registered once on mount).
        api.getMyProfile().then(({ data: profile, error: profileError }) => {
          if (profileError || !profile) { forceLogout(); return; }
          localStorage.setItem('specter_user', JSON.stringify(profile));
          if (window.__TAURI__) {
            invoke('save_credentials', { token: data.token, refreshToken: data.refresh_token, user: profile }).catch(() => {});
          }
          setUser(profile);
        });
      });
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

  // First launch of a new version, once actually inside the app (not on the
  // pre-login screens): auto-open Settings so close-behavior/keybind/mic
  // choices don't just sit silently defaulted after an update that changes
  // them (e.g. this release added the close-to-tray option and the
  // AAD-bound voice crypto — neither is visible unless someone happens to
  // open Settings on their own). Fires once per version, not once per launch.
  useEffect(() => {
    if (!window.__TAURI__ || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        const currentVersion = await getVersion();
        const lastSeen = localStorage.getItem('specter_last_seen_version');
        if (!cancelled && lastSeen !== currentVersion) {
          localStorage.setItem('specter_last_seen_version', currentVersion);
          if (lastSeen) setForceSettingsPrompt(true); // skip on a genuinely first-ever install — nothing to "catch up" on yet
        }
      } catch (e) {
        console.error('Version-seen check failed:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  const navigate = useNavigate();
  const handleLogin = (loggedInUser) => setUser(loggedInUser);
  const handleLogout = async () => {
    // Revoke the refresh token server-side so it can't silently renew the
    // session again after this — without this, an explicit logout only ever
    // discarded the client's local copy, leaving the long-lived credential
    // itself valid until it naturally expired up to 30 days later.
    const refreshToken = localStorage.getItem('specter_refresh_token');
    if (refreshToken) api.logout(refreshToken).catch(() => {});
    if (window.__TAURI__) await invoke('delete_credentials').catch(() => {});
    localStorage.removeItem('specter_token');
    localStorage.removeItem('specter_refresh_token');
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
            ? <WarRoom user={user} onLogout={handleLogout} initialConnectOrgId={null} forceSettingsOpen={forceSettingsPrompt} onSettingsPromptShown={() => setForceSettingsPrompt(false)} />
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
