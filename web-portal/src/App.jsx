import React, { useState, useEffect, useCallback } from 'react';
import { Download } from 'lucide-react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import * as session from './auth/session.js';
import WarRoom from './components/WarRoom';

import StartupSplashScreen from './components/StartupSplashScreen';
import TitleBar from './components/TitleBar';
import UpdateBanner from './components/UpdateBanner';
import AuthLayout, { BrandMark, TextLink } from './components/auth/AuthLayout';
import LoginForm from './components/auth/LoginForm';
import ForgotPasswordForm from './components/auth/ForgotPasswordForm';
import { Alert, Button, Card, Input } from './components/ui';
import { cx, focusRing } from './components/ui/styles';
import { invoke } from '@tauri-apps/api/core';
import { saveChannelMessages, setMessageStoreUser } from './messageStore';
import { countCachedMessages } from './engine/unreadStore';

// Drains whatever the Rust background sync task (tray_light mode) collected
// into msgcache.rs while the window was closed, into messageStore.js's
// IndexedDB — the existing chat UI already reads history from there, so this
// is the only integration point needed rather than a second history system.
// Read-then-clear (not read-and-delete-together): only clears the Rust-side
// cache after every channel's messages are confirmed saved, so a mid-drain
// failure re-drains the same messages next launch instead of losing them.
// MR2/MR3: the cache and the history are both per account — the msgcache_*
// commands need a logged-in session, so this runs once `user` is known and
// writes into that user's specter_messages_<userId> database.
async function drainMessageCache(userId) {
  if (!window.__TAURI__ || !userId) return;
  try {
    setMessageStoreUser(userId);
    const byChannel = await invoke('msgcache_read_all');
    const channelIds = Object.keys(byChannel || {});
    if (channelIds.length === 0) return;
    for (const channelId of channelIds) {
      await saveChannelMessages(channelId, byChannel[channelId]);
    }
    await invoke('msgcache_clear_all');
    // P2A: what arrived while the engine was closed counts as unread in the
    // strip (src/engine/unreadStore.js). Own messages are skipped by user id.
    countCachedMessages(byChannel, userId);
  } catch (err) {
    console.log('Message cache drain failed:', err);
  }
}

// ─── Tauri Updater ─────────────────────────────────────────────────────────────
// Checking, downloading and installing all live in Rust (src-tauri/src/
// updater.rs): it checks at launch and every 4 hours regardless of login or
// which windows are open, downloads in the background, then emits
// `update-ready` ({ version, notes }). The banner in App only listens for that
// (plus asks `updater_pending` on mount, in case it fired before this window
// existed) and offers "Restart to update" — the only way an update installs.
// Quitting never installs (the installer would relaunch the app). The login
// response's latest_version hint is handled in auth/session.js.

const isTauriRuntimeActive = () => Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__);

// ─── Auth Screen ───────────────────────────────────────────────────────────────
// Presentation only: the login/register/reset flows (and where the session is
// stored) are in auth/session.js, so the tray strip can reuse them.

