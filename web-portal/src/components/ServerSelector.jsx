// ServerSelector.jsx — Post-login Application Shell
// Layout: persistent left sidebar (server list) + main content area
// Views: home | server | discovery | friends

import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import FriendsPanel from './FriendsPanel';
import WebServerManager from './WebServerManager';
import useEventStream from '../useEventStream';

// ── Org color palette (mirrors WarRoom) ─────────────────────────────────────

const ORG_COLORS = ['cyan', 'purple', 'green', 'yellow', 'blue', 'orange'];
const COLOR_MAP = {
  cyan:   { border: '#0891b2', text: '#67e8f9', bg: '#041e26', glow: '#06b6d4' },
  purple: { border: '#7c3aed', text: '#c084fc', bg: '#130d24', glow: '#9333ea' },
  green:  { border: '#16a34a', text: '#86efac', bg: '#031a0e', glow: '#22c55e' },
  yellow: { border: '#ca8a04', text: '#fde047', bg: '#1c1300', glow: '#eab308' },
  blue:   { border: '#2563eb', text: '#93c5fd', bg: '#050f24', glow: '#3b82f6' },
  orange: { border: '#c2410c', text: '#fdba74', bg: '#1c0a00', glow: '#f97316' },
};

const HEX_PATH = 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)';

