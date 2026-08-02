// OrgSettings.jsx — Server management overlay for org owners/admins
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api';

const TABS = ['general', 'roles', 'members', 'bans', 'channels', 'landing', 'billing'];

const S = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 50,
    background: 'rgba(0,0,0,0.7)', display: 'flex',
    alignItems: 'center', justifyContent: 'center',
  },
  panel: {
    width: 720, maxWidth: '95vw', maxHeight: '85vh',
    background: '#0a1420', border: '1px solid #0e2233',
    borderRadius: 6, display: 'flex', flexDirection: 'column',
    overflow: 'hidden', boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 20px', borderBottom: '1px solid #0e2233', flexShrink: 0,
  },
  title: { fontSize: 14, fontWeight: 'bold', color: '#67e8f9', letterSpacing: '0.15em' },
  closeBtn: {
    background: 'none', border: 'none', color: '#0e7490', cursor: 'pointer',
    fontSize: 18, padding: '0 4px', transition: 'color 0.15s',
  },
  tabs: {
    display: 'flex', gap: 0, borderBottom: '1px solid #0e2233', flexShrink: 0,
  },
  tab: (active) => ({
    padding: '8px 16px', fontSize: 11, letterSpacing: '0.2em', cursor: 'pointer',
    background: active ? '#041e2e' : 'transparent',
    color: active ? '#22d3ee' : '#0e7490',
    borderBottom: active ? '2px solid #0891b2' : '2px solid transparent',
    transition: 'all 0.15s', textTransform: 'uppercase', fontFamily: 'monospace',
    border: 'none', borderBottomWidth: 2, borderBottomStyle: 'solid',
    borderBottomColor: active ? '#0891b2' : 'transparent',
  }),
  body: { flex: 1, overflow: 'auto', padding: '16px 20px' },
  label: { fontSize: 11, color: '#0e7490', letterSpacing: '0.25em', marginBottom: 4, display: 'block' },
  input: {
    width: '100%', background: '#041018', border: '1px solid #0e2233', borderRadius: 3,
    padding: '6px 10px', fontSize: 12, color: '#e5e7eb', outline: 'none', fontFamily: 'monospace',
  },
  btnCyan: {
    fontSize: 11, padding: '6px 14px', borderRadius: 3, letterSpacing: '0.15em',
    background: '#041e2e', border: '1px solid #0891b2', color: '#22d3ee', cursor: 'pointer',
  },
  btnDim: {
    fontSize: 11, padding: '6px 14px', borderRadius: 3, letterSpacing: '0.15em',
    background: 'transparent', border: '1px solid #0e2233', color: '#9ca3af', cursor: 'pointer',
  },
  btnDanger: {
    fontSize: 11, padding: '6px 14px', borderRadius: 3, letterSpacing: '0.15em',
    background: '#1c0a0a', border: '1px solid #450a0a', color: '#ef4444', cursor: 'pointer',
  },
  row: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
    borderBottom: '1px solid #0a131c',
  },
  sectionLabel: {
    fontSize: 11, color: '#0e7490', letterSpacing: '0.3em', marginBottom: 8, marginTop: 16,
  },
};

// ── Permission definitions ──────────────────────────────────────────────────
const PERMISSION_DEFS = [
  { key: 'can_view_calendar', label: 'View Ops Calendar' },
  { key: 'can_kick', label: 'Kick Members' },
  { key: 'can_ban', label: 'Ban Members' },
  { key: 'can_manage_roles', label: 'Manage Roles' },
  { key: 'can_manage_channels', label: 'Manage Channels' },
  { key: 'can_invite', label: 'Create Invites' },
  { key: 'can_create_events', label: 'Create Operations' },
];