// compact: tight layout for the ~360px tray strip (S9) — no hero, no tabs,
//   "Forgot password?" / "Create account" as links under the button.
// onCreateAccount / onForgotPassword: override what those links do (the strip
//   will open the main window); by default they switch this screen's view.
function AuthScreen({ onLogin, compact = false, onCreateAccount, onForgotPassword }) {
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
    const { error } = await session.forgotPassword(form.email);
    setLoading(false);
    if (error) return setError(error);
    setSuccess('If an account with that email exists, a reset link has been sent.');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);

    if (mode === 'register') {
      const { data, error } = await session.register(form);
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
      const { user, error } = await session.login({ email: form.email, password: form.password });
      setLoading(false);
      if (error) return setError(error);
      onLogin(user);
    }
  };

  const goForgot = onForgotPassword || (() => switchMode('forgot'));
  const goRegister = onCreateAccount || (() => switchMode('register'));
  const formGap = compact ? 'space-y-3' : 'space-y-4';

  let view;
  if (mode === 'forgot') {
    // ── Forgot Password view ──────────────────────────────────────────────────
    view = (
      <ForgotPasswordForm
        email={form.email}
        onEmailChange={set('email')}
        onSubmit={handleForgotSubmit}
        loading={loading}
        error={error}
        success={success}
        onBack={() => switchMode('login')}
        compact={compact}
      />
    );
  } else if (mode === 'register') {
    // ── Register view ─────────────────────────────────────────────────────────
    view = (
      <form onSubmit={handleSubmit} className={formGap}>
        <Input label="Username" id="callsign" type="text" value={form.callsign} onChange={set('callsign')}
          placeholder="e.g. Ghost_1" required autoComplete="username" autoFocus
          hint="3–32 characters: letters, numbers and underscores" />
        <Input label="Email" id="email" type="email" value={form.email} onChange={set('email')}
          placeholder="email@example.com" required autoComplete="email" />
        <Input label="Password" id="password" type="password" value={form.password} onChange={set('password')}
          placeholder="Min. 8 characters" required autoComplete="new-password"
          hint="Minimum 8 characters" />
        {error   && <Alert variant="error">{error}</Alert>}
        {success && <Alert variant="success">{success}</Alert>}
        <Button type="submit" full disabled={loading}>
          {loading ? 'Creating account…' : 'Create account'}
        </Button>
        {compact && (
          <p className="text-center text-ui-sm text-specter-text-subtle">
            Already have an account? <TextLink onClick={() => switchMode('login')}>Log in</TextLink>
          </p>
        )}
      </form>
    );
  } else {
    // ── Login view ────────────────────────────────────────────────────────────
    // The full layout has the Log in / Create account switch above the form,
    // so only the compact one gets a "Create account" link.
    view = (
      <LoginForm
        email={form.email}
        password={form.password}
        onEmailChange={set('email')}
        onPasswordChange={set('password')}
        onSubmit={handleSubmit}
        loading={loading}
        error={error}
        notice={success}
        compact={compact}
        onForgotPassword={goForgot}
        onCreateAccount={compact ? goRegister : undefined}
      />
    );
  }

  if (compact) {
    const subtitle = mode === 'register' ? 'Create an account' : mode === 'forgot' ? 'Password reset' : 'Log in to continue';
    return (
      <div className="p-4 space-y-4 font-ui text-specter-text-main">
        <BrandMark size="sm" tagline={subtitle} />
        {view}
      </div>
    );
  }

  return (
    <AuthLayout>
      <Card padding="lg">
        {mode !== 'forgot' && (
          <div role="group" aria-label="Account"
            className="grid grid-cols-2 gap-1 p-1 mb-5 rounded-ui-row bg-specter-bg-deep/60 border border-specter-border">
            {['login', 'register'].map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => switchMode(m)}
                className={cx(
                  'h-8 rounded-ui-sm font-ui text-ui-sm font-medium transition-colors',
                  focusRing,
                  mode === m
                    ? 'bg-specter-primary-cyan/15 text-specter-primary-neon'
                    : 'text-specter-text-muted hover:text-specter-text-main hover:bg-white/5',
                )}
              >
                {m === 'login' ? 'Log in' : 'Create account'}
              </button>
            ))}
          </div>
        )}
        {view}
      </Card>
    </AuthLayout>
  );
}

function BrowserNotSupported() {
  return (
    <AuthLayout width="max-w-xl" showTrustNote={false}>
      <Card padding="lg" className="space-y-5">
        <div className="space-y-1.5 text-center">
          <p className="text-ui-sm font-medium text-specter-primary-neon">Desktop client required</p>
          <h2 className="text-ui-xl font-semibold text-specter-text-main">SpecterComs isn&apos;t available in a browser</h2>
          <p className="text-ui-base text-specter-text-subtle">
            Install and launch the signed desktop client to access operations, channels, and voice.
          </p>
        </div>
        <section className="rounded-ui-md border border-specter-border bg-specter-bg-deep/50 p-4">
          <h3 className="text-ui-sm font-semibold text-specter-text-main mb-2">Installer permission notice</h3>
          <ul className="list-disc pl-5 space-y-1 text-ui-sm text-specter-text-muted">
            <li>Microphone access for voice communications</li>
            <li>Screen/window capture access when sharing is started by you</li>
            <li>Global hotkeys for push-to-talk and overlay controls</li>
            <li>Overlay window permissions (always-on-top and click-through modes)</li>
            <li>Network access to SpecterComs services for auth, messaging, voice, and updates</li>
          </ul>
          <p className="mt-3 text-ui-xs text-specter-text-subtle">
            Capture and mic permissions are requested at runtime when features are used, not silently at install time.
          </p>
        </section>
        <div className="flex justify-center">
          <Button icon={<Download size={16} />} onClick={() => window.location.href = '/api/downloads?platform=windows'}>
            Download Windows client
          </Button>
        </div>
      </Card>
    </AuthLayout>
  );
}

