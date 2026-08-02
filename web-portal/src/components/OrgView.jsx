// src/components/OrgView.jsx
import React, { useState, useEffect } from 'react';
import { api } from '../api';
import CommLink from './CommLink';
import EventCalendar from './EventCalendar';
import FriendsPanel from './FriendsPanel';

const Button = ({ children, variant = 'primary', onClick, full = false, disabled = false, type = 'button' }) => {
  const base = `${full ? 'w-full' : ''} px-4 py-1 rounded text-xs font-bold tracking-wider transition-all duration-200 uppercase font-mono`;
  const variants = {
    primary:   'bg-specter-primary-cyan text-specter-bg-surface hover:bg-specter-primary-neon hover:shadow-[0_0_10px_rgba(6,182,212,0.3)]',
    secondary: 'bg-specter-bg-panel text-specter-text-muted hover:text-specter-text-main border border-specter-bg-panel hover:border-specter-primary-dim',
    ghost:     'text-specter-primary-cyan hover:text-specter-primary-neon underline-offset-4 hover:underline',
    danger:    'bg-red-900/50 text-red-200 border border-red-900 hover:bg-red-800',
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={`${base} ${variants[variant]} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
      {children}
    </button>
  );
};

const OrgView = ({ org, onBack, user }) => {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeChannel, setActiveChannel] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newChanName, setNewChanName] = useState('');
  const [isOverlay, setIsOverlay] = useState(false);
  const [showIdentity, setShowIdentity] = useState(false);
  const [identityForm, setIdentityForm] = useState({ alias: '', tag: '' });
  const [sidebarTab, setSidebarTab] = useState('channels'); // 'channels' | 'calendar'
  const [showFriends, setShowFriends] = useState(false);

  // Manage server state
  const [view, setView] = useState('channels'); // 'channels' | 'manage'
  const [members, setMembers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [inviteCode, setInviteCode] = useState(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [manageMsg, setManageMsg] = useState(null);
  const [orgSettings, setOrgSettings] = useState({ callsign: org.callsign || '', description: org.description || '', is_public: org.is_public ?? false });

  // User tier: derive from role_name if available (Commander=99, else 0)
  const userTier = org.role_name === 'Commander' ? 99 : (org.member_tier ?? 0);
  const isOwner = org.owner_id && org.owner_id === user?.id;
  const isMod = isOwner || org.role_name === 'Commander' || userTier >= 99;
  const canManageChannels = isMod || org.permissions?.can_manage_channels === true;

  // Move-member modal target
  const [moveTarget, setMoveTarget] = useState(null); // { userId, callsign }

  const fetchChannels = () => {
    setLoading(true);
    api.getChannels(org.id).then(({ data, error }) => {
      setLoading(false);
      if (error) setError(error);
      else setChannels(data.channels || []);
    });
  };

  useEffect(() => {
    fetchChannels();
    setIdentityForm({
      alias: org.alias_callsign || '',
      tag: org.org_tag_override || ''
    });
  }, [org.id]);

  // CA-1b: If OrgView unmounts while overlay mode is active (setDecorations(false)),
  // restore native decorations so the main window's X button keeps working.
  useEffect(() => {
    return () => {
      if (isOverlay && window.__TAURI__) {
        import('@tauri-apps/api/window')
          .then(({ getCurrentWindow }) => getCurrentWindow().setDecorations(true))
          .catch(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOverlay]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newChanName.trim()) return;
    const { data, error } = await api.createChannel(org.id, { name: newChanName });
    if (!error) {
      setNewChanName('');
      setShowCreate(false);
      fetchChannels();
    }
  };

  const handleDelete = async (chanId) => {
    if (!confirm('Confirm deletion?')) return;
    await api.deleteChannel(org.id, chanId);
    fetchChannels();
  };

  const toggleOverlay = async () => {
    if (window.__TAURI__) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const nextState = !isOverlay;
        await win.setAlwaysOnTop(nextState);
        await win.setDecorations(!nextState);
        
        // Optional logic: ignore cursor events
        // await win.setIgnoreCursorEvents(nextState);
        
        // Dim opacity slightly when overlay mode
        // Note: setting transparency requires macOS/Windows specific configs or html manipulation
        if (nextState) {
          document.body.style.backgroundColor = 'rgba(0,0,0,0.5)';
        } else {
          document.body.style.backgroundColor = '';
        }
        
        setIsOverlay(nextState);
      } catch (e) {
        console.error("Overlay toggle failed", e);
      }
    } else {
      alert("Overlay requires desktop app context.");
    }
  };

  const handleUpdateIdentity = async (e) => {
    e.preventDefault();
    const { error } = await api.updateOrgProfile(org.id, {
      alias_callsign: identityForm.alias || null,
      org_tag_override: identityForm.tag || null
    });
    if (!error) {
      alert("Identity updated. It may take a moment to reflect globally.");
      setShowIdentity(false);
      org.alias_callsign = identityForm.alias;
      org.org_tag_override = identityForm.tag;
    } else {
      alert("Failed to update identity: " + error);
    }
  };

  const fetchManageData = async () => {
    const [membersRes, rolesRes] = await Promise.all([
      api.getOrgMembers(org.id),
      api.getRoles(org.id),
    ]);
    if (!membersRes.error) setMembers(membersRes.data?.members || []);
    if (!rolesRes.error) setRoles(Array.isArray(rolesRes.data) ? rolesRes.data : []);
  };

  const handleGenerateInvite = async () => {
    setInviteLoading(true);
    const { data, error } = await api.createInvite(org.id);
    setInviteLoading(false);
    if (!error) {
      setInviteCode(data.code);
    } else {
      setManageMsg({ type: 'error', text: error });
    }
  };

  const handleCopyInvite = () => {
    const link = `${window.location.origin}/join/${inviteCode}`;
    navigator.clipboard.writeText(link);
    setInviteCopied(true);
    setTimeout(() => setInviteCopied(false), 2000);
  };

  const handleAssignRole = async (targetUserId, roleId) => {
    setManageMsg(null);
    const { error } = await api.assignMemberRole(org.id, targetUserId, roleId || null);
    if (error) {
      setManageMsg({ type: 'error', text: error });
    } else {
      setManageMsg({ type: 'success', text: 'Role updated.' });
      fetchManageData();
    }
  };

  const handleSaveOrgSettings = async () => {
    setManageMsg(null);
    const { error } = await api.updateOrgSettings(org.id, orgSettings);
    if (error) {
      setManageMsg({ type: 'error', text: error });
    } else {
      setManageMsg({ type: 'success', text: 'Server settings saved.' });
    }
  };

  const handleKickMember = async (targetUserId, callsign) => {
    if (!confirm(`Remove ${callsign} from the server?`)) return;
    setManageMsg(null);
    const { error } = await api.kickMember(org.id, targetUserId);
    if (error) {
      setManageMsg({ type: 'error', text: error });
    } else {
      setManageMsg({ type: 'success', text: `${callsign} removed.` });
      fetchManageData();
    }
  };

  const handleBanMember = async (targetUserId, callsign) => {
    const reason = prompt(`Ban reason for ${callsign}:`);
    if (reason === null) return;
    setManageMsg(null);
    const { error } = await api.banMember(org.id, targetUserId, reason || 'No reason provided');
    if (error) {
      setManageMsg({ type: 'error', text: error });
    } else {
      setManageMsg({ type: 'success', text: `${callsign} banned.` });
      fetchManageData();
    }
  };

  const handleMuteMember = async (targetUserId, callsign) => {
    setManageMsg(null);
    const { error } = await api.muteMember(org.id, targetUserId, true);
    if (error) {
      setManageMsg({ type: 'error', text: error });
    } else {
      setManageMsg({ type: 'success', text: `${callsign} muted.` });
    }
  };

  const handleMovePrompt = (targetUserId, callsign) => {
    setMoveTarget({ userId: targetUserId, callsign });
  };

  const handleMove = async (channelId) => {
    if (!moveTarget) return;
    setManageMsg(null);
    const { error } = await api.moveMember(org.id, moveTarget.userId, channelId);
    if (error) {
      setManageMsg({ type: 'error', text: error });
    } else {
      setManageMsg({ type: 'success', text: `${moveTarget.callsign} moved.` });
    }
    setMoveTarget(null);
  };

  return (
    <div className={`h-full flex gap-4 ${isOverlay ? 'overlay-mode opacity-80 scale-90' : ''}`}>
      {/* Sidebar */}
      <div className="w-64 flex flex-col gap-4">
        {/* Sidebar Tabs */}
        <div className="flex border-b border-specter-primary-dim">
          {[['channels','Channels'],['calendar','Calendar']].map(([tab, label]) => (
            <button key={tab} onClick={() => setSidebarTab(tab)}
              className={`flex-1 py-2 text-xs font-mono uppercase tracking-wider transition-colors ${
                sidebarTab === tab
                  ? 'text-specter-primary-cyan border-b-2 border-specter-primary-cyan -mb-px'
                  : 'text-specter-text-muted hover:text-specter-text-main'
              }`}>
              {label}
            </button>
          ))}
        </div>

        {sidebarTab === 'calendar' ? (
          <div className="flex-1 overflow-hidden">
            <EventCalendar org={org} />
          </div>
        ) : (
        <div className="bg-specter-bg-panel border border-specter-primary-dim rounded-lg p-3 flex-1 flex flex-col">
          <div className="flex justify-between items-center mb-4">
            <div className="text-xs text-specter-text-muted uppercase tracking-widest">Channels</div>
            {canManageChannels && <button onClick={() => setShowCreate(!showCreate)} className="text-specter-primary-cyan hover:text-white">+</button>}
          </div>

          {showCreate && (
            <form onSubmit={handleCreate} className="mb-4 space-y-2">
              <input
                className="w-full bg-black border border-specter-primary-dim text-xs p-2 text-white font-mono focus:border-specter-primary-cyan outline-none"
                placeholder="Channel Name"
                value={newChanName}
                onChange={e => setNewChanName(e.target.value)}
                autoFocus
              />
              <Button type="submit" full>Create</Button>
            </form>
          )}

          <div className="space-y-1 overflow-y-auto flex-1">
            {loading && <div className="text-xs text-gray-500 text-center">Scanning frequencies...</div>}
            {channels.map(c => {
              const locked = c.min_tier > userTier;
              return (
                <div
                  key={c.id}
                  onClick={() => !locked && setActiveChannel(c)}
                  className={`p-2 rounded flex justify-between group ${
                    locked
                      ? 'opacity-40 cursor-not-allowed text-gray-600'
                      : activeChannel?.id === c.id
                        ? 'bg-specter-primary-dim/30 text-specter-primary-neon border border-specter-primary-cyan/50 cursor-pointer'
                        : 'text-gray-400 hover:bg-specter-bg-surface hover:text-white cursor-pointer'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs opacity-50">{locked ? 'ðŸ”’' : '#'}</span>
                    <span className="font-mono text-sm">{c.name}</span>
                    {c.min_tier > 0 && (
                      <span className="text-xs font-mono text-specter-primary-dim border border-specter-primary-dim/40 rounded px-1">
                        T{c.min_tier}
                      </span>
                    )}
                  </div>
                  {!locked && canManageChannels && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(c.id); }}
                      className="hidden group-hover:block text-red-500 hover:text-red-400 text-xs"
                    >
                      &times;
                    </button>
                  )}
                </div>
              );
            })}
            {!loading && channels.length === 0 && (
              <div className="text-xs text-gray-600 text-center py-4">No channels.</div>
            )}
          </div>
        </div>
        )}

        {/* Org Info / Actions */}
        <div className="bg-specter-bg-panel border border-specter-primary-dim rounded-lg p-3 space-y-2">
          {showIdentity ? (
            <form onSubmit={handleUpdateIdentity} className="space-y-2 mb-2 p-2 border border-specter-primary-dim bg-black/50">
              <div className="text-xs text-specter-primary-cyan uppercase tracking-widest text-center mb-2">Edit Identity</div>
              <input
                className="w-full bg-black border border-specter-primary-dim text-xs p-2 text-white font-mono outline-none focus:border-specter-primary-cyan"
                placeholder="Alias Callsign"
                value={identityForm.alias}
                onChange={e => setIdentityForm({...identityForm, alias: e.target.value})}
              />
              <input
                className="w-full bg-black border border-specter-primary-dim text-xs p-2 text-white font-mono outline-none focus:border-specter-primary-cyan"
                placeholder="Org Tag Override"
                value={identityForm.tag}
                onChange={e => setIdentityForm({...identityForm, tag: e.target.value})}
                maxLength={16}
              />
              <div className="flex gap-2">
                <Button type="button" variant="secondary" onClick={() => setShowIdentity(false)} full>Cancel</Button>
                <Button type="submit" full>Save</Button>
              </div>
            </form>
          ) : (
            <Button variant="secondary" onClick={() => setShowIdentity(true)} full>Edit Identity</Button>
          )}
          {/* Manage Server — visible to owner, Commanders, and high-tier mods */}
          {isMod && (
            <Button
              variant={view === 'manage' ? 'primary' : 'secondary'}
              full
              onClick={() => {
                if (view === 'manage') {
                  setView('channels');
                } else {
                  setView('manage');
                  fetchManageData();
                }
              }}
            >
              {view === 'manage' ? 'â† Channels' : 'Manage Server'}
            </Button>
          )}
          <Button variant="secondary" onClick={() => setShowFriends(true)} full>Friends</Button>
          <Button variant="secondary" onClick={toggleOverlay} full>
            {isOverlay ? 'Exit Overlay' : 'Game Overlay (PiP)'}
          </Button>
          <Button variant="secondary" onClick={onBack} full>&lt; Return to Base</Button>
        </div>
      </div>

      {/* Main Area: Manage Panel, CommLink, or Placeholder */}
      <div className="flex-1 flex flex-col bg-specter-bg-panel border border-specter-primary-dim rounded-lg overflow-hidden relative">
        {view === 'manage' ? (
          /* â”€â”€â”€ Server Management Panel â”€â”€â”€ */
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="border-b border-specter-primary-dim px-4 py-3">
              <span className="text-specter-primary-cyan text-xs font-mono uppercase tracking-widest">
                Management â€” {org.callsign}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {manageMsg && (
                <div className={`border rounded px-3 py-2 text-xs font-mono ${
                  manageMsg.type === 'error'
                    ? 'bg-red-950 border-red-700 text-red-300'
                    : 'bg-green-950 border-green-700 text-green-300'
                }`}>
                  {manageMsg.text}
                </div>
              )}

              {/* Server Settings */}
              <div className="space-y-2">
                <div className="text-xs text-specter-text-muted uppercase tracking-widest">Server Settings</div>
                <input
                  className="w-full bg-black border border-specter-primary-dim rounded px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-specter-primary-cyan"
                  placeholder="Server Name (Callsign)"
                  value={orgSettings.callsign}
                  onChange={e => setOrgSettings(s => ({ ...s, callsign: e.target.value }))}
                />
                <input
                  className="w-full bg-black border border-specter-primary-dim rounded px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-specter-primary-cyan"
                  placeholder="Description (optional)"
                  value={orgSettings.description}
                  onChange={e => setOrgSettings(s => ({ ...s, description: e.target.value }))}
                />
                <label className="flex items-center gap-2 text-xs text-specter-text-muted cursor-pointer select-none">
                  <input type="checkbox" checked={orgSettings.is_public}
                    onChange={e => setOrgSettings(s => ({ ...s, is_public: e.target.checked }))}
                    className="accent-cyan-400" />
                  List in Public Directory
                </label>
                <Button onClick={handleSaveOrgSettings}>Save Settings</Button>
              </div>

              {/* Invite Link */}
              <div className="space-y-2">
                <div className="text-xs text-specter-text-muted uppercase tracking-widest">Server Invite Link</div>
                {!inviteCode ? (
                  <Button variant="secondary" onClick={handleGenerateInvite} disabled={inviteLoading}>
                    {inviteLoading ? 'Generating...' : 'Generate Invite Link'}
                  </Button>
                ) : (
                  <div className="flex items-center gap-2">
                    <code className="flex-1 bg-black border border-specter-primary-dim rounded px-3 py-2 text-xs text-specter-primary-cyan font-mono truncate">
                      {window.location.origin}/join/{inviteCode}
                    </code>
                    <Button variant="secondary" onClick={handleCopyInvite}>
                      {inviteCopied ? 'Copied!' : 'Copy'}
                    </Button>
                    <Button variant="ghost" onClick={() => setInviteCode(null)}>New</Button>
                  </div>
                )}
              </div>

              {/* Members List */}
              <div className="space-y-2">
                <div className="text-xs text-specter-text-muted uppercase tracking-widest">Members ({members.length})</div>
                {members.length === 0 ? (
                  <div className="text-specter-text-muted text-xs text-center py-4">No members loaded.</div>
                ) : (
                  <div className="space-y-1">
                    {members.map(m => (
                      <div key={m.user_id} className="flex items-center justify-between bg-specter-bg-surface border border-specter-primary-dim rounded px-3 py-2">
                        <div>
                          <span className="text-white text-sm font-mono">{m.callsign}</span>
                          <span className="ml-2 text-specter-text-muted text-xs">{m.role_name || 'â€”'}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <select
                            className="bg-specter-bg-panel border border-specter-primary-dim text-xs text-specter-text-main font-mono px-2 py-1 rounded focus:outline-none focus:border-specter-primary-cyan"
                            value={m.role_id || ''}
                            onChange={e => handleAssignRole(m.user_id, e.target.value)}
                          >
                            <option value="">â€” Role â€”</option>
                            {roles.map(r => (
                              <option key={r.id} value={r.id}>{r.name}</option>
                            ))}
                          </select>
                          {isMod && m.user_id !== user?.id && (
                            <>
                              <button
                                onClick={() => handleMuteMember(m.user_id, m.callsign)}
                                className="px-1.5 py-0.5 text-xs font-mono text-yellow-300 border border-yellow-700/50 rounded hover:bg-yellow-900/30"
                                title="Mute"
                              >ðŸ”‡</button>
                              {channels.filter(c => c.channel_kind === 0).length > 0 && (
                                <button
                                  onClick={() => handleMovePrompt(m.user_id, m.callsign)}
                                  className="px-1.5 py-0.5 text-xs font-mono text-blue-300 border border-blue-700/50 rounded hover:bg-blue-900/30"
                                  title="Move to channel"
                                >â†—</button>
                              )}
                              <button
                                onClick={() => handleKickMember(m.user_id, m.callsign)}
                                className="text-xs text-orange-400 hover:text-orange-300 font-mono transition-colors"
                              >kick</button>
                              <button
                                onClick={() => handleBanMember(m.user_id, m.callsign)}
                                className="text-xs text-red-500 hover:text-red-400 font-mono transition-colors"
                              >ban</button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : activeChannel ? (
          <CommLink key={activeChannel.id} org={org} channel={activeChannel} onBack={() => setActiveChannel(null)} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-specter-text-muted opacity-30">
            <div className="text-6xl mb-4 text-specter-primary-dim">â˜·</div>
            <div className="font-mono uppercase tracking-widest text-sm">Select a frequency to connect</div>
          </div>
        )}
      </div>

      {/* Friends Slide-Out */}
      {showFriends && (
        <FriendsPanel user={user} onClose={() => setShowFriends(false)} />
      )}

      {/* Move-to-channel modal */}
      {moveTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setMoveTarget(null)}>
          <div className="bg-specter-bg-surface border border-specter-primary-dim rounded p-4 space-y-2 min-w-[200px]" onClick={e => e.stopPropagation()}>
            <div className="text-xs text-specter-primary-cyan font-mono uppercase tracking-wider">Move {moveTarget.callsign} to:</div>
            {channels.filter(c => c.channel_kind === 0).map(c => (
              <button
                key={c.id}
                onClick={() => handleMove(c.id)}
                className="w-full text-left px-3 py-1.5 text-xs font-mono text-white hover:bg-specter-primary-dim/20 rounded border border-transparent hover:border-specter-primary-dim"
              >
                {c.name}
              </button>
            ))}
            <button onClick={() => setMoveTarget(null)} className="w-full text-xs font-mono text-specter-text-muted hover:text-red-400 pt-1">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default OrgView;
