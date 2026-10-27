// Dev-only gallery for components/ui — loaded by /ui-preview.html, which is
// not a production build input. Not imported anywhere in the app.
/* eslint-disable react-refresh/only-export-components -- entry module, not a component library */
import { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Bell, Calendar, Monitor, Plus, Settings, Trash2, Volume2 } from 'lucide-react';
import '../index.css';
import { Alert, Badge, Button, Card, IconButton, Input, Modal, Row, Toggle } from '../components/ui';
import LoginForm from '../components/auth/LoginForm';
import { BrandMark } from '../components/auth/AuthLayout';
import UpdateBanner from '../components/UpdateBanner';

function Section({ title, children }) {
  return (
    <section className="space-y-3">
      <h2 className="text-ui-sm font-semibold text-specter-text-subtle">{title}</h2>
      {children}
    </section>
  );
}

function Preview() {
  const [notify, setNotify] = useState(true);
  const [overlay, setOverlay] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [login, setLogin] = useState({ email: '', password: '' });
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState(null);
  const [bannerState, setBannerState] = useState('ready'); // ready | installing | error | hidden

  return (
    <div className="holo-viewport min-h-screen p-8 font-ui text-specter-text-main">
      <div className="max-w-3xl mx-auto space-y-8">
        <h1 className="text-ui-xl font-semibold">UI components</h1>

        <Section title="Type scale">
          <p className="text-ui-xl">Text 20 — page title</p>
          <p className="text-ui-lg">Text 16 — section title</p>
          <p className="text-ui-base">Text 14 — body and row titles</p>
          <p className="text-ui-sm text-specter-text-muted">Text 13 — labels (text.muted)</p>
          <p className="text-ui-xs text-specter-text-subtle">Text 12 — secondary lines (text.subtle)</p>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-2">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger" icon={<Trash2 size={14} />}>Delete</Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon={<Plus size={14} />}>New operation</Button>
            <Button size="sm" variant="secondary">Small</Button>
            <IconButton icon={<Settings size={16} />} label="Settings" />
            <IconButton icon={<Bell size={16} />} label="Notifications" variant="secondary" />
            <IconButton icon={<Volume2 size={16} />} label="Audio" active />
          </div>
          <div className="max-w-xs"><Button full>Full width</Button></div>
        </Section>

        <Section title="Inputs">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Username" placeholder="callsign" hint="Shown to other members" />
            <Input label="Password" type="password" placeholder="••••••••" />
            <Input label="Server URL" defaultValue="not a url" error="Enter a valid https:// address" />
            <Input label="Disabled" disabled defaultValue="read only" />
          </div>
        </Section>

        <Section title="Card, rows, toggles, badges">
          <Card title="Operations" subtitle="Now and soon" actions={<Badge variant="count">3</Badge>} padding="none">
            <div className="px-2 pb-2 space-y-0.5">
              <Row icon={<Monitor size={16} />} title="Mining run — Aaron Halo" subtitle="Started 12 min ago · 6 members" trailing={<Badge variant="live" />} onClick={() => {}} />
              <Row icon={<Calendar size={16} />} title="Cargo escort" subtitle="Starts in 24 min" trailing={<Badge variant="warning">Soon</Badge>} onClick={() => {}} />
              <Row icon={<Calendar size={16} />} title="Bunker sweep" subtitle="Tomorrow 20:00" trailing={<Badge>Scheduled</Badge>} onClick={() => {}} selected />
              <Row icon={<Bell size={16} />} title="Notifications" subtitle="Desktop alerts for mentions" trailing={<Toggle checked={notify} onChange={setNotify} aria-label="Notifications" />} />
            </div>
          </Card>
          <Card>
            <div className="space-y-4">
              <Toggle label="Show overlay in game" description="Press Ctrl+Shift+O to toggle" checked={overlay} onChange={setOverlay} />
              <Toggle label="Disabled setting" checked disabled />
            </div>
          </Card>
        </Section>

        <Section title="Alerts">
          <Alert variant="error">Invalid email or password.</Alert>
          <Alert variant="success">Operator Ghost_1 registered. Proceed to login.</Alert>
          <Alert variant="warning" title="Heads up">Your session expires in 5 minutes.</Alert>
          <Alert variant="info">A reset link has been sent if the account exists.</Alert>
        </Section>

        <Section title="Compact login (tray strip, 360px)">
          <div className="w-[360px] rounded-ui-lg bg-specter-bg-panel/70 backdrop-blur-md border border-specter-border p-4 space-y-4">
            <BrandMark size="sm" tagline="Log in to continue" />
            <LoginForm
              compact
              email={login.email}
              password={login.password}
              onEmailChange={(e) => setLogin((v) => ({ ...v, email: e.target.value }))}
              onPasswordChange={(e) => setLogin((v) => ({ ...v, password: e.target.value }))}
              onSubmit={(e) => {
                e.preventDefault();
                setLoginBusy(true);
                setLoginError(null);
                setTimeout(() => { setLoginBusy(false); setLoginError('Invalid email or password.'); }, 800);
              }}
              loading={loginBusy}
              error={loginError}
              autoFocus={false}
              idPrefix="preview-compact"
              onForgotPassword={() => {}}
              onCreateAccount={() => {}}
            />
          </div>
        </Section>

        <Section title="Update banner">
          <div className="flex flex-wrap gap-2">
            {['ready', 'installing', 'error', 'hidden'].map((s) => (
              <Button key={s} size="sm" variant={bannerState === s ? 'primary' : 'secondary'} onClick={() => setBannerState(s)}>{s}</Button>
            ))}
          </div>
          {bannerState !== 'hidden' && (
            <UpdateBanner
              version="1.11.0"
              installing={bannerState === 'installing'}
              error={bannerState === 'error' ? 'Signature verification failed' : null}
              onInstall={() => setBannerState('installing')}
              onDismiss={() => setBannerState('hidden')}
            />
          )}
        </Section>

        <Section title="Modal">
          <Button variant="secondary" onClick={() => setModalOpen(true)}>Open modal</Button>
          <Modal
            open={modalOpen}
            onClose={() => setModalOpen(false)}
            title="Leave operation?"
            size="sm"
            footer={(
              <>
                <Button variant="secondary" size="sm" onClick={() => setModalOpen(false)}>Cancel</Button>
                <Button variant="danger" size="sm" onClick={() => setModalOpen(false)}>Leave</Button>
              </>
            )}
          >
            <p className="text-specter-text-muted">You can rejoin while it&apos;s still live.</p>
          </Modal>
        </Section>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Preview />);
