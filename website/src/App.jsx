import React, { useState, useEffect } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from './api.js';
import LandingPage from './components/LandingPage';
import AdminPortal from './components/AdminPortal';
import WebPortalDashboard from './components/WebPortalDashboard';

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

// ─── Join Via Invite Link ─────────────────────────────────────────────────────

function JoinPage() {
  const { code } = useParams();
  const navigate = useNavigate();

  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('specter_user') || 'null'); }
    catch { return null; }
  });

  const [joining, setJoining] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    const handleAuthExpired = () => {
      setUser(null);
      setJoining(false);
      setResult(null);
    };
    window.addEventListener('specter:auth-expired', handleAuthExpired);
    return () => window.removeEventListener('specter:auth-expired', handleAuthExpired);
  }, []);

  useEffect(() => {
    if (!user || !code || joining || result) return;
    setJoining(true);
    api.redeemInvite(code).then(({ data, error }) => {
      setJoining(false);
      if (error) {
        if (!localStorage.getItem('specter_token')) {
          setUser(null);
          setResult(null);
        } else {
          setResult({ success: false, message: error });
        }
      } else {
        setResult({ success: true, message: `Joined "${data.org?.callsign || 'server'}" successfully.` });
        setTimeout(() => navigate('/dashboard'), 1800);
      }
    });
  }, [user, code]);

  const handleLogin = (loggedInUser) => setUser(loggedInUser);

  if (!user) {
    return (
      <div className="min-h-screen bg-specter-bg-deep flex flex-col items-center justify-center gap-6 bg-[url('/SpecterBG.png')] bg-cover bg-center">
        <div className="text-center space-y-1">
          <div className="text-specter-primary-cyan font-mono text-3xl font-bold tracking-[0.3em]">SPECTERCOMS</div>
          <div className="text-specter-text-muted font-mono text-sm">You've been invited to join a server.</div>
          <div className="text-specter-text-muted font-mono text-xs">Log in or create an account to accept.</div>
        </div>
        <div className="w-full max-w-sm">
          <AuthScreen onLogin={handleLogin} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-specter-bg-deep bg-[url('/SpecterBG.png')] bg-cover bg-center flex items-center justify-center">
      <Card className="w-full max-w-sm space-y-4">
        <div className="text-specter-primary-cyan font-mono text-xs uppercase tracking-widest text-center">Server Invite</div>
        {joining && <div className="text-specter-text-muted text-sm font-mono text-center">Joining server...</div>}
        {result?.success && (
          <>
            <Alert type="success">{result.message}</Alert>
            <div className="text-specter-text-muted text-xs font-mono text-center">Redirecting to dashboard...</div>
          </>
        )}
        {result && !result.success && (
          <>
            <Alert type="error">{result.message}</Alert>
            <Button onClick={() => navigate('/dashboard')} full>Go to Dashboard</Button>
          </>
        )}
      </Card>
    </div>
  );
}

// ─── Auth Screen ───────────────────────────────────────────────────────────────

