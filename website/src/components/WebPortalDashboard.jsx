import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api, UPLOADS_BASE_URL } from '../api';

const TIMEZONE_FALLBACK = ['UTC','America/New_York','America/Chicago','America/Denver','America/Los_Angeles','Europe/London','Europe/Paris','Europe/Berlin','Asia/Tokyo','Asia/Shanghai','Asia/Kolkata','Australia/Sydney','Pacific/Auckland'];
function getSupportedTimezones() {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return TIMEZONE_FALLBACK; }
}

const Button = ({ children, variant = 'primary', onClick, disabled = false, full = false }) => {
  const base = `${full ? 'w-full' : ''} px-4 py-1.5 rounded text-xs font-bold tracking-wider transition-all duration-200 uppercase font-mono`;
  const variants = {
    primary:   'bg-specter-primary-cyan text-specter-bg-surface hover:bg-specter-primary-neon hover:shadow-[0_0_10px_rgba(6,182,212,0.3)]',
    secondary: 'bg-specter-bg-panel text-specter-text-muted hover:text-specter-text-main border border-specter-bg-panel hover:border-specter-primary-dim',
    danger:    'bg-red-900/40 text-red-300 border border-red-700 hover:bg-red-900/70',
  };
  return (
    <button onClick={onClick} disabled={disabled}
      className={`${base} ${variants[variant]} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
      {children}
    </button>
  );
};

// ─── Server Discovery Tab ──────────────────────────────────────────────────────

function DiscoverTab({ onJoinedOrg }) {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [joinState, setJoinState] = useState({});
  const [joinErrors, setJoinErrors] = useState({});

  useEffect(() => {
    api.getPublicOrgs().then(({ data, error }) => {
      if (error) setError(error);
      else setServers(data.servers || []);
      setLoading(false);
    });
  }, []);

  const handleJoin = async (serverId) => {
    setJoinState(p => ({ ...p, [serverId]: 'joining' }));
    setJoinErrors(p => { const n = { ...p }; delete n[serverId]; return n; });
    const { data, error } = await api.joinOrg(serverId);
    if (error) {
      if (error.includes('Already')) { onJoinedOrg && onJoinedOrg(); return; }
      setJoinState(p => ({ ...p, [serverId]: 'error' }));
      setJoinErrors(p => ({ ...p, [serverId]: error }));
      return;
    }
    if (data?.message?.includes('Application')) {
      setJoinState(p => ({ ...p, [serverId]: 'applied' }));
    } else {
      setJoinState(p => ({ ...p, [serverId]: 'joined' }));
      onJoinedOrg && onJoinedOrg();
    }
  };

  if (loading) return <div className="text-specter-text-muted text-center py-16 text-xs font-mono">Scanning frequencies...</div>;
  if (error) return <div className="text-red-400 text-xs font-mono py-8 text-center">{error}</div>;
  if (servers.length === 0) return <div className="text-specter-text-muted text-center py-16 text-xs font-mono">No public servers detected.</div>;

  return (
    <div className="space-y-3">
      {servers.map(server => {
        const state = joinState[server.id];
        return (
          <div key={server.id} className="bg-specter-bg-panel border border-specter-primary-dim rounded p-4 flex justify-between items-center">
            <div>
              <div className="text-specter-text-main font-bold font-mono">{server.callsign}</div>
              {server.description && <div className="text-specter-text-muted text-xs mt-1">{server.description}</div>}
              <div className="text-specter-primary-cyan text-xs mt-1.5 font-mono">{server.member_count} Members</div>
              {state === 'error' && joinErrors[server.id] && <div className="text-red-400 text-xs mt-1">{joinErrors[server.id]}</div>}
            </div>
            <div className="ml-4 flex-shrink-0">
              {state === 'joining' && <Button disabled>Joining...</Button>}
              {state === 'joined'  && <Button disabled>Joined ✓</Button>}
              {state === 'applied' && <Button disabled variant="secondary">Pending</Button>}
              {(!state || state === 'error') && <Button onClick={() => handleJoin(server.id)}>Join</Button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Tier definitions (keep in sync with identity-node/src/utils/orgTiers.ts) ──

const TIERS = [
  {
    id: 0,
    name: 'Free Trial',
    price: '$0/mo',
    data: '30 GB',
    resolution: '720p',
    color: '#0e7490',
    glow: '#22d3ee',
  },
  {
    id: 1,
    name: 'Ops Starter',
    price: '$19/mo',
    data: '1,000 GB',
    resolution: '1080p',
    color: '#7c3aed',
    glow: '#c084fc',
  },
  {
    id: 2,
    name: 'Ops Growth',
    price: '$49/mo',
    data: '5,000 GB',
    resolution: '1440p',
    color: '#b45309',
    glow: '#fbbf24',
  },
  {
    id: 3,
    name: 'Ops Command',
    price: '$149/mo',
    data: '20,000 GB',
    resolution: '1440p60',
    color: '#dc2626',
    glow: '#f87171',
  },
];

// ─── Server Manage Panel ───────────────────────────────────────────────────────

function ServerManagePanel({ org, onUpdated }) {
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState(null);
  const [saved, setSaved]         = useState(false);
  const [logoStatus, setLogoStatus] = useState('idle');
  const [logoMsg, setLogoMsg]       = useState('');
  const [logoPreview, setLogoPreview] = useState(org.logo_url ? `${UPLOADS_BASE_URL}${org.logo_url}` : null);
  const logoFileRef = useRef(null);
  const currentTier = org.tier ?? 0;
  const [section, setSection] = useState('channels');
  const [channels, setChannels] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loadingData, setLoadingData] = useState(false);
  const [panelMsg, setPanelMsg] = useState('');
  const [channelForm, setChannelForm] = useState({ name: '', channel_kind: '0', parent_channel_id: '' });
  const [roleForm, setRoleForm] = useState({ name: '' });
  const [landingForm, setLandingForm] = useState({
    description: org.description || '',
    landing_description: org.landing_description || '',
    show_calendar_on_landing: org.show_calendar_on_landing !== false,
  });
  const [roleDrafts, setRoleDrafts] = useState({});

  const loadManagerData = useCallback(async () => {
    setLoadingData(true);
    setError(null);
    const [channelRes, roleRes] = await Promise.all([
      api.getChannels(org.id),
      api.getRoles(org.id),
    ]);
    setLoadingData(false);
    if (channelRes.error) { setError(channelRes.error); return; }
    if (roleRes.error) { setError(roleRes.error); return; }
    setChannels(channelRes.data?.channels || []);
    setRoles(roleRes.data?.roles || []);
    setRoleDrafts((roleRes.data?.roles || []).reduce((acc, role) => {
      acc[role.id] = role.name || role.role_name || '';
      return acc;
    }, {}));
  }, [org.id]);

  useEffect(() => {
    setLogoPreview(org.logo_url ? `${UPLOADS_BASE_URL}${org.logo_url}` : null);
    setLandingForm({
      description: org.description || '',
      landing_description: org.landing_description || '',
      show_calendar_on_landing: org.show_calendar_on_landing !== false,
    });
    loadManagerData();
  }, [org.id, org.logo_url, org.description, org.landing_description, org.show_calendar_on_landing, loadManagerData]);

  const showMessage = (msg) => {
    setPanelMsg(msg);
    setTimeout(() => setPanelMsg(''), 2500);
  };

  const handleTierSelect = async (tierId) => {
    if (tierId === currentTier) return;
    setError(null); setSaved(false); setSaving(true);
    const { error } = await api.updateOrgSettings(org.id, { tier: tierId });
    setSaving(false);
    if (error) { setError(error); return; }
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
    onUpdated();
  };

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoStatus('uploading'); setLogoMsg('');
    const formData = new FormData();
    formData.append('image', file);
    const { data, error } = await api.uploadOrgLogo(org.id, formData);
    if (error) {
      setLogoStatus('err'); setLogoMsg(error);
    } else {
      setLogoStatus('ok'); setLogoMsg('Logo updated.');
      setLogoPreview(`${UPLOADS_BASE_URL}${data.logo_url}`);
      onUpdated();
    }
    if (logoFileRef.current) logoFileRef.current.value = '';
  };

  const handleCreateChannel = async () => {
    if (!channelForm.name.trim()) return setError('Channel name is required.');
    setSaving(true); setError(null);
    const payload = {
      name: channelForm.name.trim(),
      channel_kind: Number(channelForm.channel_kind || 0),
      parent_channel_id: channelForm.parent_channel_id || null,
    };
    const { error } = await api.createChannel(org.id, payload);
    setSaving(false);
    if (error) { setError(error); return; }
    setChannelForm({ name: '', channel_kind: '0', parent_channel_id: '' });
    showMessage('Channel created.');
    loadManagerData();
    onUpdated();
  };

  const handleDeleteChannel = async (channelId, channelName) => {
    if (!window.confirm(`Delete channel "${channelName}"?`)) return;
    setSaving(true); setError(null);
    const { error } = await api.deleteChannel(org.id, channelId);
    setSaving(false);
    if (error) { setError(error); return; }
    showMessage('Channel deleted.');
    loadManagerData();
    onUpdated();
  };

  const handleCreateRole = async () => {
    if (!roleForm.name.trim()) return setError('Role name is required.');
    setSaving(true); setError(null);
    const { error } = await api.createRole(org.id, { name: roleForm.name.trim() });
    setSaving(false);
    if (error) { setError(error); return; }
    setRoleForm({ name: '' });
    showMessage('Role created.');
    loadManagerData();
    onUpdated();
  };

  const handleSaveRole = async (role) => {
    const nextName = (roleDrafts[role.id] || '').trim();
    if (!nextName) return setError('Role name cannot be empty.');
    setSaving(true); setError(null);
    const { error } = await api.updateRole(org.id, role.id, { name: nextName });
    setSaving(false);
    if (error) { setError(error); return; }
    showMessage('Role updated.');
    loadManagerData();
    onUpdated();
  };

  const handleDeleteRole = async (role) => {
    if (!window.confirm(`Delete role "${role.name || role.role_name || 'Role'}"?`)) return;
    setSaving(true); setError(null);
    const { error } = await api.deleteRole(org.id, role.id);
    setSaving(false);
    if (error) { setError(error); return; }
    showMessage('Role deleted.');
    loadManagerData();
    onUpdated();
  };

  const handleSaveLanding = async () => {
    setSaving(true); setError(null);
    const { error } = await api.updateOrgLanding(org.id, landingForm);
    setSaving(false);
    if (error) { setError(error); return; }
    showMessage('Landing page updated.');
    onUpdated();
  };

  const tabButtonClass = (active) => `px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] rounded-full border transition-all ${active ? 'bg-specter-primary-cyan text-specter-bg-surface border-specter-primary-cyan shadow-[0_0_12px_rgba(6,182,212,0.28)]' : 'border-specter-primary-dim text-specter-text-muted hover:text-specter-text-main hover:border-specter-primary-cyan/40'}`;

  return (
    <div className="mt-3 pt-3 border-t border-specter-primary-dim/40 space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-3 items-start">
        <div className="space-y-2">
          <div className="text-specter-text-muted text-xs uppercase tracking-wider mb-1">Server Branding</div>
          <div className="flex items-center gap-3 flex-wrap">
            {logoPreview && (
              <img src={logoPreview} alt="logo" className="w-10 h-10 object-cover rounded-xl" style={{ boxShadow: '0 0 0 1px rgba(34,211,238,0.18), 0 0 18px rgba(6,182,212,0.22)' }} />
            )}
            <input ref={logoFileRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden" onChange={handleLogoUpload} />
            <Button variant="secondary" onClick={() => logoFileRef.current?.click()} disabled={logoStatus === 'uploading'}>
              {logoStatus === 'uploading' ? 'Uploading...' : logoPreview ? 'Replace Logo' : 'Upload Logo'}
            </Button>
            <div className="text-specter-text-muted text-[10px]">jpg/png/gif/webp, max 2 MB. Replaces the server badge in the app.</div>
          </div>
        </div>
        <div className="space-y-2">
        <div className="text-[11px] font-mono uppercase tracking-wider px-3 py-2 rounded border"
             style={{ color: '#fbbf24', borderColor: '#b4530966', background: '#b4530912' }}>
          Billing is not yet active — plan selection is free during development. No charges will be made until launch.
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          {TIERS.map(t => {
            const isActive = t.id === currentTier;
            return (
              <button
                key={t.id}
                onClick={() => handleTierSelect(t.id)}
                disabled={saving}
                className="text-left rounded-2xl border p-3 transition-all cursor-pointer disabled:opacity-50"
                style={{
                  background: isActive ? `${t.color}22` : 'rgba(2,8,16,0.55)',
                  borderColor: isActive ? t.glow : 'rgba(14,34,51,0.85)',
                  boxShadow: isActive ? `0 0 0 1px ${t.glow}33, 0 0 18px ${t.glow}24` : '0 0 0 1px rgba(6,182,212,0.05)',
                }}
              >
                <div className="text-xs font-bold font-mono tracking-wider mb-1.5" style={{ color: isActive ? t.glow : '#94a3b8' }}>
                  {t.name}
                  {isActive && <span className="ml-1.5 text-[9px] opacity-70">● ACTIVE</span>}
                </div>
                <div className="space-y-0.5">
                  {[
                    ['Price', t.price],
                    ['Data/cycle', t.data],
                    ['Video', t.resolution],
                  ].map(([label, val]) => (
                    <div key={label} className="flex justify-between text-[10px] font-mono">
                      <span style={{ color: '#475569' }}>{label}</span>
                      <span style={{ color: isActive ? t.glow : '#64748b' }}>{val}</span>
                    </div>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {['channels', 'roles', 'landing'].map(tabName => (
          <button key={tabName} onClick={() => setSection(tabName)} className={tabButtonClass(section === tabName)}>
            {tabName}
          </button>
        ))}
      </div>

      {panelMsg && <div className="text-green-400 text-xs font-mono">{panelMsg}</div>}
      {error && <div className="text-red-400 text-xs font-mono">{error}</div>}

      {section === 'channels' && (
        <div className="space-y-3 rounded-2xl border border-specter-primary-dim/30 bg-specter-bg-surface/80 p-4 shadow-[0_0_24px_rgba(6,182,212,0.08)]">
          <div className="text-specter-text-muted text-xs uppercase tracking-wider">Channels</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <input
              value={channelForm.name}
              onChange={e => setChannelForm(p => ({ ...p, name: e.target.value }))}
              className="bg-black border border-specter-primary-dim rounded-xl focus:border-specter-primary-cyan focus:outline-none px-3 py-2 text-specter-text-main text-xs placeholder-specter-text-muted"
              placeholder="Channel name"
            />
            <select
              value={channelForm.channel_kind}
              onChange={e => setChannelForm(p => ({ ...p, channel_kind: e.target.value }))}
              className="bg-black border border-specter-primary-dim rounded-xl focus:border-specter-primary-cyan focus:outline-none px-3 py-2 text-specter-text-main text-xs"
            >
              <option value="0">Voice</option>
              <option value="1">Text</option>
            </select>
            <select
              value={channelForm.parent_channel_id}
              onChange={e => setChannelForm(p => ({ ...p, parent_channel_id: e.target.value }))}
              className="bg-black border border-specter-primary-dim rounded-xl focus:border-specter-primary-cyan focus:outline-none px-3 py-2 text-specter-text-main text-xs"
            >
              <option value="">No parent</option>
              {channels.filter(ch => Number(ch.channel_kind ?? 0) === 0).map(ch => (
                <option key={ch.id} value={ch.id}>{ch.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-end">
            <Button onClick={handleCreateChannel} disabled={saving || loadingData}>Create Channel</Button>
          </div>
          <div className="space-y-2">
            {channels.length === 0 && <div className="text-specter-text-muted text-xs italic">No channels yet.</div>}
            {channels.map(ch => (
              <div key={ch.id} className="flex items-center justify-between gap-3 rounded-xl border border-specter-primary-dim/30 bg-black/30 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-specter-text-main text-sm font-semibold truncate">{ch.name}</div>
                  <div className="text-[10px] uppercase tracking-wider text-specter-text-muted">
                    {Number(ch.channel_kind ?? 0) === 0 ? 'Voice' : 'Text'}{ch.parent_channel_id ? ' · child channel' : ''}
                  </div>
                </div>
                <Button variant="danger" small onClick={() => handleDeleteChannel(ch.id, ch.name)} disabled={saving}>Delete</Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {section === 'roles' && (
        <div className="space-y-3 rounded-2xl border border-specter-primary-dim/30 bg-specter-bg-surface/80 p-4 shadow-[0_0_24px_rgba(6,182,212,0.08)]">
          <div className="text-specter-text-muted text-xs uppercase tracking-wider">Roles</div>
          <div className="flex items-center gap-2">
            <input
              value={roleForm.name}
              onChange={e => setRoleForm({ name: e.target.value })}
              className="flex-1 bg-black border border-specter-primary-dim rounded-xl focus:border-specter-primary-cyan focus:outline-none px-3 py-2 text-specter-text-main text-xs placeholder-specter-text-muted"
              placeholder="New role name"
            />
            <Button onClick={handleCreateRole} disabled={saving || loadingData}>Create Role</Button>
          </div>
          <div className="space-y-2">
            {roles.length === 0 && <div className="text-specter-text-muted text-xs italic">No roles yet.</div>}
            {roles.map(role => (
              <div key={role.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 rounded-xl border border-specter-primary-dim/30 bg-black/30 px-3 py-2">
                <input
                  value={roleDrafts[role.id] ?? role.name ?? role.role_name ?? ''}
                  onChange={e => setRoleDrafts(p => ({ ...p, [role.id]: e.target.value }))}
                  className="w-full bg-transparent border border-transparent focus:border-specter-primary-cyan rounded-lg px-2 py-1 text-specter-text-main text-xs outline-none"
                />
                <Button small onClick={() => handleSaveRole(role)} disabled={saving}>Save</Button>
                <Button small variant="danger" onClick={() => handleDeleteRole(role)} disabled={saving}>Delete</Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {section === 'landing' && (
        <div className="space-y-3 rounded-2xl border border-specter-primary-dim/30 bg-specter-bg-surface/80 p-4 shadow-[0_0_24px_rgba(6,182,212,0.08)]">
          <div className="text-specter-text-muted text-xs uppercase tracking-wider">Landing Page Layout</div>
          <div className="space-y-2">
            <label className="block text-xs text-specter-text-muted">Server Summary</label>
            <textarea
              value={landingForm.description}
              onChange={e => setLandingForm(p => ({ ...p, description: e.target.value }))}
              rows={3}
              className="w-full bg-black border border-specter-primary-dim rounded-xl focus:border-specter-primary-cyan focus:outline-none px-3 py-2 text-specter-text-main text-xs resize-y"
              placeholder="Short summary shown at the top of the server landing page"
            />
          </div>
          <div className="space-y-2">
            <label className="block text-xs text-specter-text-muted">Landing Content</label>
            <textarea
              value={landingForm.landing_description}
              onChange={e => setLandingForm(p => ({ ...p, landing_description: e.target.value }))}
              rows={7}
              className="w-full bg-black border border-specter-primary-dim rounded-xl focus:border-specter-primary-cyan focus:outline-none px-3 py-2 text-specter-text-main text-xs resize-y"
              placeholder="Rules, welcome text, onboarding steps, and server-specific content"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-specter-text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={landingForm.show_calendar_on_landing}
              onChange={e => setLandingForm(p => ({ ...p, show_calendar_on_landing: e.target.checked }))}
            />
            Show operations calendar on the landing page
          </label>
          <div className="flex items-center justify-end">
            <Button onClick={handleSaveLanding} disabled={saving}>Save Landing Page</Button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-specter-text-muted">
        <span>Changes apply to the server landing page and desktop app entry point.</span>
        {loadingData && <span>Loading server data...</span>}
      </div>

      {saved && <div className="text-green-400 text-xs font-mono">Tier updated.</div>}
    </div>
  );
}

// ─── My Servers Tab ────────────────────────────────────────────────────────────

function CreateServerPanel({ onCreated, onCancel }) {
  const [form, setForm] = useState({ callsign: '', description: '', is_public: false, join_method: '0' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleCreate = async () => {
    if (form.callsign.trim().length < 3) return setError('Server name must be at least 3 characters.');
    setSaving(true); setError(null);
    const { error } = await api.createOrg({
      callsign: form.callsign.trim(),
      description: form.description.trim(),
      is_public: form.is_public,
      join_method: Number(form.join_method),
    });
    setSaving(false);
    if (error) { setError(error); return; }
    onCreated();
  };

  return (
    <div className="space-y-3 rounded-2xl border border-specter-primary-dim/30 bg-specter-bg-surface/80 p-4 shadow-[0_0_24px_rgba(6,182,212,0.08)]">
      <div className="text-specter-text-muted text-xs uppercase tracking-wider">New Server</div>
      <input
        value={form.callsign}
        onChange={e => setForm(p => ({ ...p, callsign: e.target.value }))}
        className="w-full bg-black border border-specter-primary-dim rounded-xl focus:border-specter-primary-cyan focus:outline-none px-3 py-2 text-specter-text-main text-xs placeholder-specter-text-muted"
        placeholder="Server name"
        maxLength={64}
      />
      <textarea
        value={form.description}
        onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
        rows={2}
        className="w-full bg-black border border-specter-primary-dim rounded-xl focus:border-specter-primary-cyan focus:outline-none px-3 py-2 text-specter-text-main text-xs resize-y placeholder-specter-text-muted"
        placeholder="Short description (optional)"
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <select
          value={form.join_method}
          onChange={e => setForm(p => ({ ...p, join_method: e.target.value }))}
          className="bg-black border border-specter-primary-dim rounded-xl focus:border-specter-primary-cyan focus:outline-none px-3 py-2 text-specter-text-main text-xs"
        >
          <option value="0">Open — anyone can join</option>
          <option value="1">Application — approval required</option>
          <option value="2">Invite Only</option>
        </select>
        <label className="flex items-center gap-2 text-xs text-specter-text-muted cursor-pointer select-none px-3">
          <input
            type="checkbox"
            checked={form.is_public}
            onChange={e => setForm(p => ({ ...p, is_public: e.target.checked }))}
          />
          List in Discover
        </label>
      </div>
      {error && <div className="text-red-400 text-xs font-mono">{error}</div>}
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button onClick={handleCreate} disabled={saving}>{saving ? 'Creating...' : 'Create Server'}</Button>
      </div>
    </div>
  );
}

function MyServersTab({ user }) {
  const [orgs, setOrgs]             = useState([]);
  const [loading, setLoading]       = useState(true);
  const [managingId, setManagingId] = useState(null);
  const [creating, setCreating]     = useState(false);

  const load = () => {
    setLoading(true);
    api.getMyOrgs().then(({ data }) => {
      setOrgs(data?.orgs || data?.servers || []);
      setLoading(false);
    });
  };
  useEffect(load, []);

  if (loading) return <div className="text-specter-text-muted text-center py-16 text-xs font-mono">Loading...</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-specter-text-muted text-xs uppercase tracking-wider">
          {orgs.length} server{orgs.length === 1 ? '' : 's'}
        </span>
        {!creating && <Button onClick={() => setCreating(true)}>+ Create Server</Button>}
      </div>

      {creating && (
        <CreateServerPanel
          onCancel={() => setCreating(false)}
          onCreated={() => { setCreating(false); load(); }}
        />
      )}

      {orgs.length === 0 && !creating && (
        <div className="text-specter-text-muted text-center py-16 text-xs font-mono">
          You haven't joined any servers yet.<br />
          <span className="text-specter-primary-dim">Use the Discover tab to find public servers, or create your own above.</span>
        </div>
      )}

      {orgs.map(org => {
        const isOwner  = org.owner_id === user?.id;
        const managing = managingId === org.id;
        const tier     = TIERS[org.tier ?? 0] || TIERS[0];
        return (
          <div key={org.id} className="bg-specter-bg-panel border border-specter-primary-dim rounded p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-specter-text-main font-bold font-mono">{org.callsign || org.name}</div>
                {org.description && <div className="text-specter-text-muted text-xs mt-0.5">{org.description}</div>}
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-specter-primary-dim text-xs font-mono uppercase">{org.role_name || org.role || 'Member'}</span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border" style={{ color: tier.glow, borderColor: tier.color + '66', background: tier.color + '18' }}>
                    {tier.name}
                  </span>
                </div>
              </div>
              {isOwner && (
                <button
                  onClick={() => setManagingId(managing ? null : org.id)}
                  className="text-xs font-mono uppercase tracking-wider px-3 py-1.5 rounded border transition-all flex-shrink-0"
                  style={{
                    borderColor: managing ? '#0891b2' : '#0e2233',
                    color: managing ? '#22d3ee' : '#475569',
                    background: managing ? '#041e2e' : 'transparent',
                  }}
                >
                  {managing ? 'Done' : 'Manage'}
                </button>
              )}
            </div>
            {managing && isOwner && (
              <ServerManagePanel org={org} onUpdated={load} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Account Tab ──────────────────────────────────────────────────────────────

function AccountTab({ user }) {
  const [timezone, setTimezone]       = useState(user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [timezones] = useState(getSupportedTimezones);
  const [loading, setLoading]         = useState(false);
  const [saved, setSaved]             = useState(false);
  const [error, setError]             = useState(null);
  const [avatarStatus, setAvatarStatus] = useState('idle');
  const [avatarMsg, setAvatarMsg]       = useState('');
  const [avatarPreview, setAvatarPreview] = useState(user?.avatar_url ? `${UPLOADS_BASE_URL}${user.avatar_url}` : null);
  const avatarFileRef = useRef(null);

  useEffect(() => {
    api.getMyProfile().then(res => {
      if (res.data?.user?.timezone) setTimezone(res.data.user.timezone);
      if (res.data?.user?.avatar_url) setAvatarPreview(`${UPLOADS_BASE_URL}${res.data.user.avatar_url}`);
    });
  }, []);

  const handleAvatarUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarStatus('uploading'); setAvatarMsg('');
    const formData = new FormData();
    formData.append('image', file);
    const { data, error } = await api.uploadAvatar(formData);
    if (error) {
      setAvatarStatus('err'); setAvatarMsg(error);
    } else {
      setAvatarStatus('ok'); setAvatarMsg('Avatar updated.');
      setAvatarPreview(`${UPLOADS_BASE_URL}${data.avatar_url}`);
      try {
        const stored = JSON.parse(localStorage.getItem('specter_user') || '{}');
        localStorage.setItem('specter_user', JSON.stringify({ ...stored, avatar_url: data.avatar_url }));
      } catch {}
    }
    if (avatarFileRef.current) avatarFileRef.current.value = '';
  };

  const handleSave = async () => {
    setError(null); setSaved(false); setLoading(true);
    const res = await api.updateProfile({ timezone });
    setLoading(false);
    if (res.error) { setError(res.error); return; }
    try {
      const stored = JSON.parse(localStorage.getItem('specter_user') || '{}');
      localStorage.setItem('specter_user', JSON.stringify({ ...stored, timezone }));
    } catch {}
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="max-w-md space-y-5">
      <div className="bg-specter-bg-panel border border-specter-primary-dim rounded p-4 space-y-3">
        <div className="text-specter-text-muted text-xs uppercase tracking-wider mb-1">Identity</div>
        <div className="flex justify-between text-xs font-mono">
          <span className="text-specter-text-muted">Callsign</span>
          <span className="text-specter-text-main">{user?.callsign || '—'}</span>
        </div>
        <div className="flex justify-between text-xs font-mono">
          <span className="text-specter-text-muted">Email</span>
          <span className="text-specter-text-main">{user?.email || '—'}</span>
        </div>
        <div className="flex justify-between text-xs font-mono">
          <span className="text-specter-text-muted">Account Type</span>
          <span className="text-specter-primary-cyan uppercase">{user?.tier || 'Standard'}</span>
        </div>
      </div>

      <div className="bg-specter-bg-panel border border-specter-primary-dim rounded p-4 space-y-3">
        <div className="text-specter-text-muted text-xs uppercase tracking-wider mb-1">Avatar</div>
        <div className="flex items-center gap-4">
          {avatarPreview ? (
            <img src={avatarPreview} alt="avatar" className="w-12 h-12 object-cover rounded" />
          ) : (
            <div className="w-12 h-12 rounded border border-specter-primary-dim flex items-center justify-center text-specter-text-muted text-lg font-mono">
              {(user?.callsign || '?')[0].toUpperCase()}
            </div>
          )}
          <div className="space-y-1">
            <input ref={avatarFileRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden" onChange={handleAvatarUpload} />
            <Button variant="secondary" onClick={() => avatarFileRef.current?.click()} disabled={avatarStatus === 'uploading'}>
              {avatarStatus === 'uploading' ? 'Uploading...' : avatarPreview ? 'Replace Avatar' : 'Upload Avatar'}
            </Button>
            {avatarMsg && <div className={`text-xs font-mono ${avatarStatus === 'err' ? 'text-red-400' : 'text-green-400'}`}>{avatarMsg}</div>}
            <div className="text-specter-text-muted text-[10px]">jpg/png/gif/webp, max 2 MB</div>
          </div>
        </div>
      </div>

      <div className="bg-specter-bg-panel border border-specter-primary-dim rounded p-4 space-y-3">
        <div className="text-specter-text-muted text-xs uppercase tracking-wider mb-1">Preferences</div>
        <div>
          <label className="block text-xs text-specter-text-muted mb-1">Timezone</label>
          <select
            value={timezone}
            onChange={e => setTimezone(e.target.value)}
            className="w-full bg-black border border-specter-primary-dim text-xs p-2 focus:border-specter-primary-cyan outline-none text-specter-text-main font-mono"
          >
            {timezones.map(tz => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </div>
        {error && <div className="text-red-400 text-xs">{error}</div>}
        <div className="flex items-center gap-3 justify-end">
          {saved && <span className="text-xs font-mono text-green-400">Saved.</span>}
          <Button onClick={handleSave} disabled={loading}>{loading ? 'Saving...' : 'Save'}</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Billing Tab ──────────────────────────────────────────────────────────────

function BillingTab() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="text-specter-primary-dim font-mono text-xs uppercase tracking-widest mb-2">Coming Soon</div>
      <div className="text-specter-text-muted text-xs font-mono max-w-xs">
        Billing history, subscription management, and invoices will be available here in a future update.
      </div>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

const TABS = [
  { id: 'servers',  label: 'My Servers' },
  { id: 'discover', label: 'Discover' },
  { id: 'account',  label: 'Account' },
  { id: 'billing',  label: 'Billing' },
];

const WebPortalDashboard = ({ user, onLogout }) => {
  const [tab, setTab] = useState('servers');

  return (
    <div className="min-h-screen bg-specter-bg-deep font-mono text-specter-text-main flex flex-col relative overflow-x-hidden">
      {/* Background — same SpecterBG treatment as the homepage, for a unified feel across the app */}
      <div
        className="fixed inset-0 bg-cover bg-center pointer-events-none"
        style={{ backgroundImage: "url('/SpecterBG.png')", opacity: 0.5 }}
      />
      <div className="relative z-10 flex flex-col flex-1">
        {/* Top bar */}
        <header className="border-b border-specter-primary-dim bg-specter-bg-surface/90 backdrop-blur-sm px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-specter-primary-cyan font-bold tracking-widest uppercase text-sm">SPECTERCOMS</span>
            <span className="text-specter-primary-dim text-xs opacity-60">Web Portal</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-specter-text-muted text-xs">{user?.callsign || user?.email}</span>
            <Button variant="secondary" onClick={onLogout}>Log Out</Button>
          </div>
        </header>

        {/* Nav tabs */}
        <nav className="border-b border-specter-primary-dim bg-specter-bg-surface/90 backdrop-blur-sm px-6 flex gap-1">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-3 text-xs uppercase tracking-wider font-mono transition-colors border-b-2 -mb-px ${
                tab === t.id
                  ? 'text-specter-primary-cyan border-specter-primary-cyan'
                  : 'text-specter-text-muted border-transparent hover:text-specter-text-main'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <main className="flex-1 px-6 py-6 max-w-3xl w-full mx-auto">
          {tab === 'servers'  && <MyServersTab user={user} />}
          {tab === 'discover' && <DiscoverTab onJoinedOrg={() => setTab('servers')} />}
          {tab === 'account'  && <AccountTab user={user} />}
          {tab === 'billing'  && <BillingTab />}
        </main>

        {/* Footer prompt to download app */}
        <footer className="border-t border-specter-primary-dim/30 px-6 py-4 text-center">
          <span className="text-specter-text-muted text-xs">
            Voice, events, and real-time comms require the{' '}
            <a
              href="/api/downloads?platform=windows"
              className="text-specter-primary-cyan hover:text-specter-primary-neon underline-offset-2 hover:underline"
            >
              SpecterComs desktop app
            </a>.
          </span>
        </footer>
      </div>
    </div>
  );
};

export default WebPortalDashboard;
