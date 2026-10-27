// P2C: the tray strip's Settings cabinet — the cleaned-up replacement for the
// old main window's SettingsUI (tabs audio / comms / profile / games / billing)
// and the profile half of WarRoom's ProfileCabinet. A home list of sections;
// each opens in place with a back arrow.
//
// Device-level settings (audio, voice, hotkeys, overlay) live in the engine
// window and go through the settings bridge (useSettings → engine), applying
// live — there are no Save buttons for them. Account settings are server-side
// and call the API from here directly.
import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown, ChevronLeft, Info, LogOut, Mic, MonitorPlay, RefreshCw, Search, ShieldCheck, Upload, User, X,
} from 'lucide-react';
import { Alert, Button, IconButton, Row, Toggle } from '../ui';
import { cx, focusRing } from '../ui/styles';
import HexBadge from '../HexBadge';
import { api as realApi, UPLOADS_BASE_URL } from '../../api';
import { comboFromKeyEvent, prettyKey } from '../../keybinds';
import { inputClass } from './stripOpsLayout';

const TIMEZONE_FALLBACK = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Australia/Sydney', 'Pacific/Auckland'];
function getSupportedTimezones() {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return TIMEZONE_FALLBACK; }
}

const SETTINGS_SECTIONS = [
  { id: 'audio', title: 'Audio & voice', Icon: Mic },
  { id: 'overlay', title: 'Overlay & hotkeys', Icon: MonitorPlay },
  { id: 'account', title: 'Account', Icon: User },
  { id: 'privacy', title: 'Privacy & encryption', Icon: ShieldCheck },
  { id: 'about', title: 'About & diagnostics', Icon: Info },
];

// ── Small building blocks ─────────────────────────────────────────────────

function Group({ title, children }) {
  return (
    <section className="space-y-2">
      {title && <h3 className="text-ui-xs font-semibold uppercase tracking-wide text-specter-text-subtle">{title}</h3>}
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="space-y-1.5">
      <div className="text-ui-sm font-medium text-specter-text-muted">{label}</div>
      {children}
      {hint && <p className="text-ui-xs text-specter-text-subtle">{hint}</p>}
    </div>
  );
}

/**
 * In-DOM dropdown: expands inline (no native <select> popup — those can take
 * focus from the strip window, which hides it on blur, and would be clipped by
 * the window region). `filter` adds a search box for long lists.
 */