function AuthScreen({ onLogin, isModal = false }) {
  const [mode, setMode] = useState('login');
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

    const hwid = 'browser-fallback-hwid';

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
      onLogin(data.user);
    }
  };

  if (mode === 'forgot') {
    return (
      <div className={isModal ? '' : "min-h-screen bg-specter-bg-deep flex items-center justify-center bg-[url('/SpecterBG.png')] bg-cover bg-center"}>
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

  return (
    <div className={isModal ? '' : "min-h-screen bg-specter-bg-deep flex items-center justify-center bg-[url('/SpecterBG.png')] bg-cover bg-center"}>
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <div className="text-specter-primary-cyan font-mono text-3xl font-bold tracking-[0.3em]">SPECTERCOMS</div>
          <div className="text-specter-text-muted font-mono text-xs tracking-widest">SECURE VOICE & TEXT</div>
        </div>

        <Card>
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

// ─── Reset Password Screen ─────────────────────────────────────────────────────

function ResetPasswordScreen() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!token) return setError('Invalid reset link — token is missing.');
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    if (password !== confirm) return setError('Passwords do not match.');
    setLoading(true);
    const { error: apiError } = await api.resetPassword(token, password);
    setLoading(false);
    if (apiError) return setError(apiError);
    setSuccess(true);
  };

  return (
    <div className="min-h-screen bg-specter-bg-deep flex items-center justify-center bg-[url('/SpecterBG.png')] bg-cover bg-center">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <div className="text-specter-primary-cyan font-mono text-3xl font-bold tracking-[0.3em]">SPECTERCOMS</div>
          <div className="text-specter-text-muted font-mono text-xs tracking-widest">SECURE VOICE & TEXT</div>
        </div>
        <Card>
          <div className="mb-5">
            <div className="text-specter-primary-cyan font-mono text-xs uppercase tracking-widest mb-1">Set New Password</div>
          </div>
          {success ? (
            <div className="space-y-4">
              <Alert type="success">Password updated. You can now log in with your new credentials.</Alert>
              <Button full onClick={() => navigate('/auth')}>Go to Login</Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input label="New Password" id="new-password" type="password" value={password}
                onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required autoComplete="new-password" />
              <Input label="Confirm Password" id="confirm-password" type="password" value={confirm}
                onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" required autoComplete="new-password" />
              {!token && <Alert type="error">Missing reset token. Please use the link from your email.</Alert>}
              {error && <Alert type="error">{error}</Alert>}
              <Button type="submit" full disabled={loading || !token}>
                {loading ? 'Updating...' : 'Set New Password'}
              </Button>
            </form>
          )}
          {!success && (
            <div className="mt-4 text-center">
              <button type="button" onClick={() => navigate('/auth')}
                className="text-specter-text-muted hover:text-specter-primary-cyan text-xs font-mono uppercase tracking-wider transition-colors">
                ← Back to Login
              </button>
            </div>
          )}
        </Card>
        <p className="text-center text-specter-text-muted text-xs font-mono">Zero-Trust. End-to-End Encrypted.</p>
      </div>
    </div>
  );
}

// ─── Auth Modal ────────────────────────────────────────────────────────────────
// Overlays the landing page at /auth — clicking the backdrop or X navigates back.

function AuthModal({ onLogin, onClose }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-sm">
        <button
          onClick={onClose}
          className="absolute -top-3 -right-3 z-10 w-7 h-7 flex items-center justify-center rounded-full bg-specter-bg-panel border border-specter-primary-dim text-specter-text-muted hover:text-specter-primary-cyan text-sm font-mono transition-colors"
          aria-label="Close"
        >✕</button>
        <AuthScreen onLogin={onLogin} isModal />
      </div>
    </div>
  );
}

// ─── App Content ───────────────────────────────────────────────────────────────

function AppContent() {
  const [user, setUser] = useState(() => {
    const token = localStorage.getItem('specter_token');
    const stored = localStorage.getItem('specter_user');
    if (token && stored) {
      try { return JSON.parse(stored); } catch {}
      localStorage.removeItem('specter_token');
      localStorage.removeItem('specter_user');
    }
    return null;
  });

  useEffect(() => {
    const handleAuthExpired = () => {
      localStorage.removeItem('specter_token');
      localStorage.removeItem('specter_user');
      setUser(null);
    };
    window.addEventListener('specter:auth-expired', handleAuthExpired);
    return () => window.removeEventListener('specter:auth-expired', handleAuthExpired);
  }, []);

  const navigate = useNavigate();
  const handleLogin = (u) => setUser(u);
  const handleLogout = () => {
    localStorage.removeItem('specter_token');
    localStorage.removeItem('specter_user');
    setUser(null);
  };

  return (
    <Routes>
      <Route path="/" element={
        user
          ? <Navigate to="/dashboard" replace />
          : <LandingPage onEnter={() => navigate('/auth')} />
      } />

      <Route path="/auth" element={
        user ? <Navigate to="/dashboard" replace /> : (
          <>
            <LandingPage onEnter={() => {}} />
            <AuthModal onLogin={handleLogin} onClose={() => navigate('/')} />
          </>
        )
      } />

      <Route path="/dashboard" element={
        user
          ? <WebPortalDashboard user={user} onLogout={handleLogout} />
          : <Navigate to="/auth" replace />
      } />

      <Route path="/auth/admin" element={<AdminPortal onExit={() => navigate('/')} />} />
      <Route path="/reset-password" element={<ResetPasswordScreen />} />
      <Route path="/join/:code" element={<JoinPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}