// ── General Tab ─────────────────────────────────────────────────────────────
function GeneralTab({ org, onSaved }) {
  const [callsign, setCallsign] = useState(org.callsign || '');
  const [description, setDescription] = useState(org.description || '');
  const [isPublic, setIsPublic] = useState(org.is_public ?? false);
  const [joinMethod, setJoinMethod] = useState(org.join_method ?? 0);
  const [tier, setTier] = useState(org.tier ?? 0);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [inviteCode, setInviteCode] = useState(null);

  const handleSave = async () => {
    setSaving(true); setMsg(null);
    const { error } = await api.updateOrgSettings(org.id, {
      callsign, description, is_public: isPublic, join_method: joinMethod, tier,
    });
    setSaving(false);
    if (error) setMsg({ type: 'error', text: error });
    else { setMsg({ type: 'ok', text: 'Settings saved' }); onSaved?.(); }
  };

  const handleCreateInvite = async () => {
    const { data, error } = await api.createInvite(org.id);
    if (error) setMsg({ type: 'error', text: error });
    else setInviteCode(data?.code || data?.invite?.code || JSON.stringify(data));
  };

  return (
    <div style={{ maxWidth: 460 }}>
      <div style={{ marginBottom: 14 }}>
        <label style={S.label}>SERVER NAME</label>
        <input value={callsign} onChange={e => setCallsign(e.target.value)} style={S.input} maxLength={32} />
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={S.label}>DESCRIPTION</label>
        <textarea value={description} onChange={e => setDescription(e.target.value)}
          style={{ ...S.input, height: 60, resize: 'vertical' }} maxLength={500} />
      </div>
      <div style={{ marginBottom: 14, display: 'flex', gap: 16 }}>
        <label style={{ fontSize: 12, color: '#e5e7eb', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={isPublic} onChange={e => setIsPublic(e.target.checked)} /> Public Server
        </label>
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={S.label}>JOIN METHOD</label>
        <select value={joinMethod} onChange={e => setJoinMethod(Number(e.target.value))}
          style={{ ...S.input, padding: '5px 8px' }}>
          <option value={0}>Open</option>
          <option value={1}>Application</option>
          <option value={2}>Invite Only</option>
        </select>
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={S.label}>STREAM QUALITY</label>
        <select value={tier} onChange={e => setTier(Number(e.target.value))}
          style={{ ...S.input, padding: '5px 8px' }}>
          <option value={0}>Standard — 1080p 30fps (5 Mbps)</option>
          <option value={1}>Premium — 1080p 60fps (10 Mbps)</option>
          <option value={2}>Ultra — 1440p 60fps (20 Mbps)</option>
        </select>
        <div style={{ fontSize: 10, color: '#4b6272', marginTop: 4, fontFamily: 'monospace' }}>
          Sets the screen share quality ceiling for all members. Ultra will be paywall-gated in a future update.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button onClick={handleSave} disabled={saving} style={{ ...S.btnCyan, opacity: saving ? 0.5 : 1 }}>
          {saving ? 'SAVING...' : 'SAVE SETTINGS'}
        </button>
        <button onClick={handleCreateInvite} style={S.btnDim}>
          GENERATE INVITE
        </button>
      </div>
      {inviteCode && (
        <div style={{ fontSize: 12, color: '#22d3ee', background: '#041e2e', padding: '8px 12px', borderRadius: 3, fontFamily: 'monospace', marginBottom: 8 }}>
          Invite Code: <strong>{inviteCode}</strong>
        </div>
      )}
      {msg && (
        <div style={{ fontSize: 11, color: msg.type === 'error' ? '#ef4444' : '#4ade80' }}>{msg.text}</div>
      )}
    </div>
  );
}

// ── Roles Tab ───────────────────────────────────────────────────────────────
function RolesTab({ org }) {
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editRole, setEditRole] = useState(null);
  const [newName, setNewName] = useState('');
  const [newPerms, setNewPerms] = useState({});
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createPerms, setCreatePerms] = useState({});

  const load = useCallback(async () => {
    const { data } = await api.getRoles(org.id);
    setRoles(Array.isArray(data) ? data : (data?.roles || []));
    setLoading(false);
  }, [org.id]);

  useEffect(() => { load(); }, [load]);

  const handleEdit = (role) => {
    setEditRole(role);
    setNewName(role.name);
    const perms = typeof role.permissions === 'string' ? JSON.parse(role.permissions) : (role.permissions || {});
    setNewPerms(perms);
  };

  const handleSave = async () => {
    if (!editRole) return;
    await api.updateRole(org.id, editRole.id, { name: newName, permissions: newPerms });
    setEditRole(null);
    load();
  };

  const handleDelete = async (roleId) => {
    if (!confirm('Delete this role? Members will lose it.')) return;
    await api.deleteRole(org.id, roleId);
    if (editRole?.id === roleId) setEditRole(null);
    load();
  };

  const handleCreate = async () => {
    if (!createName.trim()) return;
    await api.createRole(org.id, { name: createName.trim(), permissions: createPerms });
    setCreateName(''); setCreatePerms({}); setShowCreate(false);
    load();
  };

  if (loading) return <div style={{ color: '#0e7490', fontSize: 12 }}>Loading roles...</div>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={S.sectionLabel}>ROLES ({roles.length})</span>
        <button onClick={() => setShowCreate(v => !v)} style={S.btnCyan}>+ NEW ROLE</button>
      </div>

      {showCreate && (
        <div style={{ background: '#041018', border: '1px solid #0e2233', borderRadius: 4, padding: 12, marginBottom: 12 }}>
          <input value={createName} onChange={e => setCreateName(e.target.value)}
            placeholder="Role name" style={{ ...S.input, marginBottom: 8 }} maxLength={32} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            {PERMISSION_DEFS.map(p => (
              <label key={p.key} style={{ fontSize: 11, color: '#e5e7eb', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!createPerms[p.key]}
                  onChange={e => setCreatePerms(prev => ({ ...prev, [p.key]: e.target.checked }))} />
                {p.label}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={handleCreate} style={S.btnCyan}>CREATE</button>
            <button onClick={() => setShowCreate(false)} style={S.btnDim}>CANCEL</button>
          </div>
        </div>
      )}

      {roles.map(role => {
        const perms = typeof role.permissions === 'string' ? JSON.parse(role.permissions) : (role.permissions || {});
        const isEditing = editRole?.id === role.id;
        return (
          <div key={role.id} style={{ ...S.row, flexDirection: 'column', alignItems: 'stretch' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: '#e5e7eb', fontWeight: 'bold', flex: 1 }}>{role.name}</span>
              <span style={{ fontSize: 10, color: '#0e7490' }}>
                {Object.entries(perms).filter(([, v]) => v).map(([k]) => k.replace('can_', '')).join(', ') || 'no perms'}
              </span>
              <button onClick={() => isEditing ? setEditRole(null) : handleEdit(role)} style={S.btnDim}>
                {isEditing ? 'CLOSE' : 'EDIT'}
              </button>
              <button onClick={() => handleDelete(role.id)} style={S.btnDanger}>DEL</button>
            </div>
            {isEditing && (
              <div style={{ marginTop: 8, padding: '8px 0' }}>
                <input value={newName} onChange={e => setNewName(e.target.value)}
                  style={{ ...S.input, marginBottom: 8 }} maxLength={32} />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                  {PERMISSION_DEFS.map(p => (
                    <label key={p.key} style={{ fontSize: 11, color: '#e5e7eb', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                      <input type="checkbox" checked={!!newPerms[p.key]}
                        onChange={e => setNewPerms(prev => ({ ...prev, [p.key]: e.target.checked }))} />
                      {p.label}
                    </label>
                  ))}
                </div>
                <button onClick={handleSave} style={S.btnCyan}>SAVE CHANGES</button>
              </div>
            )}
          </div>
        );
      })}
      {roles.length === 0 && (
        <div style={{ fontSize: 12, color: '#0e7490', textAlign: 'center', padding: 20 }}>No roles configured</div>
      )}
    </div>
  );
}

// ── Members Tab ─────────────────────────────────────────────────────────────
function MembersTab({ org }) {
  const [members, setMembers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState(null);

  const load = useCallback(async () => {
    const [mRes, rRes] = await Promise.all([
      api.getOrgMembers(org.id),
      api.getRoles(org.id),
    ]);
    setMembers(mRes.data?.members || []);
    setRoles(Array.isArray(rRes.data) ? rRes.data : (rRes.data?.roles || []));
    setLoading(false);
  }, [org.id]);

  useEffect(() => { load(); }, [load]);

  const handleAssignRole = async (userId, roleId) => {
    setActionMsg(null);
    const { error } = await api.assignMemberRole(org.id, userId, roleId);
    if (error) setActionMsg({ type: 'error', text: error });
    else load();
  };

  const handleKick = async (userId, callsign) => {
    if (!confirm(`Kick ${callsign}?`)) return;
    const { error } = await api.kickMember(org.id, userId);
    if (error) setActionMsg({ type: 'error', text: error });
    else load();
  };

  const handleBan = async (userId, callsign) => {
    const reason = prompt(`Ban reason for ${callsign}:`);
    if (reason === null) return;
    const { error } = await api.banMember(org.id, userId, reason || 'No reason', null);
    if (error) setActionMsg({ type: 'error', text: error });
    else load();
  };

  if (loading) return <div style={{ color: '#0e7490', fontSize: 12 }}>Loading members...</div>;

  return (
    <div>
      <div style={S.sectionLabel}>MEMBERS ({members.length})</div>
      {actionMsg && <div style={{ fontSize: 11, color: actionMsg.type === 'error' ? '#ef4444' : '#4ade80', marginBottom: 8 }}>{actionMsg.text}</div>}
      {members.map(m => (
        <div key={m.user_id} style={S.row}>
          <span style={{ fontSize: 12, color: '#e5e7eb', fontWeight: 'bold', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {m.callsign}
          </span>
          <select
            value={m.role_id || ''}
            onChange={e => handleAssignRole(m.user_id, e.target.value || null)}
            style={{ ...S.input, width: 140, flex: 'none', padding: '4px 6px', fontSize: 11 }}
          >
            <option value="">No role</option>
            {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          {m.user_id !== org.owner_id && (
            <>
              <button onClick={() => handleKick(m.user_id, m.callsign)} style={S.btnDim}>KICK</button>
              <button onClick={() => handleBan(m.user_id, m.callsign)} style={S.btnDanger}>BAN</button>
            </>
          )}
          {m.user_id === org.owner_id && (
            <span style={{ fontSize: 10, color: '#0891b2', letterSpacing: '0.15em' }}>OWNER</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Bans Tab ────────────────────────────────────────────────────────────────
function BansTab({ org }) {
  const [bans, setBans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    const { data, error } = await api.getOrgBans(org.id);
    setBans(data?.bans || []);
    setLoading(false);
    if (error) setMsg({ type: 'error', text: error });
  }, [org.id]);

  useEffect(() => { load(); }, [load]);

  const handleUnban = async (userId) => {
    const { error } = await api.unbanMember(org.id, userId);
    if (error) setMsg({ type: 'error', text: error });
    else load();
  };

  if (loading) return <div style={{ color: '#0e7490', fontSize: 12 }}>Loading bans...</div>;

  return (
    <div>
      <div style={S.sectionLabel}>BANNED USERS ({bans.length})</div>
      {msg && <div style={{ fontSize: 11, color: msg.type === 'error' ? '#ef4444' : '#4ade80', marginBottom: 8 }}>{msg.text}</div>}
      {bans.length === 0 && (
        <div style={{ fontSize: 12, color: '#0e7490', textAlign: 'center', padding: 20 }}>No active bans</div>
      )}
      {bans.map(b => (
        <div key={b.user_id} style={S.row}>
          <span style={{ fontSize: 12, color: '#e5e7eb', fontWeight: 'bold', flex: 1 }}>
            {b.callsign || b.user_id}
          </span>
          <span style={{ fontSize: 11, color: '#0e7490', flex: 1 }}>{b.reason}</span>
          <span style={{ fontSize: 10, color: '#0e7490' }}>
            {b.expires_at ? new Date(b.expires_at).toLocaleDateString() : 'Permanent'}
          </span>
          <button onClick={() => handleUnban(b.user_id)} style={S.btnCyan}>UNBAN</button>
        </div>
      ))}
    </div>
  );
}

// ── Channels Tab ────────────────────────────────────────────────────────────
function ChannelsTab({ org }) {
  const [channels, setChannels] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [chRes, rRes] = await Promise.all([
      api.getChannels(org.id),
      api.getRoles(org.id),
    ]);
    setChannels(chRes.data?.channels || []);
    setRoles(Array.isArray(rRes.data) ? rRes.data : (rRes.data?.roles || []));
    setLoading(false);
  }, [org.id]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (chanId) => {
    if (!confirm('Delete this channel?')) return;
    await api.deleteChannel(org.id, chanId);
    load();
  };

  if (loading) return <div style={{ color: '#0e7490', fontSize: 12 }}>Loading channels...</div>;

  return (
    <div>
      <div style={S.sectionLabel}>CHANNELS ({channels.length})</div>
      {channels.map(ch => (
        <div key={ch.id} style={S.row}>
          <span style={{ fontSize: 12, color: (ch.channel_kind ?? 0) === 0 ? '#22c55e' : '#22d3ee', flexShrink: 0 }}>
            {(ch.channel_kind ?? 0) === 0 ? '◉' : '#'}
          </span>
          <span style={{ fontSize: 12, color: '#e5e7eb', fontWeight: 'bold', flex: 1 }}>{ch.name}</span>
          <span style={{ fontSize: 10, color: '#0e7490' }}>
            {ch.type === 1 ? 'Private' : 'Public'}
          </span>
          <button onClick={() => handleDelete(ch.id)} style={S.btnDanger}>DEL</button>
        </div>
      ))}
      {channels.length === 0 && (
        <div style={{ fontSize: 12, color: '#0e7490', textAlign: 'center', padding: 20 }}>No channels</div>
      )}
    </div>
  );
}

// ── Landing Tab ─────────────────────────────────────────────────────────────
function LandingTab({ org }) {
  const [landingDesc, setLandingDesc] = useState(org.landing_description || '');
  const [bannerUrl, setBannerUrl] = useState(org.banner_url || '');
  const [showCalendar, setShowCalendar] = useState(org.show_calendar_on_landing !== false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const handleSave = async () => {
    setSaving(true); setMsg(null);
    const { error } = await api.updateOrgLanding(org.id, {
      landing_description: landingDesc || null,
      banner_url: bannerUrl || null,
      show_calendar_on_landing: showCalendar,
    });
    setSaving(false);
    if (error) setMsg({ type: 'error', text: error });
    else setMsg({ type: 'ok', text: 'Landing page saved' });
  };

  return (
    <div style={{ maxWidth: 460 }}>
      <div style={{ marginBottom: 14 }}>
        <label style={S.label}>SERVER DESCRIPTION / RULES</label>
        <textarea
          value={landingDesc}
          onChange={e => setLandingDesc(e.target.value)}
          style={{ ...S.input, height: 120, resize: 'vertical' }}
          maxLength={4000}
          placeholder="Enter server rules, briefing notes, or welcome message..."
        />
        <div style={{ fontSize: 10, color: '#0e7490', marginTop: 2 }}>Supports line breaks. Max 4000 characters.</div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={S.label}>BANNER IMAGE URL (OPTIONAL)</label>
        <input
          value={bannerUrl}
          onChange={e => setBannerUrl(e.target.value)}
          style={S.input}
          maxLength={512}
          placeholder="https://..."
        />
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={{ fontSize: 12, color: '#e5e7eb', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showCalendar}
            onChange={e => setShowCalendar(e.target.checked)}
          />
          Show Ops Calendar on landing page
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button onClick={handleSave} disabled={saving} style={{ ...S.btnCyan, opacity: saving ? 0.5 : 1 }}>
          {saving ? 'SAVING...' : 'SAVE LANDING'}
        </button>
      </div>
      {msg && (
        <div style={{ fontSize: 11, color: msg.type === 'error' ? '#ef4444' : '#4ade80' }}>{msg.text}</div>
      )}
    </div>
  );
}

// ── Billing Info Tab ────────────────────────────────────────────────────────
// Owner-only, enforced server-side (getOrgBillingInfo/updateOrgBillingInfo) --
// this tab can still be opened by any admin who can see Settings, so a 403 here
// is a normal, expected outcome rather than a bug, and is shown as a plain
// message rather than a raw error.
function BillingInfoTab({ org }) {
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [contactName, setContactName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [billingEmail, setBillingEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [taxId, setTaxId] = useState('');
  const [isTaxExempt, setIsTaxExempt] = useState(false);
  const [taxExemptionNumber, setTaxExemptionNumber] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await api.getOrgBillingInfo(org.id);
      // fetchWithAuth doesn't surface the HTTP status, only the server's message
      // text -- matching on it is the only way to distinguish "you're not the
      // owner" (expected, not an error state) from a real failure.
      if (error === 'Only the owner can view billing info') { setForbidden(true); setLoading(false); return; }
      if (error) { setMsg({ type: 'error', text: error }); setLoading(false); return; }
      if (data) {
        setContactName(data.contact_name || '');
        setCompanyName(data.company_name || '');
        setBillingEmail(data.billing_email || '');
        setPhone(data.phone || '');
        setAddressLine1(data.address_line1 || '');
        setAddressLine2(data.address_line2 || '');
        setCity(data.city || '');
        setState(data.state || '');
        setZip(data.zip || '');
        setTaxId(data.tax_id || '');
        setIsTaxExempt(data.is_tax_exempt || false);
        setTaxExemptionNumber(data.tax_exemption_number || '');
      }
      setLoading(false);
    })();
  }, [org.id]);

  const handleSave = async () => {
    setSaving(true); setMsg(null);
    const { error } = await api.updateOrgBillingInfo(org.id, {
      contact_name: contactName, company_name: companyName || null, billing_email: billingEmail,
      phone, address_line1: addressLine1, address_line2: addressLine2, city, state, zip,
      tax_id: taxId, is_tax_exempt: isTaxExempt, tax_exemption_number: taxExemptionNumber,
    });
    setSaving(false);
    if (error) setMsg({ type: 'error', text: error });
    else setMsg({ type: 'ok', text: 'Billing info saved' });
  };

  if (loading) return <div style={{ color: '#0e7490', fontSize: 12 }}>Loading billing info...</div>;
  if (forbidden) return <div style={{ color: '#0e7490', fontSize: 12 }}>Only the server owner can view or edit billing info.</div>;

  return (
    <div style={{ maxWidth: 460 }}>
      <div style={{ fontSize: 10, color: '#4b6272', marginBottom: 14, fontFamily: 'monospace' }}>
        Used to invoice this server for pool funding. Not shared publicly.
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={S.label}>CONTACT NAME</label>
        <input value={contactName} onChange={e => setContactName(e.target.value)} style={S.input} maxLength={120} />
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={S.label}>COMPANY NAME (OPTIONAL)</label>
        <input value={companyName} onChange={e => setCompanyName(e.target.value)} style={S.input} maxLength={160} />
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={S.label}>BILLING EMAIL</label>
        <input value={billingEmail} onChange={e => setBillingEmail(e.target.value)} style={S.input} maxLength={255} type="email" />
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={S.label}>PHONE</label>
        <input value={phone} onChange={e => setPhone(e.target.value)} style={S.input} maxLength={40} />
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={S.label}>ADDRESS LINE 1</label>
        <input value={addressLine1} onChange={e => setAddressLine1(e.target.value)} style={S.input} maxLength={200} />
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={S.label}>ADDRESS LINE 2</label>
        <input value={addressLine2} onChange={e => setAddressLine2(e.target.value)} style={S.input} maxLength={200} />
      </div>
      <div style={{ marginBottom: 14, display: 'flex', gap: 10 }}>
        <div style={{ flex: 2 }}>
          <label style={S.label}>CITY</label>
          <input value={city} onChange={e => setCity(e.target.value)} style={S.input} maxLength={100} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={S.label}>STATE</label>
          <input value={state} onChange={e => setState(e.target.value)} style={S.input} maxLength={100} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={S.label}>ZIP</label>
          <input value={zip} onChange={e => setZip(e.target.value)} style={S.input} maxLength={20} />
        </div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={S.label}>TAX ID</label>
        <input value={taxId} onChange={e => setTaxId(e.target.value)} style={S.input} maxLength={60} />
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={{ fontSize: 12, color: '#e5e7eb', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={isTaxExempt} onChange={e => setIsTaxExempt(e.target.checked)} /> Tax exempt
        </label>
      </div>
      {isTaxExempt && (
        <div style={{ marginBottom: 14 }}>
          <label style={S.label}>TAX EXEMPTION NUMBER</label>
          <input value={taxExemptionNumber} onChange={e => setTaxExemptionNumber(e.target.value)} style={S.input} maxLength={60} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button onClick={handleSave} disabled={saving} style={{ ...S.btnCyan, opacity: saving ? 0.5 : 1 }}>
          {saving ? 'SAVING...' : 'SAVE BILLING INFO'}
        </button>
      </div>
      {msg && (
        <div style={{ fontSize: 11, color: msg.type === 'error' ? '#ef4444' : '#4ade80' }}>{msg.text}</div>
      )}
    </div>
  );
}

// ── Main OrgSettings ────────────────────────────────────────────────────────
export default function OrgSettings({ org, user, onClose, onOrgUpdated }) {
  const [tab, setTab] = useState('general');

  return (
    <div style={S.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={S.panel}>
        <div style={S.header}>
          <span style={S.title}>⚙ {org.callsign?.toUpperCase()} — SERVER SETTINGS</span>
          <button onClick={onClose} style={S.closeBtn}
            onMouseEnter={e => e.currentTarget.style.color = '#ef4444'}
            onMouseLeave={e => e.currentTarget.style.color = '#0e7490'}
          >✕</button>
        </div>
        <div style={S.tabs}>
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)} style={S.tab(tab === t)}>{t}</button>
          ))}
        </div>
        <div style={S.body}>
          {tab === 'general' && <GeneralTab org={org} onSaved={onOrgUpdated} />}
          {tab === 'roles' && <RolesTab org={org} />}
          {tab === 'members' && <MembersTab org={org} />}
          {tab === 'bans' && <BansTab org={org} />}
          {tab === 'channels' && <ChannelsTab org={org} />}
          {tab === 'landing' && <LandingTab org={org} />}
          {tab === 'billing' && <BillingInfoTab org={org} />}
        </div>
      </div>
    </div>
  );
}