function HexBadge({ letter, colorKey = 'cyan', size = 34, active = false }) {
  const c = COLOR_MAP[colorKey] || COLOR_MAP.cyan;
  const inner = Math.round(size * 0.82);
  const offset = (size - inner) / 2;
  return (
    <div style={{ width: size, height: size, position: 'relative', flexShrink: 0 }}>
      <div style={{
        clipPath: HEX_PATH, background: active ? c.glow : c.border,
        width: size, height: size, position: 'absolute',
        filter: active ? `drop-shadow(0 0 6px ${c.glow})` : 'none',
        opacity: active ? 1 : 0.65, transition: 'all 0.2s',
      }} />
      <div style={{
        clipPath: HEX_PATH, background: c.bg,
        width: inner, height: inner,
        position: 'absolute', top: offset, left: offset,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{ color: c.text, fontFamily: 'monospace', fontWeight: 'bold', fontSize: Math.round(size * 0.33), lineHeight: 1, userSelect: 'none' }}>
          {(letter || '?').toUpperCase()}
        </span>
      </div>
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-specter-bg-surface border border-specter-primary-dim rounded-lg p-6 w-full max-w-sm space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="text-specter-primary-cyan font-mono text-xs uppercase tracking-widest">{title}</span>
          <button onClick={onClose} className="text-specter-text-muted hover:text-specter-text-main text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Inline Discovery Panel ───────────────────────────────────────────────────

function DiscoveryPanel({ onJoin }) {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [joinState, setJoinState] = useState({});

  useEffect(() => {
    api.getPublicOrgs().then(({ data }) => {
      setServers(data?.servers || []);
      setLoading(false);
    });
  }, []);

  const handleJoin = async (serverId) => {
    setJoinState(s => ({ ...s, [serverId]: 'joining' }));
    const { data, error } = await api.joinOrg(serverId);
    if (error && !error.includes('Already')) {
      setJoinState(s => ({ ...s, [serverId]: 'error' }));
      return;
    }
    if (data?.message?.includes('Application')) {
      setJoinState(s => ({ ...s, [serverId]: 'applied' }));
    } else {
      setJoinState(s => ({ ...s, [serverId]: 'joined' }));
      setTimeout(() => onJoin(serverId), 600);
    }
  };

  return (
    <div className="p-6 max-w-2xl">
      <div className="text-[10px] text-specter-text-muted font-mono uppercase tracking-widest mb-4 opacity-50">// Public Server Directory</div>
      {loading ? (
        <div className="text-specter-text-muted text-xs text-center py-12 font-mono">Scanning frequencies...</div>
      ) : servers.length === 0 ? (
        <div className="text-specter-text-muted text-xs text-center py-12 font-mono">No public servers found.</div>
      ) : (
        <div className="space-y-2">
          {servers.map(server => {
            const state = joinState[server.id];
            return (
              <div
                key={server.id}
                className="bg-specter-bg-panel border border-specter-primary-dim rounded-lg px-5 py-4 flex items-center justify-between hover:border-specter-primary-cyan/50 transition-colors"
              >
                <div>
                  <div className="text-specter-text-main font-semibold text-sm">{server.callsign}</div>
                  {server.description && <div className="text-specter-text-muted text-xs mt-0.5">{server.description}</div>}
                  <div className="text-specter-primary-dim text-xs mt-1 font-mono">{server.member_count} members</div>
                </div>
                <div className="flex-shrink-0 ml-4">
                  {state === 'joining' && <span className="text-xs text-specter-text-muted font-mono">Joining...</span>}
                  {state === 'joined'  && <span className="text-xs text-specter-state-success font-mono">Joined ✓</span>}
                  {state === 'applied' && <span className="text-xs text-specter-state-warning font-mono">Pending</span>}
                  {state === 'error'   && <span className="text-xs text-specter-state-error font-mono">Error</span>}
                  {!state && (
                    <button
                      onClick={() => handleJoin(server.id)}
                      className="px-3 py-1.5 rounded border border-specter-primary-dim text-specter-primary-cyan text-xs font-mono hover:bg-specter-primary-dim/20 hover:border-specter-primary-cyan transition-colors uppercase tracking-wider"
                    >
                      Add
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main Shell ───────────────────────────────────────────────────────────────

const isTauri = Boolean(window.__TAURI__);

export default function ServerSelector({
  user,
  onSelectServer,
  onLogout,
  onOpenSettings,
  onDownload,
  autoJoinLast,
  initialConnectOrgId,
}) {
  const [orgs, setOrgs]                       = useState([]);
  const [loading, setLoading]                 = useState(true);
  const [selectedOrg, setSelectedOrg]         = useState(null);
  const [activeView, setActiveView]           = useState('home');
  const [msg, setMsg]                         = useState(null);
  const [showJoinModal, setShowJoinModal]     = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [joinCode, setJoinCode]               = useState('');
  const [createForm, setCreateForm]           = useState({ callsign: '', description: '', is_public: false });

  useEffect(() => {
    api.getMyOrgs().then(({ data, error }) => {
      setLoading(false);
      if (!error && data?.orgs) {
        setOrgs(data.orgs);
        if (autoJoinLast && data.orgs.length > 0) {
          const lastId = localStorage.getItem('specter_last_server');
          const target = data.orgs.find(o => o.id === lastId) || data.orgs[0];
          selectOrg(target);
        } else if (initialConnectOrgId) {
          const target = data.orgs.find(o => o.id === initialConnectOrgId);
          if (target) selectOrg(target);
        }
      }
    });
  }, []);

  const refreshOrgs = useCallback(() => {
    api.getMyOrgs().then(({ data }) => {
      if (data?.orgs) setOrgs(data.orgs);
    });
  }, []);

  useEventStream({
    orgs_changed:   refreshOrgs,
    org_created:    refreshOrgs,
    member_joined:  refreshOrgs,
    member_removed: refreshOrgs,
  });

  const selectOrg = (org) => {
    localStorage.setItem('specter_last_server', org.id);
    setSelectedOrg(org);
    setActiveView('landing');
    if (onSelectServer) onSelectServer(org);
  };

  const handleNavClick = (view) => {
    setActiveView(view);
    setSelectedOrg(null);
  };

  const handleJoin = async (e) => {
    e.preventDefault();
    setMsg(null);
    const { data, error } = await api.redeemInvite(joinCode);
    if (error) return setMsg({ type: 'error', text: error });
    setOrgs(prev => [...prev, data.org]);
    setMsg({ type: 'success', text: `Joined "${data.org?.callsign}".` });
    setShowJoinModal(false);
    setJoinCode('');
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setMsg(null);
    const { data, error } = await api.createOrg(createForm);
    if (error) return setMsg({ type: 'error', text: error });
    const newOrg = data.org;
    setOrgs(prev => [...prev, newOrg]);
    setShowCreateModal(false);
    setCreateForm({ callsign: '', description: '', is_public: false });
    selectOrg(newOrg);
  };

  const handleLogout = () => {
    localStorage.removeItem('specter_token');
    localStorage.removeItem('specter_user');
    onLogout();
  };

  const breadcrumb = selectedOrg
    ? selectedOrg.callsign
    : activeView === 'discovery' ? 'Explore Servers'
    : activeView === 'friends'   ? 'Friends'
    : 'Home';

  const selectedOrgColorKey = selectedOrg
    ? ORG_COLORS[orgs.findIndex(o => o.id === selectedOrg.id) % ORG_COLORS.length] || 'cyan'
    : 'cyan';

  const modalInput = 'w-full rounded px-3 py-2 text-sm font-mono text-white focus:outline-none transition-colors bg-specter-bg-deep border border-specter-primary-dim focus:border-specter-primary-cyan';
  const modalLabel = 'text-[11px] text-specter-text-muted font-mono uppercase tracking-wider block mb-1.5';
  const modalBtn   = 'w-full px-4 py-2 rounded text-sm font-bold font-mono uppercase tracking-wider bg-specter-primary-cyan text-specter-bg-surface hover:bg-specter-primary-neon transition-colors';

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-specter-bg-deep text-specter-text-main font-sans">

      {/* ════════════════════════════════════════════════════════
          LEFT SIDEBAR
          ════════════════════════════════════════════════════════ */}
      <aside className="w-[260px] flex flex-col flex-shrink-0 bg-specter-bg-surface border-r border-specter-primary-dim">

        {/* Brand */}
        <div className="px-5 pt-5 pb-4 border-b border-specter-primary-dim">
          <div className="text-specter-primary-cyan font-mono font-bold tracking-[0.25em] text-sm">SPECTERCOMS</div>
          <div className="text-specter-text-muted font-mono text-[10px] tracking-wider mt-0.5 opacity-50">SECURE COMMS PLATFORM</div>
        </div>

        {/* Navigation */}
        <nav className="px-2 py-3 border-b border-specter-primary-dim space-y-0.5">
          {[
            { id: 'home',      label: 'Home' },
            { id: 'discovery', label: 'Explore Servers' },
            { id: 'friends',   label: 'Friends' },
          ].map(item => (
            <button
              key={item.id}
              onClick={() => handleNavClick(item.id)}
              className={`w-full text-left px-3 py-2 rounded text-xs font-mono uppercase tracking-wider transition-colors ${
                activeView === item.id && !selectedOrg
                  ? 'bg-specter-primary-dim/40 text-specter-primary-cyan'
                  : 'text-specter-text-muted hover:text-specter-text-main hover:bg-specter-bg-panel'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {/* Server List */}
        <div className="flex-1 overflow-y-auto py-3 px-2 min-h-0">
          <div className="text-[10px] text-specter-text-muted font-mono uppercase tracking-widest px-3 mb-2 opacity-50">
            My Servers
          </div>
          {loading ? (
            <div className="text-xs text-specter-text-muted px-3 py-2 font-mono opacity-50">Loading...</div>
          ) : orgs.length === 0 ? (
            <div className="text-[11px] text-specter-text-muted px-3 py-4 text-center font-mono opacity-50">No servers yet.</div>
          ) : (
            <div className="space-y-0.5">
              {orgs.map((org, i) => {
                const colorKey = ORG_COLORS[i % ORG_COLORS.length];
                const isActive = selectedOrg?.id === org.id;
                return (
                  <button
                    key={org.id}
                    onClick={() => selectOrg(org)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded transition-all text-left group ${
                      isActive
                        ? 'bg-specter-primary-dim/30 border border-specter-primary-dim/60'
                        : 'hover:bg-specter-bg-panel'
                    }`}
                  >
                    <HexBadge letter={org.callsign?.[0]} colorKey={colorKey} size={32} active={isActive} />
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm font-semibold truncate transition-colors ${
                        isActive ? 'text-specter-primary-cyan' : 'text-specter-text-main group-hover:text-specter-primary-neon'
                      }`}>
                        {org.callsign}
                      </div>
                      {org.role_name && (
                        <div className="text-[11px] text-specter-text-muted opacity-60 font-mono truncate">{org.role_name}</div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Add server actions */}
        <div className="px-2 py-2 border-t border-specter-primary-dim space-y-0.5">
          <button
            onClick={() => setShowJoinModal(true)}
            className="w-full text-left px-3 py-1.5 rounded text-[11px] font-mono text-specter-text-muted hover:text-specter-primary-cyan hover:bg-specter-bg-panel transition-colors uppercase tracking-wider"
          >
            + Join via Code
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="w-full text-left px-3 py-1.5 rounded text-[11px] font-mono text-specter-text-muted hover:text-specter-primary-cyan hover:bg-specter-bg-panel transition-colors uppercase tracking-wider"
          >
            + Create Server
          </button>
        </div>

        {/* User profile strip */}
        <div className="px-3 py-3 border-t border-specter-primary-dim bg-specter-bg-panel flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-full border border-specter-primary-dim flex items-center justify-center text-specter-primary-cyan font-bold text-sm font-mono flex-shrink-0"
            style={{ background: '#041e26' }}
          >
            {user.callsign?.[0]?.toUpperCase() ?? '?'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-specter-text-main truncate">
              {user.global_tag
                ? <span className="text-specter-state-warning mr-1">[{user.global_tag}]</span>
                : null
              }
              {user.callsign}
            </div>
            <div className="text-[11px] text-specter-text-muted font-mono opacity-50">Operator</div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {onOpenSettings && (
              <button
                onClick={onOpenSettings}
                title="Settings"
                className="w-7 h-7 rounded flex items-center justify-center text-specter-text-muted hover:text-specter-primary-cyan hover:bg-specter-bg-surface transition-colors"
              >
                ⚙
              </button>
            )}
            <button
              onClick={handleLogout}
              title="Log Out"
              className="w-7 h-7 rounded flex items-center justify-center text-specter-text-muted hover:text-red-400 hover:bg-specter-bg-surface transition-colors"
            >
              ⏻
            </button>
          </div>
        </div>
      </aside>

      {/* ════════════════════════════════════════════════════════
          MAIN CONTENT AREA
          ════════════════════════════════════════════════════════ */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden">

        {/* Top bar / breadcrumb */}
        <header className="flex-shrink-0 h-11 border-b border-specter-primary-dim bg-specter-bg-surface flex items-center px-6 gap-3">
          {selectedOrg ? (
            <>
              <HexBadge letter={selectedOrg.callsign?.[0]} colorKey={selectedOrgColorKey} size={20} active />
              <span className="text-specter-primary-cyan font-mono font-bold text-sm tracking-wide">{selectedOrg.callsign}</span>
              <span className="text-specter-text-muted text-xs font-mono opacity-50">// Server Management</span>
            </>
          ) : (
            <span className="text-specter-primary-cyan font-mono text-xs tracking-widest uppercase">{breadcrumb}</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {!isTauri && onDownload && (
              <button
                onClick={onDownload}
                className="px-3 py-1 rounded border border-specter-primary-dim text-specter-primary-cyan text-[11px] font-mono hover:bg-specter-primary-dim/20 transition-colors uppercase tracking-wider"
              >
                Download Client
              </button>
            )}
          </div>
        </header>

        {/* Inline notification */}
        {msg && (
          <div className={`flex-shrink-0 mx-6 mt-3 rounded px-4 py-2 text-xs font-mono flex items-center justify-between ${
            msg.type === 'error'
              ? 'bg-red-950 border border-red-800 text-red-300'
              : 'bg-green-950 border border-green-800 text-green-300'
          }`}>
            <span>{msg.text}</span>
            <button className="opacity-60 hover:opacity-100 ml-4" onClick={() => setMsg(null)}>×</button>
          </div>
        )}

        {/* Scrollable content pane */}
        <div className="flex-1 overflow-y-auto min-h-0">

          {/* ── HOME ───────────────────────────────────────── */}
          {activeView === 'home' && !selectedOrg && (
            <div className="p-6 max-w-2xl space-y-6">

              <section>
                <div className="text-[10px] text-specter-text-muted font-mono uppercase tracking-widest mb-3 opacity-50">// Account</div>
                <div className="bg-specter-bg-panel border border-specter-primary-dim rounded-lg p-5 flex items-center gap-5">
                  <div
                    className="w-14 h-14 rounded-full border-2 border-specter-primary-cyan flex items-center justify-center text-specter-primary-cyan font-bold text-2xl font-mono flex-shrink-0"
                    style={{ background: '#041e26' }}
                  >
                    {user.callsign?.[0]?.toUpperCase() ?? '?'}
                  </div>
                  <div>
                    <div className="text-specter-text-main font-bold text-lg">
                      {user.global_tag
                        ? <span className="text-specter-state-warning mr-2">[{user.global_tag}]</span>
                        : null
                      }
                      {user.callsign}
                    </div>
                    <div className="text-specter-text-muted text-xs font-mono opacity-60 mt-0.5">
                      {orgs.length} Server{orgs.length !== 1 ? 's' : ''}&nbsp;·&nbsp;Operator
                    </div>
                  </div>
                  {onOpenSettings && (
                    <button
                      onClick={onOpenSettings}
                      className="ml-auto px-3 py-1.5 rounded border border-specter-primary-dim text-specter-text-muted hover:text-specter-primary-cyan hover:border-specter-primary-cyan text-xs font-mono transition-colors uppercase tracking-wider"
                    >
                      Edit Profile
                    </button>
                  )}
                </div>
              </section>

              {!isTauri && onDownload && (
                <section>
                  <div className="text-[10px] text-specter-text-muted font-mono uppercase tracking-widest mb-3 opacity-50">// Desktop Client</div>
                  <div className="bg-specter-bg-panel border border-specter-primary-cyan/40 rounded-lg p-5 flex items-center justify-between">
                    <div>
                      <div className="text-specter-text-main font-semibold text-sm">SpecterComs Desktop</div>
                      <div className="text-specter-text-muted text-xs mt-1 opacity-70">
                        Native voice, full platform access, and hardware integration.
                      </div>
                    </div>
                    <button
                      onClick={onDownload}
                      className="flex-shrink-0 ml-6 px-4 py-2 rounded bg-specter-primary-cyan text-specter-bg-surface text-xs font-bold font-mono uppercase tracking-wider hover:bg-specter-primary-neon transition-colors"
                    >
                      Download
                    </button>
                  </div>
                </section>
              )}

              {orgs.length > 0 && (
                <section>
                  <div className="text-[10px] text-specter-text-muted font-mono uppercase tracking-widest mb-3 opacity-50">// Your Servers</div>
                  <div className="space-y-1.5">
                    {orgs.map((org, i) => (
                      <button
                        key={org.id}
                        onClick={() => selectOrg(org)}
                        className="w-full flex items-center gap-4 px-4 py-3 bg-specter-bg-panel border border-specter-primary-dim rounded-lg hover:border-specter-primary-cyan/50 hover:shadow-[0_0_12px_rgba(6,182,212,0.15)] transition-all text-left group"
                      >
                        <HexBadge letter={org.callsign?.[0]} colorKey={ORG_COLORS[i % ORG_COLORS.length]} size={36} />
                        <div className="flex-1 min-w-0">
                          <div className="text-specter-text-main font-semibold text-sm group-hover:text-specter-primary-cyan transition-colors truncate">
                            {org.callsign}
                          </div>
                          {org.role_name && (
                            <div className="text-specter-text-muted text-xs font-mono opacity-60">{org.role_name}</div>
                          )}
                        </div>
                        <span className="text-specter-text-muted text-xs font-mono opacity-40 group-hover:opacity-80 group-hover:text-specter-primary-cyan transition-all flex-shrink-0">
                          Manage →
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {orgs.length === 0 && !loading && (
                <section>
                  <div className="bg-specter-bg-panel border border-specter-primary-dim rounded-lg p-8 text-center space-y-4">
                    <div className="text-specter-text-muted text-sm font-mono opacity-60">No servers yet.</div>
                    <div className="flex justify-center gap-3">
                      <button
                        onClick={() => setShowJoinModal(true)}
                        className="px-4 py-2 rounded border border-specter-primary-dim text-specter-primary-cyan text-xs font-mono hover:bg-specter-primary-dim/20 transition-colors uppercase tracking-wider"
                      >
                        Join via Code
                      </button>
                      <button
                        onClick={() => handleNavClick('discovery')}
                        className="px-4 py-2 rounded border border-specter-primary-dim text-specter-primary-cyan text-xs font-mono hover:bg-specter-primary-dim/20 transition-colors uppercase tracking-wider"
                      >
                        Explore Servers
                      </button>
                    </div>
                  </div>
                </section>
              )}
            </div>
          )}

          {/* ── SERVER LANDING ──────────────────────────────── */}
          {activeView === 'landing' && selectedOrg && (
            <div className="h-full flex flex-col p-8 max-w-2xl">
              <div className="mb-6">
                <div className="text-2xl font-mono font-bold text-specter-primary-cyan tracking-widest uppercase mb-1">
                  {selectedOrg.callsign}
                </div>
                {selectedOrg.description && (
                  <div className="text-sm text-specter-text-muted font-mono leading-relaxed whitespace-pre-wrap">
                    {selectedOrg.description}
                  </div>
                )}
              </div>
              <button
                onClick={() => setActiveView('server')}
                className="self-start px-5 py-2 rounded text-sm font-bold font-mono uppercase tracking-wider bg-specter-primary-cyan text-specter-bg-surface hover:bg-specter-primary-neon transition-colors"
              >
                Manage Server
              </button>
            </div>
          )}

          {/* ── SERVER MANAGEMENT ───────────────────────────── */}
          {activeView === 'server' && selectedOrg && (
            <div className="h-full flex flex-col">
              <WebServerManager
                org={selectedOrg}
                user={user}
                onBack={() => handleNavClick('home')}
                embedded
              />
            </div>
          )}

          {/* ── DISCOVERY ───────────────────────────────────── */}
          {activeView === 'discovery' && (
            <DiscoveryPanel
              onJoin={() => {
                refreshOrgs();
                setMsg({ type: 'success', text: 'Server added — select it from the sidebar.' });
                setActiveView('home');
              }}
            />
          )}

        </div>
      </div>

      {/* Friends panel — fixed overlay */}
      {activeView === 'friends' && (
        <FriendsPanel user={user} onClose={() => setActiveView('home')} />
      )}

      {/* ── Join Modal ──────────────────────────────────────── */}
      {showJoinModal && (
        <Modal title="Join via Invite Code" onClose={() => { setShowJoinModal(false); setJoinCode(''); }}>
          <form onSubmit={handleJoin} className="space-y-4">
            <div>
              <label className={modalLabel}>Invite Code</label>
              <input
                className={modalInput}
                placeholder="e.g. IRONWOLF42"
                value={joinCode}
                onChange={e => setJoinCode(e.target.value)}
                required
                autoFocus
              />
            </div>
            <button type="submit" className={modalBtn}>Join Server</button>
          </form>
        </Modal>
      )}

      {/* ── Create Modal ────────────────────────────────────── */}
      {showCreateModal && (
        <Modal title="Create New Server" onClose={() => { setShowCreateModal(false); setCreateForm({ callsign: '', description: '', is_public: false }); setMsg(null); }}>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className={modalLabel}>Server Name</label>
              <input
                className={modalInput}
                placeholder="e.g. IRONWOLF"
                value={createForm.callsign}
                onChange={e => setCreateForm(f => ({ ...f, callsign: e.target.value }))}
                required
                autoFocus
              />
            </div>
            <div>
              <label className={modalLabel}>
                Description <span className="normal-case opacity-40">(optional)</span>
              </label>
              <input
                className={modalInput}
                placeholder="Brief description..."
                value={createForm.description}
                onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))}
              />
            </div>
            <label className="flex items-center gap-2.5 text-xs text-specter-text-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={createForm.is_public}
                onChange={e => setCreateForm(f => ({ ...f, is_public: e.target.checked }))}
                className="accent-cyan-400 w-3.5 h-3.5"
              />
              List in Public Directory
            </label>
            {msg && msg.type === 'error' && (
              <div className="text-xs font-mono text-red-400 bg-red-950 border border-red-800 rounded px-3 py-2">
                {msg.text}
              </div>
            )}
            <button type="submit" className={modalBtn}>Create Server</button>
          </form>
        </Modal>
      )}

    </div>
  );
}

