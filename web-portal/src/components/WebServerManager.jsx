import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api';

// ── Permission definitions ────────────────────────────────────────────────────
const PERMISSION_DEFS = [
  { key: 'can_kick',            label: 'Kick Members' },
  { key: 'can_ban',             label: 'Ban Members' },
  { key: 'can_manage_roles',    label: 'Manage Roles' },
  { key: 'can_manage_channels', label: 'Manage Channels' },
  { key: 'can_invite',          label: 'Create Invites' },
  { key: 'can_create_events',   label: 'Create Operations' },
];

const MUTE_DURATIONS = [
  { label: '5 min',    value: 5 },
  { label: '15 min',   value: 15 },
  { label: '30 min',   value: 30 },
  { label: '1 hour',   value: 60 },
  { label: '8 hours',  value: 480 },
  { label: '24 hours', value: 1440 },
];

const TIMEOUT_DURATIONS = [
  { label: '1 hour',  hours: 1 },
  { label: '6 hours', hours: 6 },
  { label: '24 hours',hours: 24 },
  { label: '7 days',  hours: 168 },
];

// ── Shared components ─────────────────────────────────────────────────────────
const Button = ({ children, variant = 'primary', onClick, full = false, disabled = false, type = 'button', size = 'md' }) => {
  const sizeClass = size === 'sm' ? 'px-2 py-1 text-xs' : 'px-4 py-2 text-sm';
  const base = `${full ? 'w-full' : ''} ${sizeClass} rounded font-semibold tracking-wider transition-all duration-200`;
  const variants = {
    primary:   'bg-specter-primary-cyan text-slate-900 hover:bg-specter-primary-neon hover:shadow-[0_0_15px_rgba(6,182,212,0.4)]',
    secondary: 'bg-slate-800 text-slate-300 border border-slate-700 hover:text-white hover:border-specter-primary-cyan',
    danger:    'bg-red-900/40 text-red-300 border border-red-800 hover:bg-red-800',
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={`${base} ${variants[variant]} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
      {children}
    </button>
  );
};

const inputCls = 'bg-slate-900/50 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:border-specter-primary-cyan focus:outline-none transition-colors w-full';
const labelCls = 'block text-xs text-slate-400 mb-1 uppercase tracking-wider';

function Msg({ msg, onClear }) {
  if (!msg) return null;
  return (
    <div className={`mb-4 rounded px-4 py-3 text-sm font-medium flex items-center justify-between ${
      msg.type === 'error'
        ? 'bg-red-900/30 text-red-400 border border-red-800/50'
        : 'bg-emerald-900/30 text-emerald-400 border border-emerald-800/50'
    }`}>
      <span>{msg.text}</span>
      <button className="opacity-60 hover:opacity-100 ml-4 text-lg leading-none" onClick={onClear}>×</button>
    </div>
  );
}

// ── Settings Tab ──────────────────────────────────────────────────────────────
function SettingsTab({ org, isMod }) {
  const [form, setForm] = useState({
    callsign:    org.callsign    || '',
    description: org.description || '',
    is_public:   org.is_public   ?? false,
    join_method: org.join_method ?? 0,
  });
  const [inviteCode, setInviteCode]     = useState(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [msg, setMsg]                   = useState(null);

  const handleSave = async () => {
    const { error } = await api.updateOrgSettings(org.id, form);
    if (error) setMsg({ type: 'error', text: error });
    else       setMsg({ type: 'success', text: 'Settings saved.' });
  };

  const handleGenerateInvite = async () => {
    const { data, error } = await api.createInvite(org.id);
    if (error) setMsg({ type: 'error', text: error });
    else setInviteCode(data.code || data?.invite?.code);
  };

  const handleCopyInvite = () => {
    navigator.clipboard.writeText(`${window.location.origin}/join/${inviteCode}`);
    setInviteCopied(true);
    setTimeout(() => setInviteCopied(false), 2000);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <Msg msg={msg} onClear={() => setMsg(null)} />
      <section className="space-y-4">
        <h3 className="text-base font-semibold text-white">General Information</h3>
        <div>
          <label className={labelCls}>Server Name</label>
          <input className={inputCls} value={form.callsign} disabled={!isMod} maxLength={32}
            onChange={e => setForm(s => ({ ...s, callsign: e.target.value }))} />
        </div>
        <div>
          <label className={labelCls}>Description</label>
          <textarea className={`${inputCls} min-h-[80px] resize-y`} value={form.description} disabled={!isMod} maxLength={500}
            onChange={e => setForm(s => ({ ...s, description: e.target.value }))} />
        </div>
        {isMod && (
          <>
            <div>
              <label className={labelCls}>Join Method</label>
              <select className={inputCls} value={form.join_method}
                onChange={e => setForm(s => ({ ...s, join_method: Number(e.target.value) }))}>
                <option value={0}>Open — anyone can join</option>
                <option value={1}>Application — members must apply</option>
                <option value={2}>Invite Only</option>
              </select>
            </div>
            <label className="flex items-center gap-3 text-sm text-slate-300 cursor-pointer">
              <input type="checkbox" checked={form.is_public}
                onChange={e => setForm(s => ({ ...s, is_public: e.target.checked }))}
                className="w-4 h-4 rounded border-slate-600 bg-slate-900 text-specter-primary-cyan" />
              List server in Public Directory
            </label>
            <div className="pt-1">
              <Button onClick={handleSave}>Save Changes</Button>
            </div>
          </>
        )}
      </section>

      <hr className="border-slate-800" />

      <section className="space-y-3">
        <h3 className="text-base font-semibold text-white">Invite Link</h3>
        {!inviteCode ? (
          <Button variant="secondary" onClick={handleGenerateInvite}>Generate Invite Link</Button>
        ) : (
          <div className="flex items-center gap-2">
            <input readOnly value={`${window.location.origin}/join/${inviteCode}`}
              className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-specter-primary-cyan font-mono" />
            <Button variant="secondary" onClick={handleCopyInvite}>{inviteCopied ? 'Copied!' : 'Copy'}</Button>
            <Button variant="secondary" onClick={() => setInviteCode(null)}>New</Button>
          </div>
        )}
      </section>
    </div>
  );
}

// ── Roles Tab ─────────────────────────────────────────────────────────────────
function RolesTab({ org, user, isOwner }) {
  const [roles, setRoles]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [editId, setEditId]       = useState(null);
  const [editName, setEditName]   = useState('');
  const [editPerms, setEditPerms] = useState({});
  const [editLevel, setEditLevel] = useState(0);
  const [showCreate, setShowCreate]     = useState(false);
  const [createName, setCreateName]     = useState('');
  const [createPerms, setCreatePerms]   = useState({});
  const [createLevel, setCreateLevel]   = useState(0);
  const [msg, setMsg]             = useState(null);

  // Current user's role level from the org object (populated by getMyOrgs)
  const myLevel    = isOwner ? Number.MAX_SAFE_INTEGER : Number(org.role_level ?? 0);
  const myPerms    = typeof org.permissions === 'string' ? JSON.parse(org.permissions) : (org.permissions || {});
  const canManage  = isOwner || !!myPerms.can_manage_roles;
  const maxNewLevel = isOwner ? 999 : myLevel - 1;

  const load = useCallback(async () => {
    const { data } = await api.getRoles(org.id);
    setRoles(Array.isArray(data) ? data : []);
    setLoading(false);
  }, [org.id]);

  useEffect(() => { load(); }, [load]);

  const openEdit = (role) => {
    setEditId(role.id);
    setEditName(role.name);
    const p = typeof role.permissions === 'string' ? JSON.parse(role.permissions) : (role.permissions || {});
    setEditPerms(p);
    setEditLevel(Number(role.level ?? 0));
  };

  const handleSaveEdit = async () => {
    const { error } = await api.updateRole(org.id, editId, { name: editName, permissions: editPerms, level: editLevel });
    if (error) setMsg({ type: 'error', text: error });
    else { setMsg({ type: 'success', text: 'Role updated.' }); setEditId(null); load(); }
  };

  const handleCreate = async () => {
    if (!createName.trim()) return;
    const { error } = await api.createRole(org.id, { name: createName.trim(), permissions: createPerms, level: createLevel });
    if (error) setMsg({ type: 'error', text: error });
    else { setCreateName(''); setCreatePerms({}); setCreateLevel(0); setShowCreate(false); load(); }
  };

  const handleDelete = async (roleId) => {
    if (!confirm('Delete this role? Members assigned it will lose it.')) return;
    const { error } = await api.deleteRole(org.id, roleId);
    if (error) setMsg({ type: 'error', text: error });
    else { if (editId === roleId) setEditId(null); load(); }
  };

  if (loading) return <div className="text-slate-400 text-sm">Loading roles...</div>;

  const PermChecks = ({ perms, onChange, disabled }) => (
    <div className="flex flex-wrap gap-x-5 gap-y-2 mt-1">
      {PERMISSION_DEFS.map(p => (
        <label key={p.key} className={`flex items-center gap-2 text-sm cursor-pointer select-none ${disabled ? 'opacity-40' : 'text-slate-300'}`}>
          <input type="checkbox" checked={!!perms[p.key]} disabled={disabled}
            onChange={e => onChange(prev => ({ ...prev, [p.key]: e.target.checked }))}
            className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-900 text-specter-primary-cyan" />
          {p.label}
        </label>
      ))}
    </div>
  );

  return (
    <div className="space-y-4 max-w-2xl">
      <Msg msg={msg} onClear={() => setMsg(null)} />
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-white">Roles ({roles.length})</h3>
        {canManage && (
          <Button variant="secondary" size="sm" onClick={() => setShowCreate(v => !v)}>
            {showCreate ? '× Cancel' : '+ New Role'}
          </Button>
        )}
      </div>

      {showCreate && canManage && (
        <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Role Name</label>
              <input className={inputCls} value={createName} maxLength={32} placeholder="e.g. Moderator"
                onChange={e => setCreateName(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Level (higher = higher rank)</label>
              <input type="number" className={inputCls} value={createLevel} min={0} max={maxNewLevel}
                onChange={e => setCreateLevel(Math.min(maxNewLevel, Math.max(0, Number(e.target.value))))} />
              {!isOwner && <p className="text-xs text-slate-500 mt-0.5">Max {maxNewLevel} (below your rank)</p>}
            </div>
          </div>
          <div>
            <label className={labelCls}>Permissions</label>
            <PermChecks perms={createPerms} onChange={setCreatePerms} disabled={false} />
          </div>
          <Button onClick={handleCreate} disabled={!createName.trim()}>Create Role</Button>
        </div>
      )}

      <div className="space-y-2">
        {roles.map(role => {
          const perms = typeof role.permissions === 'string' ? JSON.parse(role.permissions) : (role.permissions || {});
          const activeLabels = PERMISSION_DEFS.filter(p => perms[p.key]).map(p => p.label);
          const isEditing = editId === role.id;
          const roleLevel = Number(role.level ?? 0);
          const canEdit = canManage && (isOwner || roleLevel < myLevel);
          const maxEditLevel = isOwner ? 999 : myLevel - 1;

          return (
            <div key={role.id} className="bg-slate-900/30 border border-slate-800 rounded-lg overflow-hidden">
              <div className="px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-white">{role.name}</span>
                    <span className="text-[10px] font-mono text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">LVL {roleLevel}</span>
                    {!canEdit && canManage && (
                      <span className="text-[10px] text-amber-500/70 italic">above your rank</span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 truncate">
                    {activeLabels.length > 0 ? activeLabels.join(' · ') : 'No permissions'}
                  </div>
                </div>
                {canEdit && (
                  <>
                    <Button variant="secondary" size="sm" onClick={() => isEditing ? setEditId(null) : openEdit(role)}>
                      {isEditing ? 'Close' : 'Edit'}
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => handleDelete(role.id)}>Delete</Button>
                  </>
                )}
              </div>
              {isEditing && canEdit && (
                <div className="border-t border-slate-700 px-4 py-4 space-y-3 bg-slate-900/50">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>Role Name</label>
                      <input className={inputCls} value={editName} maxLength={32}
                        onChange={e => setEditName(e.target.value)} />
                    </div>
                    <div>
                      <label className={labelCls}>Level (higher = higher rank)</label>
                      <input type="number" className={inputCls} value={editLevel} min={0} max={maxEditLevel}
                        onChange={e => setEditLevel(Math.min(maxEditLevel, Math.max(0, Number(e.target.value))))} />
                      {!isOwner && <p className="text-xs text-slate-500 mt-0.5">Max {maxEditLevel} (below your rank)</p>}
                    </div>
                  </div>
                  <div>
                    <label className={labelCls}>Permissions</label>
                    <PermChecks perms={editPerms} onChange={setEditPerms} disabled={false} />
                  </div>
                  <Button onClick={handleSaveEdit}>Save Changes</Button>
                </div>
              )}
            </div>
          );
        })}
        {roles.length === 0 && (
          <div className="text-slate-500 text-sm text-center py-8">No roles configured. Create one above.</div>
        )}
      </div>
    </div>
  );
}

// ── Members Tab ───────────────────────────────────────────────────────────────
function MembersTab({ org, user, isMod }) {
  const [members, setMembers]   = useState([]);
  const [roles, setRoles]       = useState([]);
  const [channels, setChannels] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [msg, setMsg]           = useState(null);
  const [muteMenu, setMuteMenu]       = useState(null);
  const [timeoutMenu, setTimeoutMenu] = useState(null);
  const [moveMenu, setMoveMenu]       = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [mRes, rRes, cRes] = await Promise.all([
      api.getOrgMembers(org.id),
      api.getRoles(org.id),
      api.getChannels(org.id),
    ]);
    setMembers(mRes.data?.members  || []);
    setRoles(Array.isArray(rRes.data) ? rRes.data : []);
    setChannels(cRes.data?.channels || []);
    setLoading(false);
  }, [org.id]);

  useEffect(() => { load(); }, [load]);

  const closeMenus = () => { setMuteMenu(null); setTimeoutMenu(null); setMoveMenu(null); };

  const act = async (apiFn, successMsg) => {
    const { error } = await apiFn();
    if (error) setMsg({ type: 'error', text: error });
    else { setMsg({ type: 'success', text: successMsg }); load(); }
    closeMenus();
  };

  const handleAssignRole = (userId, roleId) =>
    act(() => api.assignMemberRole(org.id, userId, roleId || null), 'Role updated.');

  const handleKick = (userId, name) => {
    if (!confirm(`Remove ${name} from the server?`)) return;
    act(() => api.kickMember(org.id, userId), `${name} removed.`);
  };

  const handleBan = (userId, name) => {
    const reason = prompt(`Ban reason for ${name}:`);
    if (reason === null) return;
    act(() => api.banMember(org.id, userId, reason || 'No reason provided', null), `${name} banned.`);
  };

  const handleMute = (userId, minutes) =>
    act(() => api.muteMember(org.id, userId, true, minutes), `User muted for ${minutes} min.`);

  const handleTimeout = (userId, hours) => {
    const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    act(() => api.banMember(org.id, userId, 'Timeout', expiresAt), `User timed out for ${hours}h.`);
  };

  const handleMove = (userId, channelId) =>
    act(() => api.moveMember(org.id, userId, channelId), 'Member moved.');

  const voiceChannels = channels.filter(c => (c.channel_kind ?? 0) === 0);

  if (loading) return <div className="text-slate-400 text-sm">Loading members...</div>;

  return (
    <div className="space-y-4" onClick={closeMenus}>
      <Msg msg={msg} onClear={() => setMsg(null)} />
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-white">Members ({members.length})</h3>
        <button onClick={load} className="text-xs text-slate-400 hover:text-specter-primary-cyan transition-colors">↻ Refresh</button>
      </div>
      <div className="bg-slate-900/30 border border-slate-800 rounded-lg overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[480px]">
          <thead>
            <tr className="bg-slate-800/50 border-b border-slate-700/50">
              <th className="px-4 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">User</th>
              <th className="px-4 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Role</th>
              {isMod && <th className="px-4 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {members.map(m => {
              const isSelf  = m.user_id === user?.id;
              const isOwner = m.user_id === org.owner_id;
              return (
                <tr key={m.user_id} className="hover:bg-slate-800/20 transition-colors">
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium text-white">{m.callsign}</div>
                    {isOwner && <div className="text-[10px] text-specter-primary-cyan font-mono tracking-wider">OWNER</div>}
                  </td>
                  <td className="px-4 py-3">
                    {isMod && !isSelf ? (
                      <select
                        className="bg-slate-900 border border-slate-700 text-xs text-slate-300 rounded px-2 py-1 focus:border-specter-primary-cyan focus:outline-none"
                        value={m.role_id || ''}
                        onChange={e => handleAssignRole(m.user_id, e.target.value)}
                        onClick={e => e.stopPropagation()}
                      >
                        <option value="">— Member —</option>
                        {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    ) : (
                      <span className="text-xs text-slate-400">{m.role_name || 'Member'}</span>
                    )}
                  </td>
                  {isMod && (
                    <td className="px-4 py-3">
                      {!isSelf && !isOwner && (
                        <div className="flex items-center justify-end gap-1 flex-wrap">

                          {/* Mute */}
                          <div className="relative" onClick={e => e.stopPropagation()}>
                            <button
                              onClick={() => { closeMenus(); setMuteMenu(muteMenu === m.user_id ? null : m.user_id); }}
                              className="px-2 py-1 text-xs rounded border border-slate-700 text-slate-300 hover:border-amber-600 hover:text-amber-400 transition-colors"
                            >Mute ▾</button>
                            {muteMenu === m.user_id && (
                              <div className="absolute right-0 top-7 z-30 bg-slate-900 border border-slate-700 rounded shadow-xl min-w-[120px]">
                                {MUTE_DURATIONS.map(d => (
                                  <button key={d.value} onClick={() => handleMute(m.user_id, d.value)}
                                    className="block w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700 hover:text-white transition-colors">
                                    {d.label}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Timeout */}
                          <div className="relative" onClick={e => e.stopPropagation()}>
                            <button
                              onClick={() => { closeMenus(); setTimeoutMenu(timeoutMenu === m.user_id ? null : m.user_id); }}
                              className="px-2 py-1 text-xs rounded border border-slate-700 text-slate-300 hover:border-orange-600 hover:text-orange-400 transition-colors"
                            >Timeout ▾</button>
                            {timeoutMenu === m.user_id && (
                              <div className="absolute right-0 top-7 z-30 bg-slate-900 border border-slate-700 rounded shadow-xl min-w-[120px]">
                                {TIMEOUT_DURATIONS.map(t => (
                                  <button key={t.hours} onClick={() => handleTimeout(m.user_id, t.hours)}
                                    className="block w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700 hover:text-white transition-colors">
                                    {t.label}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Move to channel */}
                          <div className="relative" onClick={e => e.stopPropagation()}>
                            <button
                              onClick={() => { closeMenus(); setMoveMenu(moveMenu === m.user_id ? null : m.user_id); }}
                              className="px-2 py-1 text-xs rounded border border-slate-700 text-slate-300 hover:border-blue-600 hover:text-blue-400 transition-colors"
                            >Move ▾</button>
                            {moveMenu === m.user_id && (
                              <div className="absolute right-0 top-7 z-30 bg-slate-900 border border-slate-700 rounded shadow-xl min-w-[150px]">
                                {voiceChannels.length === 0
                                  ? <div className="px-3 py-2 text-xs text-slate-500">No voice channels</div>
                                  : voiceChannels.map(c => (
                                    <button key={c.id} onClick={() => handleMove(m.user_id, c.id)}
                                      className="block w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700 hover:text-white transition-colors">
                                      ◉ {c.name}
                                    </button>
                                  ))
                                }
                              </div>
                            )}
                          </div>

                          <button onClick={() => handleKick(m.user_id, m.callsign)}
                            className="px-2 py-1 text-xs rounded border border-slate-700 text-amber-500 hover:border-amber-600 hover:bg-amber-900/20 transition-colors">
                            Kick
                          </button>
                          <button onClick={() => handleBan(m.user_id, m.callsign)}
                            className="px-2 py-1 text-xs rounded border border-red-900 text-red-500 hover:border-red-700 hover:bg-red-900/20 transition-colors">
                            Ban
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {members.length === 0 && <div className="p-8 text-center text-slate-500 text-sm">No members found.</div>}
      </div>
    </div>
  );
}

// ── Channels Tab ──────────────────────────────────────────────────────────────
function ChannelsTab({ org, isMod }) {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [newName, setNewName]   = useState('');
  const [newKind, setNewKind]   = useState(0);
  const [msg, setMsg]           = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await api.getChannels(org.id);
    setChannels(data?.channels || []);
    setLoading(false);
  }, [org.id]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    const { error } = await api.createChannel(org.id, { name: newName.trim(), channel_kind: newKind });
    if (error) setMsg({ type: 'error', text: error });
    else { setNewName(''); load(); }
  };

  const handleDelete = async (chanId) => {
    if (!confirm('Delete this channel?')) return;
    await api.deleteChannel(org.id, chanId);
    load();
  };

  const voiceChannels = channels.filter(c => (c.channel_kind ?? 0) === 0);
  const textChannels  = channels.filter(c => (c.channel_kind ?? 0) === 1);

  if (loading) return <div className="text-slate-400 text-sm">Loading channels...</div>;

  return (
    <div className="space-y-5 max-w-2xl">
      <Msg msg={msg} onClear={() => setMsg(null)} />
      {isMod && (
        <form onSubmit={handleCreate} className="flex gap-2">
          <input
            className="flex-1 bg-slate-900/50 border border-slate-700 rounded px-3 py-2 text-white focus:border-specter-primary-cyan focus:outline-none placeholder-slate-500 text-sm"
            placeholder="New channel name..." value={newName}
            onChange={e => setNewName(e.target.value)} />
          <select
            className="bg-slate-900 border border-slate-700 text-sm text-slate-300 rounded px-2 py-2 focus:border-specter-primary-cyan focus:outline-none"
            value={newKind} onChange={e => setNewKind(Number(e.target.value))}>
            <option value={0}>Voice</option>
            <option value={1}>Text</option>
          </select>
          <Button type="submit" disabled={!newName.trim()}>Create</Button>
        </form>
      )}

      {[
        { label: 'Voice Channels', list: voiceChannels, icon: '◉', color: '#22c55e' },
        { label: 'Text Channels',  list: textChannels,  icon: '#', color: '#22d3ee' },
      ].map(({ label, list, icon, color }) => (
        <section key={label}>
          <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">{label}</div>
          <div className="space-y-1.5">
            {list.map(c => (
              <div key={c.id} className="bg-slate-900/30 border border-slate-800 rounded-lg px-4 py-2.5 flex items-center gap-3 hover:border-slate-600 transition-colors">
                <span style={{ color }} className="text-xs">{icon}</span>
                <span className="text-sm text-slate-200 flex-1">{c.name}</span>
                {isMod && (
                  <button onClick={() => handleDelete(c.id)}
                    className="text-slate-600 hover:text-red-400 transition-colors text-xs px-2 py-0.5 rounded hover:bg-red-900/20">
                    Delete
                  </button>
                )}
              </div>
            ))}
            {list.length === 0 && <div className="text-slate-600 text-xs pl-1">None</div>}
          </div>
        </section>
      ))}
    </div>
  );
}

// ── Bans Tab ──────────────────────────────────────────────────────────────────
function BansTab({ org }) {
  const [bans, setBans]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg]         = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await api.getOrgBans(org.id);
    setBans(data?.bans || []);
    if (error) setMsg({ type: 'error', text: error });
    setLoading(false);
  }, [org.id]);

  useEffect(() => { load(); }, [load]);

  const handleUnban = async (userId) => {
    const { error } = await api.unbanMember(org.id, userId);
    if (error) setMsg({ type: 'error', text: error });
    else load();
  };

  if (loading) return <div className="text-slate-400 text-sm">Loading bans...</div>;

  return (
    <div className="space-y-4 max-w-2xl">
      <Msg msg={msg} onClear={() => setMsg(null)} />
      <h3 className="text-base font-semibold text-white">Banned Users ({bans.length})</h3>
      {bans.length === 0 ? (
        <div className="text-slate-500 text-sm text-center py-8">No active bans.</div>
      ) : (
        <div className="space-y-2">
          {bans.map(b => (
            <div key={b.user_id} className="bg-slate-900/30 border border-slate-800 rounded-lg px-4 py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-white">{b.callsign || b.user_id}</div>
                <div className="text-xs text-slate-500 mt-0.5">{b.reason}</div>
              </div>
              <div className="text-xs text-slate-500 flex-shrink-0">
                {b.expires_at ? `Until ${new Date(b.expires_at).toLocaleDateString()}` : 'Permanent'}
              </div>
              <Button variant="secondary" size="sm" onClick={() => handleUnban(b.user_id)}>Unban</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Events Tab ────────────────────────────────────────────────────────────────

/** Inline group editor — shown when a user expands an event card */
function EventGroupEditor({ org, ev, orgMembers }) {
  const [groups, setGroups]               = useState([]);   // draft groups
  const [commanderUserId, setCommanderUserId] = useState('');
  const [loading, setLoading]             = useState(true);
  const [saving, setSaving]               = useState(false);
  const [msg, setMsg]                     = useState(null);

  // Derive a unique key list from current draft for add-member dropdowns
  const allAssignedIds = groups.flatMap(g => g.member_user_ids);

  // Load existing groups from the server
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await api.getEventGroups(org.id, ev.id);
      if (cancelled) return;
      if (error) { setMsg({ type: 'error', text: error }); setLoading(false); return; }

      // Convert server groups into local draft format
      // server groups are ordered by created_at, parent_group_id is a UUID
      const serverGroups = data?.groups || [];
      const idToIndex = Object.fromEntries(serverGroups.map((g, i) => [g.id, i]));
      setGroups(serverGroups.map(g => ({
        name:           g.name || 'Squad',
        leader_user_id: g.leader_user_id || '',
        max_members:    g.max_members || 0,
        parent_index:   g.parent_group_id != null ? (idToIndex[g.parent_group_id] ?? -1) : -1,
        member_user_ids: (g.members || []).map(m => m.user_id),
        member_roles:    Object.fromEntries((g.members || []).map(m => [m.user_id, m.role || ''])),
      })));
      setCommanderUserId(data?.commander_user_id || '');
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [org.id, ev.id]);

  const updateGroup = (idx, patch) =>
    setGroups(prev => prev.map((g, i) => i === idx ? { ...g, ...patch } : g));

  const addGroup = () => setGroups(prev => [
    ...prev,
    { name: `Squad ${prev.length + 1}`, leader_user_id: '', max_members: 0, parent_index: -1, member_user_ids: [], member_roles: {} },
  ]);

  const removeGroup = (idx) => {
    setGroups(prev => {
      const next = prev.filter((_, i) => i !== idx);
      // Remap parent_index: if parent was the removed group, reset to -1; if parent was after, shift by -1
      return next.map(g => ({
        ...g,
        parent_index: g.parent_index === idx ? -1 : g.parent_index > idx ? g.parent_index - 1 : g.parent_index,
      }));
    });
  };

  const addMemberToGroup = (idx, userId) => {
    if (!userId) return;
    setGroups(prev => prev.map((g, i) => {
      if (i !== idx || g.member_user_ids.includes(userId)) return g;
      return { ...g, member_user_ids: [...g.member_user_ids, userId], member_roles: { ...g.member_roles, [userId]: '' } };
    }));
  };

  const removeMemberFromGroup = (idx, userId) => {
    setGroups(prev => prev.map((g, i) => {
      if (i !== idx) return g;
      const { [userId]: _, ...rest } = g.member_roles;
      return { ...g, member_user_ids: g.member_user_ids.filter(id => id !== userId), member_roles: rest };
    }));
  };

  const setMemberRole = (idx, userId, role) => {
    setGroups(prev => prev.map((g, i) =>
      i !== idx ? g : { ...g, member_roles: { ...g.member_roles, [userId]: role } }
    ));
  };

  const handleSave = async () => {
    setSaving(true);
    const payload = {
      groups: groups.map(g => ({
        name:            g.name.trim() || 'Squad',
        leader_user_id:  g.leader_user_id || null,
        max_members:     Number(g.max_members) || 0,
        parent_index:    g.parent_index >= 0 ? g.parent_index : -1,
        member_user_ids: g.member_user_ids,
        member_roles:    g.member_roles,
      })),
      commander_user_id: commanderUserId || null,
    };
    const { error } = await api.saveEventGroups(org.id, ev.id, payload);
    setSaving(false);
    if (error) setMsg({ type: 'error', text: error });
    else setMsg({ type: 'success', text: 'Groups saved.' });
  };

  const selectCls = 'bg-slate-900 border border-slate-700 text-xs text-slate-300 rounded px-2 py-1.5 focus:border-specter-primary-cyan focus:outline-none';

  if (loading) return <div className="py-4 text-xs text-slate-400">Loading groups...</div>;

  return (
    <div className="space-y-4 pt-1">
      <Msg msg={msg} onClear={() => setMsg(null)} />

      {/* Commander */}
      <div className="flex items-center gap-3">
        <label className="text-xs text-slate-400 uppercase tracking-wider whitespace-nowrap">Commander</label>
        <select className={selectCls} value={commanderUserId} onChange={e => setCommanderUserId(e.target.value)}>
          <option value="">— None —</option>
          {orgMembers.map(m => <option key={m.user_id} value={m.user_id}>{m.callsign}</option>)}
        </select>
      </div>

      {/* Groups */}
      <div className="space-y-3">
        {groups.map((g, idx) => {
          // Members available to add: org members not already in this group
          const available = orgMembers.filter(m => !g.member_user_ids.includes(m.user_id));
          return (
            <div key={idx} className="bg-slate-900/50 border border-slate-700/80 rounded-lg overflow-hidden">
              {/* Group header row */}
              <div className="flex items-center gap-2 px-3 py-2 bg-slate-800/40 border-b border-slate-700/50">
                <input
                  className="flex-1 bg-transparent border-b border-slate-600 text-sm font-semibold text-white focus:border-specter-primary-cyan focus:outline-none py-0.5"
                  value={g.name} maxLength={64}
                  onChange={e => updateGroup(idx, { name: e.target.value })}
                  placeholder="Group name"
                />
                <button onClick={() => removeGroup(idx)}
                  className="text-slate-600 hover:text-red-400 transition-colors text-lg leading-none px-1">×</button>
              </div>

              <div className="p-3 space-y-2.5">
                {/* Leader / Parent / Max */}
                <div className="flex flex-wrap gap-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-500 uppercase tracking-wider">Leader</span>
                    <select className={selectCls} value={g.leader_user_id}
                      onChange={e => updateGroup(idx, { leader_user_id: e.target.value })}>
                      <option value="">— None —</option>
                      {orgMembers.map(m => <option key={m.user_id} value={m.user_id}>{m.callsign}</option>)}
                    </select>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-500 uppercase tracking-wider">Parent</span>
                    <select className={selectCls} value={g.parent_index >= 0 ? g.parent_index : ''}
                      onChange={e => updateGroup(idx, { parent_index: e.target.value === '' ? -1 : Number(e.target.value) })}>
                      <option value="">— None (top-level) —</option>
                      {groups.map((pg, pi) => pi !== idx
                        ? <option key={pi} value={pi}>{pg.name || `Squad ${pi + 1}`}</option>
                        : null
                      )}
                    </select>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-500 uppercase tracking-wider">Max slots</span>
                    <input type="number" min={0} max={999}
                      className="bg-slate-900 border border-slate-700 text-xs text-slate-300 rounded px-2 py-1.5 w-16 focus:border-specter-primary-cyan focus:outline-none"
                      value={g.max_members}
                      onChange={e => updateGroup(idx, { max_members: Math.max(0, Number(e.target.value)) })}
                    />
                  </div>
                </div>

                {/* Assigned members */}
                {g.member_user_ids.length > 0 && (
                  <div className="space-y-1">
                    {g.member_user_ids.map(uid => {
                      const member = orgMembers.find(m => m.user_id === uid);
                      return (
                        <div key={uid} className="flex items-center gap-2">
                          <span className="text-xs text-slate-300 w-28 truncate">{member?.callsign || uid}</span>
                          <input
                            className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 focus:border-specter-primary-cyan focus:outline-none"
                            placeholder="Role label (e.g. Medic)"
                            value={g.member_roles[uid] || ''}
                            onChange={e => setMemberRole(idx, uid, e.target.value)}
                          />
                          <button onClick={() => removeMemberFromGroup(idx, uid)}
                            className="text-slate-600 hover:text-red-400 transition-colors text-sm px-1">×</button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Add member dropdown */}
                {available.length > 0 && (
                  <select className={selectCls} value=""
                    onChange={e => { addMemberToGroup(idx, e.target.value); }}>
                    <option value="">+ Add member...</option>
                    {available.map(m => <option key={m.user_id} value={m.user_id}>{m.callsign}</option>)}
                  </select>
                )}
                {available.length === 0 && g.member_user_ids.length === 0 && (
                  <div className="text-xs text-slate-600">All members assigned or no members in server.</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3">
        <Button variant="secondary" size="sm" onClick={addGroup}>+ Add Group</Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save Groups'}</Button>
      </div>
    </div>
  );
}

function EventsTab({ org }) {
  const [events, setEvents]     = useState([]);
  const [orgMembers, setOrgMembers] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', start_time: '', end_time: '', access_mode: 'open' });
  const [msg, setMsg]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [evRes, memRes] = await Promise.all([
      api.getOrgEvents(org.id),
      api.getOrgMembers(org.id),
    ]);
    setEvents(evRes.data?.events || []);
    setOrgMembers(memRes.data?.members || []);
    setLoading(false);
  }, [org.id]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.start_time) return;
    const { error } = await api.createOrgEvent(org.id, {
      name:        form.name.trim(),
      start_time:  new Date(form.start_time).toISOString(),
      end_time:    form.end_time ? new Date(form.end_time).toISOString() : null,
      access_mode: form.access_mode,
    });
    if (error) setMsg({ type: 'error', text: error });
    else {
      setForm({ name: '', start_time: '', end_time: '', access_mode: 'open' });
      setShowCreate(false);
      load();
    }
  };

  const handleDelete = async (evId, name) => {
    if (!confirm(`Delete operation "${name}"?`)) return;
    const { error } = await api.deleteOrgEvent(org.id, evId);
    if (error) setMsg({ type: 'error', text: error });
    else { if (expandedId === evId) setExpandedId(null); load(); }
  };

  const statusOf = (ev) => {
    if (ev.launched_at || ev.launched) return { label: 'ACTIVE',    color: '#22c55e' };
    if (new Date(ev.start_time) < new Date()) return { label: 'PAST', color: '#6b7280' };
    return { label: 'SCHEDULED', color: '#22d3ee' };
  };

  if (loading) return <div className="text-slate-400 text-sm">Loading operations...</div>;

  return (
    <div className="space-y-4 max-w-3xl">
      <Msg msg={msg} onClear={() => setMsg(null)} />
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-white">Operations ({events.length})</h3>
        <Button variant="secondary" size="sm" onClick={() => setShowCreate(v => !v)}>
          {showCreate ? '× Cancel' : '+ New Operation'}
        </Button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="bg-slate-900/50 border border-slate-700 rounded-lg p-4 space-y-3">
          <div>
            <label className={labelCls}>Operation Name</label>
            <input className={inputCls} value={form.name} required maxLength={80}
              placeholder="e.g. Operation Ironwolf"
              onChange={e => setForm(s => ({ ...s, name: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Start Time</label>
              <input type="datetime-local" className={inputCls} value={form.start_time} required
                onChange={e => setForm(s => ({ ...s, start_time: e.target.value }))} />
            </div>
            <div>
              <label className={labelCls}>End Time (optional)</label>
              <input type="datetime-local" className={inputCls} value={form.end_time}
                onChange={e => setForm(s => ({ ...s, end_time: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Access Mode</label>
            <select className={inputCls} value={form.access_mode}
              onChange={e => setForm(s => ({ ...s, access_mode: e.target.value }))}>
              <option value="open">Open — all members can join</option>
              <option value="restricted">Restricted — assigned members only</option>
            </select>
          </div>
          <Button type="submit" disabled={!form.name.trim() || !form.start_time}>Create Operation</Button>
        </form>
      )}

      <div className="space-y-2">
        {events.map(ev => {
          const { label, color } = statusOf(ev);
          const isExpanded = expandedId === ev.id;
          return (
            <div key={ev.id} className="bg-slate-900/30 border border-slate-800 rounded-lg overflow-hidden hover:border-slate-600 transition-colors">
              <div className="px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white">{ev.name}</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {new Date(ev.start_time).toLocaleString()}
                    {ev.end_time && ` → ${new Date(ev.end_time).toLocaleString()}`}
                  </div>
                </div>
                <span className="text-[10px] font-mono tracking-wider flex-shrink-0" style={{ color }}>{label}</span>
                <Button variant="secondary" size="sm"
                  onClick={() => setExpandedId(isExpanded ? null : ev.id)}>
                  {isExpanded ? 'Close Groups' : 'Groups ▾'}
                </Button>
                <Button variant="danger" size="sm" onClick={() => handleDelete(ev.id, ev.name)}>Delete</Button>
              </div>

              {isExpanded && (
                <div className="border-t border-slate-700/60 px-4 pb-4 pt-3 bg-slate-900/40">
                  <EventGroupEditor org={org} ev={ev} orgMembers={orgMembers} />
                </div>
              )}
            </div>
          );
        })}
        {events.length === 0 && (
          <div className="text-slate-500 text-sm text-center py-8">No operations scheduled.</div>
        )}
      </div>
    </div>
  );
}

// ── Main WebServerManager ─────────────────────────────────────────────────────
const TABS = ['settings', 'roles', 'members', 'channels', 'bans', 'events'];

export default function WebServerManager({ org, user, onBack, embedded = false }) {
  const [activeTab, setActiveTab] = useState('settings');

  const isOwner = org.owner_id && org.owner_id === user?.id;
  const isMod   = isOwner || org.role_name === 'Commander' || (org.member_tier ?? 0) >= 99;

  const tabBar = (
    <div className={`flex border-b border-specter-primary-dim flex-wrap gap-x-1 px-4 pt-2 flex-shrink-0 ${embedded ? 'bg-specter-bg-surface' : 'bg-slate-900/50'}`}>
      {TABS.map(t => (
        <button key={t} onClick={() => setActiveTab(t)}
          className={`pb-3 px-2 text-sm font-medium transition-colors capitalize whitespace-nowrap ${
            activeTab === t
              ? 'text-specter-primary-cyan border-b-2 border-specter-primary-cyan'
              : 'text-slate-400 hover:text-slate-200'
          }`}>
          {t}
        </button>
      ))}
    </div>
  );

  const content = (
    <div className="flex-1 p-5 overflow-y-auto">
      {activeTab === 'settings' && <SettingsTab org={org} isMod={isMod} />}
      {activeTab === 'roles'    && <RolesTab    org={org} user={user} isOwner={isOwner} />}
      {activeTab === 'members'  && <MembersTab  org={org} user={user} isMod={isMod} />}
      {activeTab === 'channels' && <ChannelsTab org={org} isMod={isMod} />}
      {activeTab === 'bans'     && <BansTab     org={org} />}
      {activeTab === 'events'   && <EventsTab   org={org} />}
    </div>
  );

  if (embedded) {
    return (
      <div className="flex flex-col h-full">
        {tabBar}
        {content}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col max-w-4xl mx-auto w-full">
      <div className="bg-specter-bg-panel border border-specter-primary-dim rounded-lg shadow-xl overflow-hidden flex flex-col h-full">
        <div className="bg-slate-800/50 border-b border-specter-primary-dim px-6 py-4 flex items-center justify-between flex-shrink-0">
          <h2 className="text-xl font-bold text-white tracking-wide">
            {org.callsign} <span className="text-specter-text-muted text-sm font-normal ml-2">Server Management</span>
          </h2>
          <Button variant="secondary" onClick={onBack}>← Back</Button>
        </div>
        {tabBar}
        {content}
      </div>
    </div>
  );
}