// ─── Root App ──────────────────────────────────────────────────────────────────

function AppContent({ isTauriRuntime }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [forceSettingsPrompt, setForceSettingsPrompt] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState(null);

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
    }
  }, []);

  // Drain the background-sync cache once logged in (see drainMessageCache).
  // Covers a cold start (after the session restore sets `user`), a tray_light
  // reopen (the webview is rebuilt, so this runs again) and a fresh login.
  useEffect(() => {
    if (user?.id) drainMessageCache(user.id);
  }, [user?.id]);

  useEffect(() => {
    // Restore a saved session (desktop: Rust's encrypted session, refreshed
    // if stale; browser: localStorage) — see auth/session.js.
    let unmounted = false;
    session.restore()
      .then((restored) => { if (!unmounted && restored) setUser(restored); })
      .finally(() => { if (!unmounted) setLoading(false); });

    // Login state is shared by every window (the session lives in Rust):
    // follow logouts — explicit, or forced because the refresh token is dead
    // (a 401 already got one shared silent refresh in auth/tokenStore.js
    // before it comes to that) — and a login made in another window.
    const stopAuthListener = session.onAuthChanged(({ user: nextUser, reason }) => {
      if (unmounted) return;
      if (!nextUser) setUser(null);
      else if (reason === 'login') setUser((prev) => prev || nextUser);
    });

    // Downloaded-update banner — see the Tauri Updater note at the top.
    let unlistenUpdateReady = null;
    if (isTauriRuntimeActive()) {
      invoke('updater_pending')
        .then((ready) => { if (ready && !unmounted) setPendingUpdate(ready); })
        .catch((err) => console.log('Update status query failed:', err));
      import('@tauri-apps/api/event')
        .then(({ listen }) => listen('update-ready', (e) => {
          setPendingUpdate(e.payload);
          setUpdateError(null);
        }))
        .then((unlisten) => {
          if (unmounted) unlisten();
          else unlistenUpdateReady = unlisten;
        })
        .catch((err) => console.log('update-ready listener failed:', err));
    }

    return () => {
      unmounted = true;
      if (unlistenUpdateReady) unlistenUpdateReady();
      stopAuthListener();
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
    // Revokes the refresh token server-side too (so it can't silently renew
    // the session for up to 30 days), and logs out every window.
    await session.logout();
    setUser(null);
  };

  if (loading) {
    return <StartupSplashScreen />;
  }

  return (
    <>
      <TitleBar />
      {/* Rendered outside <Routes>, so it shows on the login screen as well as
          the dashboard. Only absent while the startup splash is up. offsetTop
          uses the same test as TitleBar (__TAURI__ or __TAURI_INTERNALS__). */}
      {pendingUpdate && isTauriRuntime && (
        <UpdateBanner
          version={pendingUpdate.version}
          installing={installingUpdate}
          error={updateError}
          offsetTop={isTauriRuntimeActive()}
          onInstall={() => {
            setInstallingUpdate(true);
            setUpdateError(null);
            // Rust exits the app, runs the installer and relaunches — on
            // success nothing after this ever runs.
            invoke('install_update_and_restart').catch((err) => {
              console.error('Update install failed:', err);
              setInstallingUpdate(false);
              setUpdateError(err?.message || String(err));
            });
          }}
          onDismiss={() => { setPendingUpdate(null); setUpdateError(null); }}
        />
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