function Picker({ value, options, onChange, filter = false, label, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const current = options.find((o) => o.value === value);
  const shown = filter && q ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : options;
  return (
    <div>
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-label={label}
        onClick={() => { setOpen((o) => !o); setQ(''); }}
        className={cx(inputClass, 'flex items-center gap-2 text-left disabled:opacity-50', focusRing)}
      >
        <span className="flex-1 min-w-0 truncate">{current?.label ?? value ?? '—'}</span>
        <ChevronDown size={14} aria-hidden="true" className={cx('shrink-0 text-specter-text-subtle transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-1 rounded-ui-row border border-specter-border bg-specter-bg-deep/70">
          {filter && (
            <div className="relative p-1.5 border-b border-specter-border-divider">
              <Search size={13} aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 text-specter-text-subtle" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search"
                className={cx(inputClass, 'pl-7 h-7')} />
            </div>
          )}
          <ul role="listbox" aria-label={label} className="strip-scroll max-h-44 py-1">
            {shown.map((o) => (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  onClick={() => { onChange(o.value); setOpen(false); }}
                  className={cx(
                    'w-full px-3 py-1.5 text-left text-ui-sm truncate transition-colors',
                    o.value === value ? 'text-specter-primary-neon bg-specter-primary-cyan/10' : 'text-specter-text-main hover:bg-white/5',
                  )}
                >
                  {o.label}
                </button>
              </li>
            ))}
            {!shown.length && <li className="px-3 py-1.5 text-ui-sm text-specter-text-subtle">No matches</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function Segmented({ value, options, onChange, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-1 p-1 rounded-ui-row bg-specter-bg-deep/60 border border-specter-border"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'h-7 rounded-ui-sm text-ui-sm font-medium transition-colors',
            focusRing,
            value === o.value ? 'bg-specter-primary-cyan text-specter-bg-deep' : 'text-specter-text-muted hover:text-specter-text-main hover:bg-white/5',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Range slider that writes through `onCommit` after the hand settles. */
function Slider({ value, min, max, step, onCommit, format, label, marker }) {
  const [local, setLocal] = useState(value);
  const timer = useRef(null);
  useEffect(() => { setLocal(value); }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const change = (v) => {
    setLocal(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onCommit(v), 250);
  };
  return (
    <div className="flex items-center gap-3">
      <div className="relative flex-1">
        <input type="range" min={min} max={max} step={step} value={local} aria-label={label}
          onChange={(e) => change(e.target.value)}
          className="w-full accent-specter-primary-cyan cursor-pointer" />
        {marker}
      </div>
      <span className="w-12 text-right text-ui-sm tabular-nums text-specter-primary-neon">{format(local)}</span>
    </div>
  );
}

/** A global-shortcut binding: shows the combo, records a new one, clears it. */
function KeybindField({ label, hint, value, onChange, live }) {
  const [recording, setRecording] = useState(false);
  const [err, setErr] = useState('');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (!recording) return undefined;
    setErr('');
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) { setRecording(false); return; }
      const combo = comboFromKeyEvent(e);
      if (combo === null) return;
      if (combo === 'invalid') { setErr("That key can't be used as a global shortcut. Try a letter, number, F-key or numpad key."); return; }
      onChangeRef.current(combo);
      setRecording(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <div className={cx(inputClass, 'flex items-center', recording && 'border-specter-primary-cyan')} aria-live="polite">
          {recording
            ? <span className="text-amber-300">{err || 'Press a key… (Esc cancels)'}</span>
            : value ? <span className="font-mono">{prettyKey(value)}</span> : <span className="text-specter-text-subtle">Not set</span>}
        </div>
        <Button size="sm" variant={recording ? 'primary' : 'secondary'} onClick={() => setRecording((r) => !r)}>
          {recording ? 'Cancel' : value ? 'Change' : 'Bind'}
        </Button>
        {value && !recording && <IconButton size="sm" icon={<X size={14} />} label={`Clear ${label}`} onClick={() => onChange('')} />}
      </div>
      {live !== undefined && value && !recording && (
        <div className="flex items-center gap-2 text-ui-xs">
          <span aria-hidden="true" className={cx('h-2 w-2 rounded-pill transition-colors', live ? 'bg-specter-state-success' : 'bg-white/20')} />
          <span className={live ? 'text-emerald-300' : 'text-specter-text-subtle'}>{live ? 'Key detected' : `Press ${prettyKey(value)} to test`}</span>
        </div>
      )}
    </Field>
  );
}

// Mic meter on a dBFS scale (raw i16 RMS in): a linear bar hides the noise
// floor in the first few pixels. -80…-10 dBFS covers a quiet room to shouting.
const METER_MIN_DB = -80;
const METER_MAX_DB = -10;
const rmsDb = (rms) => (rms > 0 ? 20 * Math.log10(rms / 32768) : -120);
const meterPct = (rms) => `${Math.max(0, Math.min(100, ((rmsDb(rms) - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)) * 100))}%`;

/**
 * Live voice-activation meter: the mic level, the learned background level
 * (grey tick, Auto and Manual), the manual threshold (amber tick, Manual
 * only) and whether the gate is letting audio through.
 */
function VoiceMeter({ mic, manual, threshold }) {
  const rms = mic.rms ?? (mic.level / 100) * 500; // older engines: level only
  const hasGate = mic.mode !== undefined;
  const active = hasGate ? Boolean(mic.gate) : rms >= threshold;
  const floor = mic.floor;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 h-2.5 rounded-pill bg-white/10 overflow-hidden" role="meter"
          aria-valuemin={METER_MIN_DB} aria-valuemax={METER_MAX_DB} aria-valuenow={Math.round(Math.max(METER_MIN_DB, rmsDb(rms)))} aria-label="Mic level (dB)">
          <div className={cx('absolute inset-y-0 left-0 rounded-pill transition-[width] duration-75', active ? 'bg-specter-state-success' : 'bg-specter-primary-cyan/60')} style={{ width: meterPct(rms) }} />
          {floor > 0 && <div className="absolute inset-y-0 w-0.5 bg-white/60" style={{ left: meterPct(floor) }} aria-hidden="true" title="Background noise" />}
          {manual && <div className="absolute inset-y-0 w-0.5 bg-amber-300" style={{ left: meterPct(threshold) }} aria-hidden="true" title="Threshold" />}
        </div>
        <span className={cx('w-20 text-right text-ui-xs font-semibold', active ? 'text-emerald-300' : 'text-specter-text-subtle')}>{active ? 'Transmitting' : 'Silent'}</span>
      </div>
      {hasGate && (
        <p className="text-ui-xs text-specter-text-subtle tabular-nums">
          {floor > 0 ? `Background ${Math.round(rmsDb(floor))} dB` : 'Listening for background…'}
          {mic.vad != null ? ` · voice ${Math.round(mic.vad * 100)}%` : ''}
        </p>
      )}
    </div>
  );
}

function EngineState({ settings }) {
  if (settings.status === 'ready') return null;
  if (settings.status === 'loading') return <p className="text-ui-sm text-specter-text-subtle">Loading settings…</p>;
  return (
    <Alert variant="error" title="Settings aren't available right now">
      {settings.error}
      <div className="mt-2"><Button size="sm" variant="secondary" onClick={settings.reload}>Try again</Button></div>
    </Alert>
  );
}

// ── Sections ──────────────────────────────────────────────────────────────

function deviceOptions(list, fallbackLabel) {
  return [{ value: 'default', label: fallbackLabel }, ...(list || []).map((d) => ({ value: d.id, label: d.isDefault ? `${d.name} (default)` : d.name }))];
}

function AudioSection({ settings, pttLive }) {
  const v = settings.values;
  const { devices, loadDevices, requestMic, mic, setMicTest } = settings;
  useEffect(() => { loadDevices(); }, [loadDevices]);
  // Stop a running test when leaving the section (unmount only).
  const micRef = useRef({ on: mic.on, setMicTest });
  micRef.current = { on: mic.on, setMicTest };
  useEffect(() => () => { if (micRef.current.on) micRef.current.setMicTest(false); }, []);
  const threshold = Number(v.specter_audio_threshold) || 150;
  const ptt = v.specter_voice_mode === 'push-to-talk';
  // Push-to-talk always gates with the manual threshold (unchanged behaviour).
  const manual = ptt || v.specter_vad_mode === 'manual';
  const setInput = (id) => {
    settings.set('specter_audio_in', id);
    if (mic.on) setMicTest(true, id);
  };
  return (
    <div className="space-y-5">
      {devices && devices.permission !== 'granted' && (
        <Alert variant={devices.permission === 'denied' ? 'error' : 'warning'}
          title={devices.permission === 'denied' ? 'Microphone access denied' : 'Microphone access needed'}>
          {devices.permission === 'denied'
            ? 'Allow microphone access in Windows privacy settings, then come back here.'
            : 'No microphones were found. Windows may be blocking access.'}
          {devices.permission !== 'denied' && (
            <div className="mt-2"><Button size="sm" variant="secondary" onClick={requestMic}>Grant microphone access</Button></div>
          )}
        </Alert>
      )}
      <Group title="Devices">
        <Field label="Microphone">
          <Picker label="Microphone" value={v.specter_audio_in} onChange={setInput}
            options={deviceOptions(devices?.inputs, 'System default microphone')} />
        </Field>
        <Field label="Speakers">
          <Picker label="Speakers" value={v.specter_audio_out} onChange={(id) => settings.set('specter_audio_out', id)}
            options={deviceOptions(devices?.outputs, 'System default speakers')} />
        </Field>
      </Group>
      <Group title="Microphone">
        <Field label="Input gain">
          <Slider label="Input gain" value={v.specter_audio_gain} min="0.1" max="3.0" step="0.1"
            format={(x) => `${parseFloat(x).toFixed(1)}×`} onCommit={(x) => settings.set('specter_audio_gain', String(x))} />
        </Field>
        <Field label="Voice activation"
          hint={ptt
            ? 'Push to talk is on: while the key is held, the manual threshold below applies.'
            : manual
              ? 'Sends your mic whenever it is louder than the threshold.'
              : 'Learns your background noise and only sends when it hears a voice. Fans, hum and typing stay off the air.'}>
          {!ptt && (
            <Segmented label="Voice activation" value={manual ? 'manual' : 'auto'}
              onChange={(m) => settings.set('specter_vad_mode', m)}
              options={[{ value: 'auto', label: 'Auto (adaptive)' }, { value: 'manual', label: 'Manual threshold' }]} />
          )}
        </Field>
        {manual ? (
          <Field label="Activation threshold">
            <p className="text-ui-xs text-specter-text-subtle">How loud you need to be to count as talking. Lower is more sensitive. Default 150.</p>
            <Slider label="Activation threshold" value={threshold} min="10" max="500" step="5"
              format={(x) => String(x)} onCommit={(x) => settings.set('specter_audio_threshold', String(x))} />
          </Field>
        ) : (
          <>
            <Field label="Sensitivity" hint="Raise it if quiet speech or whispers get cut off; lower it if background voices or game audio get through.">
              <Segmented label="Sensitivity" value={v.specter_vad_sensitivity || 'normal'}
                onChange={(s) => settings.set('specter_vad_sensitivity', s)}
                options={[{ value: 'low', label: 'Low' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }]} />
            </Field>
            <Toggle label="Noise suppression" description="Removes steady background noise (fans, hum, hiss) from what you send."
              checked={v.specter_noise_suppression !== 'false'} onChange={(on) => settings.set('specter_noise_suppression', String(on))} />
          </>
        )}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Button size="sm" variant={mic.on ? 'primary' : 'secondary'} onClick={() => setMicTest(!mic.on, v.specter_audio_in)}>
              {mic.on ? 'Stop test' : 'Test mic'}
            </Button>
            {mic.on ? <div className="flex-1 min-w-0"><VoiceMeter mic={mic} manual={manual} threshold={threshold} /></div>
              : <span className="text-ui-xs text-specter-text-subtle">
                {manual ? 'Speak to see your level against the threshold.' : 'Stay quiet a moment, then speak: the meter shows when you would be heard.'}
              </span>}
          </div>
          {mic.on && mic.live && <p className="text-ui-xs text-specter-text-subtle">Using your live voice-channel mic.</p>}
          {mic.error && <Alert variant="error">Mic test failed: {mic.error}</Alert>}
        </div>
        <Toggle label="Coms filter" description="Radio-style filter on incoming voice by default."
          checked={v.specter_audio_coms_filter === 'true'} onChange={(on) => settings.set('specter_audio_coms_filter', String(on))} />
      </Group>
      <Group title="Talking">
        <Segmented label="Voice mode" value={ptt ? 'push-to-talk' : 'voice-activated'}
          onChange={(m) => settings.set('specter_voice_mode', m)}
          options={[{ value: 'voice-activated', label: 'Voice activated' }, { value: 'push-to-talk', label: 'Push to talk' }]} />
        {ptt && (
          <KeybindField label="Push-to-talk key" value={v.specter_ptt_key} live={pttLive}
            onChange={(c) => settings.set('specter_ptt_key', c)} />
        )}
      </Group>
    </div>
  );
}

function OverlaySection({ settings }) {
  const v = settings.values;
  const safe = v.specter_overlay_safe_mode === '1';
  return (
    <div className="space-y-5">
      <Group title="Overlay">
        <Field label="Corner" hint="Where the game overlay anchors when it opens.">
          <Segmented label="Overlay corner" value={v.specter_overlay_corner}
            onChange={(c) => settings.set('specter_overlay_corner', c)}
            options={[{ value: 'top-left', label: 'Top left' }, { value: 'top-right', label: 'Top right' }]} />
        </Field>
        <Toggle label="Safe mode"
          description="Use the built-in HUD instead of the always-on-top overlay window. Only turn this on if the overlay doesn't appear. While it's on, the overlay can't be opened from here."
          checked={safe} onChange={(on) => settings.set('specter_overlay_safe_mode', on ? '1' : null)} />
      </Group>
      <Group title="Hotkeys">
        <p className="text-ui-xs text-specter-text-subtle">Global shortcuts work while a game has focus. Modifiers (Ctrl, Alt, Shift) are allowed.</p>
        <KeybindField label="Cycle active stream" hint="Steps through the streams being shared in your channel."
          value={v.specter_stream_next_key} onChange={(c) => settings.set('specter_stream_next_key', c)} />
        <KeybindField label="Overlay click-through" hint="Makes the overlay ignore the mouse completely. Press again to restore it."
          value={v.specter_overlay_passthrough_key} onChange={(c) => settings.set('specter_overlay_passthrough_key', c)} />
        <KeybindField label="Cycle frequency" hint="During operations: primary channel → each frequency → back to primary."
          value={v.specter_channel_toggle_key} onChange={(c) => settings.set('specter_channel_toggle_key', c)} />
      </Group>
    </div>
  );
}

function FileButton({ accept, onFile, onSetBusy, children, disabled, icon }) {
  const ref = useRef(null);
  // The file dialog takes focus from the strip, which hides on blur — hold
  // it open (strip_set_busy) until the dialog closes.
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const done = () => onSetBusy?.(false);
    el.addEventListener('cancel', done);
    return () => el.removeEventListener('cancel', done);
  }, [onSetBusy]);
  return (
    <>
      <input ref={ref} type="file" accept={accept} className="hidden"
        onChange={(e) => { onSetBusy?.(false); const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />
      <Button size="sm" variant="secondary" icon={icon} disabled={disabled}
        onClick={() => {
          onSetBusy?.(true);
          // Safety net: release the hold when the window gets focus back.
          const back = () => { setTimeout(() => onSetBusy?.(false), 400); window.removeEventListener('focus', back); };
          window.addEventListener('focus', back);
          ref.current?.click();
        }}>
        {children}
      </Button>
    </>
  );
}

function AccountSection({ user, onUserChange, onLogout, onSetBusy, api }) {
  const [profile, setProfile] = useState(user || {});
  const [timezone, setTimezone] = useState(user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [tzState, setTzState] = useState({ saving: false, msg: null, error: null });
  const [avatar, setAvatar] = useState({ busy: false, msg: null, error: null });
  const [intro, setIntro] = useState({ busy: false, msg: null, error: null });
  const [loggingOut, setLoggingOut] = useState(false);
  const timezones = useState(getSupportedTimezones)[0];

  // Fresh profile (the session snapshot can lag behind other devices).
  useEffect(() => {
    let stale = false;
    api.getMyProfile().then(({ data }) => {
      const u = data?.user || data;
      if (stale || !u?.callsign) return;
      setProfile(u);
      if (u.timezone) setTimezone(u.timezone);
    }).catch(() => {});
    return () => { stale = true; };
  }, [api]);

  const update = (patch) => {
    const next = { ...profile, ...patch };
    setProfile(next);
    onUserChange?.(next);
  };

  const saveTz = async () => {
    setTzState({ saving: true, msg: null, error: null });
    const { error } = await api.updateProfile({ timezone });
    if (error) { setTzState({ saving: false, msg: null, error }); return; }
    update({ timezone });
    setTzState({ saving: false, msg: 'Timezone saved.', error: null });
  };

  const uploadAvatar = async (file) => {
    setAvatar({ busy: true, msg: null, error: null });
    const fd = new FormData();
    fd.append('image', file);
    const { data, error } = await api.uploadAvatar(fd);
    if (error) { setAvatar({ busy: false, msg: null, error }); return; }
    update({ avatar_url: data?.avatar_url });
    setAvatar({ busy: false, msg: 'Avatar updated.', error: null });
  };

  const uploadIntro = async (file) => {
    setIntro({ busy: true, msg: null, error: null });
    const fd = new FormData();
    fd.append('audio', file);
    const { error } = await api.uploadIntroSound(fd);
    if (error) { setIntro({ busy: false, msg: null, error }); return; }
    update({ intro_sound_path: profile.intro_sound_path || 'uploaded' });
    setIntro({ busy: false, msg: 'Intro sound uploaded.', error: null });
  };
  const removeIntro = async () => {
    const { error } = await api.deleteIntroSound();
    if (error) { setIntro({ busy: false, msg: null, error }); return; }
    update({ intro_sound_path: null });
    setIntro({ busy: false, msg: 'Intro sound removed.', error: null });
  };

  const premium = (profile.subscription_tier ?? 0) >= 1;
  const avatarUrl = profile.avatar_url ? `${UPLOADS_BASE_URL}${profile.avatar_url}` : null;
  const tzChanged = timezone !== (profile.timezone || '');

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <HexBadge letter={(profile.callsign || '?')[0]} colorKey="cyan" size={44} active imageUrl={avatarUrl} />
        <div className="min-w-0 flex-1">
          <div className="text-ui-lg font-semibold truncate">{profile.callsign || '—'}</div>
          {profile.global_tag && <div className="text-ui-sm text-specter-text-subtle">[{profile.global_tag}]</div>}
        </div>
      </div>
      <Group title="Profile">
        <Field label="Avatar" hint="JPG, PNG, GIF or WebP, up to 2 MB.">
          <FileButton accept="image/jpeg,image/png,image/gif,image/webp" onFile={uploadAvatar} onSetBusy={onSetBusy}
            disabled={avatar.busy} icon={<Upload size={14} />}>
            {avatar.busy ? 'Uploading…' : avatarUrl ? 'Replace avatar' : 'Upload avatar'}
          </FileButton>
          {avatar.error && <Alert variant="error">{avatar.error}</Alert>}
          {avatar.msg && <Alert variant="success">{avatar.msg}</Alert>}
        </Field>
        <Field label="Timezone" hint="Used when scheduling operations.">
          <Picker label="Timezone" filter value={timezone} onChange={setTimezone}
            options={timezones.map((tz) => ({ value: tz, label: tz }))} />
          {tzChanged && <Button size="sm" onClick={saveTz} disabled={tzState.saving}>{tzState.saving ? 'Saving…' : 'Save timezone'}</Button>}
          {tzState.error && <Alert variant="error">{tzState.error}</Alert>}
          {tzState.msg && !tzChanged && <Alert variant="success">{tzState.msg}</Alert>}
        </Field>
        {premium && (
          <Field label="Intro sound" hint="Plays for others when you join a channel. MP3, WAV or OGG, up to 5 MB.">
            <div className="flex items-center gap-2">
              <FileButton accept="audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/webm" onFile={uploadIntro} onSetBusy={onSetBusy}
                disabled={intro.busy} icon={<Upload size={14} />}>
                {intro.busy ? 'Uploading…' : profile.intro_sound_path ? 'Replace sound' : 'Upload sound'}
              </FileButton>
              {profile.intro_sound_path && <Button size="sm" variant="ghost" onClick={removeIntro}>Remove</Button>}
            </div>
            {intro.error && <Alert variant="error">{intro.error}</Alert>}
            {intro.msg && <Alert variant="success">{intro.msg}</Alert>}
          </Field>
        )}
      </Group>
      <Group title="Session">
        <Button variant="danger" icon={<LogOut size={14} />} disabled={loggingOut}
          onClick={async () => { setLoggingOut(true); try { await onLogout?.(); } finally { setLoggingOut(false); } }}>
          {loggingOut ? 'Logging out…' : 'Log out'}
        </Button>
        <p className="text-ui-xs text-specter-text-subtle">Logs out on this computer and leaves voice.</p>
      </Group>
    </div>
  );
}

function PrivacySection() {
  return (
    <div className="space-y-5">
      <Group title="Encryption">
        <p className="text-ui-sm text-specter-text-muted">
          Channel messages are end-to-end encrypted (MLS). Your encryption keys are created and kept on this
          computer, so the server only relays messages it can&apos;t read.
        </p>
      </Group>
      {/* ── M3b SLOT: "Reset encryption identity" ─────────────────────────
          Reserved for M3b (MLS self-healing): detects unreadable local MLS
          state and offers a per-group / full identity reset. NOT implemented
          here — when M3b lands, replace this card with the real action (it
          must run through mlsSession.js's queue in the engine, via a new
          settings-bridge op, never from the strip directly). */}
      <div data-slot="m3b-reset-identity" className="rounded-ui-row border border-dashed border-specter-border px-3 py-3 space-y-1">
        <div className="text-ui-base font-medium text-specter-text-main">Reset encryption identity</div>
        <p className="text-ui-xs text-specter-text-subtle">
          Fixes channels that can no longer be decrypted on this computer. Coming in a later update.
        </p>
      </div>
    </div>
  );
}

function AboutSection({ settings, appVersion, onCheckUpdate }) {
  const [diag, setDiag] = useState({ status: 'idle', error: null });
  const [check, setCheck] = useState('idle');
  const submit = async () => {
    setDiag({ status: 'sending', error: null });
    try {
      await settings.submitDiagnostics(appVersion);
      setDiag({ status: 'ok', error: null });
    } catch (err) {
      setDiag({ status: 'err', error: err.message });
    }
  };
  return (
    <div className="space-y-5">
      <Group title="SpecterComs">
        <Row title="Version" trailing={<span className="font-mono">{appVersion || '—'}</span>} className="px-0" />
        {onCheckUpdate && (
          <div className="space-y-1.5">
            <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} disabled={check === 'checking'}
              onClick={async () => {
                setCheck('checking');
                try { await onCheckUpdate(); setCheck('done'); } catch { setCheck('failed'); }
              }}>
              Check for updates
            </Button>
            {check === 'done' && <p className="text-ui-xs text-specter-text-subtle">Checking in the background. If an update is found, &quot;Restart to update&quot; appears above the bar.</p>}
            {check === 'failed' && <p className="text-ui-xs text-red-300">The update check couldn&apos;t start.</p>}
          </div>
        )}
      </Group>
      <Group title="Diagnostics">
        <p className="text-ui-sm text-specter-text-muted">
          Sends this computer&apos;s capture, audio and app logs to the SpecterComs team, tagged with your callsign, so a problem
          you report can be matched to the server&apos;s logs.
        </p>
        <Button size="sm" onClick={submit} disabled={diag.status === 'sending'}>
          {diag.status === 'sending' ? 'Sending…' : 'Submit diagnostics'}
        </Button>
        {diag.status === 'ok' && <Alert variant="success">Diagnostics sent. Thanks!</Alert>}
        {diag.status === 'err' && <Alert variant="error">Couldn&apos;t send diagnostics: {diag.error}</Alert>}
      </Group>
    </div>
  );
}

// ── Cabinet ───────────────────────────────────────────────────────────────

/**
 * settings        useSettings() result (engine-held settings)
 * user            session user
 * appVersion      string
 * pttLive         push-to-talk key currently held (specter://ptt-active)
 * onUserChange(u) profile changed (avatar, timezone) → session.setUser
 * onLogout()      → Promise
 * onSetBusy(b)    hold the strip open while a native dialog is up
 * onCheckUpdate() → Promise (invoke updater_check_now)
 * maxHeight, onClose
 * initialSection  dev preview
 * api             defaults to the real API client (dev preview passes a mock)
 */
export default function SettingsCabinet({
  settings, user, appVersion, pttLive, onUserChange, onLogout, onSetBusy, onCheckUpdate,
  maxHeight = 560, onClose, initialSection = null, api = realApi,
}) {
  const [section, setSection] = useState(initialSection);
  const meta = SETTINGS_SECTIONS.find((s) => s.id === section);
  const v = settings.values;
  const engineBacked = section === 'audio' || section === 'overlay';

  const subtitle = {
    audio: settings.status === 'ready'
      ? (v.specter_voice_mode === 'push-to-talk' ? `Push to talk${v.specter_ptt_key ? ` · ${prettyKey(v.specter_ptt_key)}` : ''}` : `Voice activated · ${v.specter_vad_mode === 'manual' ? 'manual' : 'auto'}`)
      : 'Devices, mic, voice mode',
    overlay: settings.status === 'ready' ? `${v.specter_overlay_corner === 'top-left' ? 'Top left' : 'Top right'}${v.specter_overlay_safe_mode === '1' ? ' · safe mode' : ''}` : 'Overlay, global shortcuts',
    account: user?.callsign || 'Profile and session',
    privacy: 'End-to-end encryption',
    about: appVersion ? `Version ${appVersion}` : 'Version, diagnostics',
  };

  return (
    <div className="flex flex-col" style={{ maxHeight }}>
      <div className="flex items-center gap-1 px-2 pt-3 pb-2">
        {section ? (
          <IconButton size="sm" icon={<ChevronLeft size={16} />} label="All settings" onClick={() => setSection(null)} />
        ) : <span className="w-2" />}
        <h2 className="flex-1 min-w-0 truncate text-ui-lg font-semibold text-specter-text-main">{meta ? meta.title : 'Settings'}</h2>
        <IconButton icon={<X size={16} />} label="Close" size="sm" onClick={onClose} />
      </div>
      <div className="strip-scroll min-h-0 flex-1 px-4 pb-4">
        {settings.saveError && (
          <Alert variant="error" className="mb-3">
            {settings.saveError}
            <button type="button" className="ml-2 underline" onClick={settings.clearSaveError}>Dismiss</button>
          </Alert>
        )}
        {!section && (
          <div className="-mx-2 space-y-0.5" key="home">
            {SETTINGS_SECTIONS.map(({ id, title, Icon }) => (
              <Row key={id} icon={<Icon size={16} />} title={title} subtitle={subtitle[id]} onClick={() => setSection(id)} />
            ))}
          </div>
        )}
        {section && (
          <div key={section} className="strip-cabinet-swap space-y-4">
            {engineBacked && <EngineState settings={settings} />}
            {section === 'audio' && settings.status === 'ready' && <AudioSection settings={settings} pttLive={pttLive} />}
            {section === 'overlay' && settings.status === 'ready' && <OverlaySection settings={settings} />}
            {section === 'account' && <AccountSection user={user} api={api} onUserChange={onUserChange} onLogout={onLogout} onSetBusy={onSetBusy} />}
            {section === 'privacy' && <PrivacySection />}
            {section === 'about' && <AboutSection settings={settings} appVersion={appVersion} onCheckUpdate={onCheckUpdate} />}
          </div>
        )}
      </div>
    </div>
  );
}
