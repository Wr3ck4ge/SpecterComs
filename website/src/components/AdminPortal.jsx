import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api';

// ─── Design primitives ────────────────────────────────────────────────────────

const RBtn = ({ children, onClick, variant = 'default', disabled = false, small = false }) => {
  const pad  = small ? 'px-2 py-0.5 text-xs' : 'px-3 py-1.5 text-xs';
  const vars = {
    default: 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-100',
    danger:  'border border-red-300 bg-red-50 text-red-700 hover:bg-red-100',
    success: 'border border-green-300 bg-green-50 text-green-700 hover:bg-green-100',
    ghost:   'text-gray-500 hover:text-gray-800',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${pad} rounded font-medium tracking-wide transition-colors ${vars[variant]} ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      {children}
    </button>
  );
};

const StatCard = ({ label, value, sub }) => (
  <div className="border border-gray-200 bg-white rounded-lg p-4 shadow-sm space-y-1">
    <div className="text-xs uppercase tracking-widest text-gray-500 font-medium">{label}</div>
    <div className="text-4xl font-bold text-gray-800">{value}</div>
    {sub && <div className="text-xs text-gray-400">{sub}</div>}
  </div>
);

const Table = ({ cols, children, empty = 'No records.' }) => (
  // Scrolls horizontally on narrow screens instead of squashing columns or
  // breaking the page-level layout — tables are the main mobile-usability
  // blocker in this portal since they have too many columns to reflow.
  <div className="overflow-x-auto">
    <table className="w-full text-left text-sm min-w-[640px]">
      <thead>
        <tr className="border-b border-gray-200 text-gray-500 text-xs uppercase tracking-wider">
          {cols.map(c => <th key={c} className="px-4 py-3 font-medium">{c}</th>)}
        </tr>
      </thead>
      <tbody>
        {React.Children.count(children) === 0
          ? <tr><td colSpan={cols.length} className="px-4 py-6 text-center text-gray-400 text-sm">{empty}</td></tr>
          : children
        }
      </tbody>
    </table>
  </div>
);

const SearchBar = ({ value, onChange, placeholder = 'Search...' }) => (
  <input
    className="bg-white border border-gray-300 rounded focus:border-gray-500 focus:outline-none px-3 py-1.5 text-gray-800 text-sm w-64 placeholder-gray-400"
    value={value}
    onChange={e => onChange(e.target.value)}
    placeholder={placeholder}
  />
);

const Alert = ({ children, onDismiss, type = 'error' }) => {
  const styles = type === 'error'
    ? 'bg-red-50 border-red-300 text-red-700'
    : 'bg-green-50 border-green-300 text-green-700';
  return (
    <div className={`border rounded px-4 py-2 text-sm flex items-center justify-between ${styles}`}>
      <span>{children}</span>
      {onDismiss && <button onClick={onDismiss} className="ml-4 opacity-60 hover:opacity-100">&times;</button>}
    </div>
  );
};

// ─── Section: Dashboard ───────────────────────────────────────────────────────

function SectionDashboard({ token, onError }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.adminGetOverview(token).then(({ data, error }) => {
      if (error) onError(error);
      else setData(data);
    });
  }, [token]);

  if (!data) return <div className="text-gray-400 text-sm p-8 text-center">Loading dashboard...</div>;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatCard label="Users"    value={data.stats.users}    />
        <StatCard label="Organizations" value={data.stats.orgs}     />
        <StatCard label="Channels"      value={data.stats.channels} />
        <StatCard label="Blacklisted"   value={data.stats.banned}   />
        <StatCard label="HWID Bans"     value={data.stats.hwidBans} />
      </div>

      <div className="border border-gray-200 bg-white rounded-lg p-4 flex items-center gap-3 shadow-sm">
        <span className="w-2.5 h-2.5 rounded-full bg-green-500 flex-shrink-0" />
        <span className="text-sm font-medium text-gray-700">System Status: {data.status?.toUpperCase() ?? 'OPERATIONAL'}</span>
        {data.admins?.[0]?.last_login && (
          <span className="text-gray-400 text-xs ml-auto">
            Last login: {new Date(data.admins[0].last_login).toLocaleString()} ({data.admins[0].username})
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 text-xs uppercase tracking-wider text-gray-500 font-medium">Recent Registrations</div>
          <div className="divide-y divide-gray-100">
            {data.recentUsers?.length > 0
              ? data.recentUsers.map((u, i) => (
                <div key={i} className="px-4 py-2 flex justify-between text-sm">
                  <span className="font-medium text-gray-800">{u.callsign}</span>
                  <span className="text-gray-400 text-xs">{new Date(u.created_at).toLocaleDateString()}</span>
                </div>
              ))
              : <div className="px-4 py-4 text-sm text-gray-400">No recent registrations.</div>
            }
          </div>
        </div>
        <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 text-xs uppercase tracking-wider text-gray-500 font-medium">Recent Organizations</div>
          <div className="divide-y divide-gray-100">
            {data.recentOrgs?.length > 0
              ? data.recentOrgs.map((o, i) => (
                <div key={i} className="px-4 py-2 flex justify-between text-sm">
                  <span className="font-medium text-gray-800">{o.callsign}</span>
                  <span className="text-gray-400 text-xs">{new Date(o.created_at).toLocaleDateString()}</span>
                </div>
              ))
              : <div className="px-4 py-4 text-sm text-gray-400">No recent organizations.</div>
            }
          </div>
        </div>
      </div>

      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 text-xs uppercase tracking-wider text-gray-500 font-medium">Admin Accounts</div>
        <Table cols={['Username', 'Last Login']}>
          {data.admins?.map((a, i) => (
            <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="px-4 py-3 font-semibold text-gray-800">{a.username}</td>
              <td className="px-4 py-3 text-gray-500 text-sm">{a.last_login ? new Date(a.last_login).toLocaleString() : 'Never'}</td>
            </tr>
          ))}
        </Table>
      </div>
    </div>
  );
}

// ─── Section: Users ───────────────────────────────────────────────────────────

function BanModal({ user, onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="border border-gray-300 bg-white rounded-lg shadow-xl w-full max-w-md p-6 space-y-4">
        <div className="text-gray-800 font-semibold border-b border-gray-200 pb-3">
          {user.is_banned ? 'Revoke Ban' : 'Ban User'} — {user.callsign}
        </div>
        {!user.is_banned && (
          <div>
            <label className="text-xs text-gray-500 uppercase tracking-wider block mb-1">Reason (optional)</label>
            <input
              className="w-full bg-white border border-gray-300 rounded focus:border-gray-500 focus:outline-none p-2 text-gray-800 text-sm"
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. Terms of Service violation"
            />
          </div>
        )}
        <div className="flex gap-3 pt-1 justify-end">
          <RBtn variant="ghost" onClick={onClose}>Cancel</RBtn>
          <RBtn variant="danger" onClick={() => onConfirm(user.id, !user.is_banned, reason)}>
            {user.is_banned ? 'Revoke Ban' : 'Confirm Ban'}
          </RBtn>
        </div>
      </div>
    </div>
  );
}

function UserDetailModal({ token, userId, onClose }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.adminGetUser(token, userId).then(({ data }) => setData(data));
  }, [userId]);

  if (!data) return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="text-gray-500 text-sm bg-white p-6 rounded shadow">Loading...</div>
    </div>
  );

  const u = data.user;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="border border-gray-200 bg-white rounded-lg shadow-xl w-full max-w-lg p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center border-b border-gray-200 pb-3">
          <span className="font-semibold text-gray-800">{u.callsign} — User Detail</span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">&times;</button>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          {[
            ['UUID',         u.id],
            ['Tag',          u.global_tag || '—'],
            ['Tier',         u.subscription_tier],
            ['Timezone',     u.timezone || '—'],
            ['Account Ban',  u.is_banned ? '⚠ BANNED' : 'Clear'],
            ['HWID Ban',     u.is_hwid_banned ? '⚠ HWID BANNED' : 'Clear'],
            ['Joined',       new Date(u.created_at).toLocaleDateString()],
            ['HWID',         u.hwid ? u.hwid.substring(0, 16) + '...' : '—'],
          ].map(([label, val]) => (
            <div key={label}>
              <div className="text-gray-400 text-xs uppercase tracking-wider mb-0.5">{label}</div>
              <div className={`font-medium ${String(val).includes('⚠') ? 'text-red-600' : 'text-gray-800'}`}>{val}</div>
            </div>
          ))}
        </div>
        {data.orgs?.length > 0 && (
          <div>
            <div className="text-gray-400 text-xs uppercase tracking-wider mb-2">Org Memberships ({data.orgs.length})</div>
            <div className="space-y-1 max-h-40 overflow-y-auto rounded border border-gray-200">
              {data.orgs.map(o => (
                <div key={o.id} className="flex justify-between text-sm px-3 py-1.5 bg-gray-50 border-b border-gray-100 last:border-0">
                  <span className="font-medium text-gray-700">{o.callsign}</span>
                  <span className="text-gray-400">{o.role_name || 'Member'}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionUsers({ token, onError }) {
  const [users, setUsers]           = useState([]);
  const [total, setTotal]           = useState(0);
  const [page, setPage]             = useState(1);
  const [q, setQ]                   = useState('');
  const [loading, setLoading]       = useState(true);
  const [banTarget, setBanTarget]   = useState(null);
  const [detailId, setDetailId]     = useState(null);
  const [msg, setMsg]               = useState(null);
  const searchTimer                 = React.useRef(null);

  const fetchUsers = useCallback((query, pg) => {
    setLoading(true);
    api.adminGetUsers(token, query, pg).then(({ data, error }) => {
      setLoading(false);
      if (error) { onError(error); return; }
      setUsers(data.users || []);
      setTotal(data.total || 0);
      setPage(data.page || 1);
    });
  }, [token]);

  useEffect(() => { fetchUsers('', 1); }, [fetchUsers]);

  const handleSearch = (val) => {
    setQ(val);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => fetchUsers(val, 1), 400);
  };

  const handleBan = async (userId, ban, reason) => {
    const { error } = await api.adminBanUser(token, userId, ban, reason);
    if (error) { onError(error); return; }
    setMsg(`User ${ban ? 'banned' : 'unbanned'}.`);
    setBanTarget(null);
    fetchUsers(q, page);
  };

  const totalPages = Math.ceil(total / 50);

  return (
    <div className="space-y-4">
      {msg && <Alert type="success" onDismiss={() => setMsg(null)}>{msg}</Alert>}

      <div className="flex items-center justify-between">
        <SearchBar value={q} onChange={handleSearch} placeholder="Search callsign / tag..." />
        <span className="text-sm text-gray-500">{total} users</span>
      </div>

      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <Table cols={['UUID', 'Callsign', 'Tag', 'Tier', 'Joined', 'Status', 'Actions']}>
          {loading
            ? <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400 text-sm">Loading users...</td></tr>
            : users.map(u => (
              <tr key={u.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3 text-gray-400 text-xs font-mono">{u.id.split('-')[0]}…</td>
                <td className="px-4 py-3">
                  <button onClick={() => setDetailId(u.id)} className="font-semibold text-gray-800 hover:text-blue-600 text-sm">{u.callsign}</button>
                </td>
                <td className="px-4 py-3 text-gray-500 text-sm">{u.global_tag || '—'}</td>
                <td className="px-4 py-3 text-gray-500 text-sm">{u.subscription_tier}</td>
                <td className="px-4 py-3 text-gray-400 text-sm">{new Date(u.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-3">
                  {u.is_banned
                    ? <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded text-xs font-medium">Banned</span>
                    : <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded text-xs font-medium">Active</span>
                  }
                </td>
                <td className="px-4 py-3 text-right">
                  <RBtn small variant={u.is_banned ? 'success' : 'danger'} onClick={() => setBanTarget(u)}>
                    {u.is_banned ? 'Unban' : 'Ban'}
                  </RBtn>
                </td>
              </tr>
            ))
          }
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <RBtn small disabled={page <= 1} onClick={() => fetchUsers(q, page - 1)}>← Prev</RBtn>
          <span>Page {page} of {totalPages}</span>
          <RBtn small disabled={page >= totalPages} onClick={() => fetchUsers(q, page + 1)}>Next →</RBtn>
        </div>
      )}

      {banTarget && <BanModal user={banTarget} onClose={() => setBanTarget(null)} onConfirm={handleBan} />}
      {detailId  && <UserDetailModal token={token} userId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

// ─── Section: Organizations ───────────────────────────────────────────────────

function SectionOrgs({ token, onError }) {
  const [orgs, setOrgs]         = useState([]);
  const [total, setTotal]       = useState(0);
  const [page, setPage]         = useState(1);
  const [q, setQ]               = useState('');
  const [loading, setLoading]   = useState(true);
  const [msg, setMsg]           = useState(null);
  const [nodes, setNodes]       = useState([]);
  const searchTimer             = React.useRef(null);

  const fetchOrgs = useCallback((query, pg) => {
    setLoading(true);
    api.adminGetOrgs(token, query, pg).then(({ data, error }) => {
      setLoading(false);
      if (error) { onError(error); return; }
      setOrgs(data.orgs || []);
      setTotal(data.total || 0);
      setPage(data.page || 1);
    });
  }, [token]);

  useEffect(() => { fetchOrgs('', 1); }, [fetchOrgs]);
  // One-time node list for the assignment dropdown below — shared endpoint with
  // the Servers tab, kept separate from that tab's own polling/refresh state.
  useEffect(() => {
    api.adminGetNodes(token).then(({ data }) => { if (data) setNodes(data.nodes || []); });
  }, [token]);

  const handleSearch = (val) => {
    setQ(val);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => fetchOrgs(val, 1), 400);
  };

  const handleDissolve = async (orgId, callsign) => {
    if (!window.confirm(`Permanently dissolve "${callsign}"? This cannot be undone.`)) return;
    const { error } = await api.adminDissolveOrg(token, orgId);
    if (error) { onError(error); return; }
    setMsg(`"${callsign}" dissolved.`);
    fetchOrgs(q, page);
  };

  const handleAssign = async (orgId, nodeId) => {
    const { error } = nodeId
      ? await api.adminAssignOrgNode(token, orgId, nodeId)
      : await api.adminUnassignOrgNode(token, orgId);
    if (error) { onError(error); return; }
    fetchOrgs(q, page);
  };

  const joinLabel = { 0: 'Open', 1: 'Application', 2: 'Invite Only' };
  const totalPages = Math.ceil(total / 50);

  return (
    <div className="space-y-4">
      {msg && <Alert type="success" onDismiss={() => setMsg(null)}>{msg}</Alert>}
      <div className="flex items-center justify-between">
        <SearchBar value={q} onChange={handleSearch} placeholder="Search org callsign..." />
        <span className="text-sm text-gray-500">{total} organizations</span>
      </div>
      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <Table cols={['Callsign', 'Owner', 'Members', 'Channels', 'Visibility', 'Join Method', 'Server', 'Created', 'Actions']}>
          {loading
            ? <tr><td colSpan={9} className="px-4 py-6 text-center text-gray-400 text-sm">Loading organizations...</td></tr>
            : orgs.map(o => (
              <tr key={o.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3 font-semibold text-gray-800">{o.callsign}</td>
                <td className="px-4 py-3 text-gray-500 text-sm">{o.owner_callsign}</td>
                <td className="px-4 py-3 text-gray-500 text-sm text-center">{o.member_count}</td>
                <td className="px-4 py-3 text-gray-500 text-sm text-center">{o.channel_count}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${o.is_public ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                    {o.is_public ? 'Public' : 'Private'}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-400 text-sm">{joinLabel[o.join_method] ?? '—'}</td>
                <td className="px-4 py-3">
                  <select
                    className="bg-white border border-gray-300 rounded text-xs px-2 py-1"
                    value={o.assigned_node_id || ''}
                    onChange={e => handleAssign(o.id, e.target.value)}
                  >
                    <option value="">Default (shared)</option>
                    {nodes.map(n => <option key={n.node_id} value={n.node_id}>{n.node_id} ({n.region})</option>)}
                  </select>
                </td>
                <td className="px-4 py-3 text-gray-400 text-sm">{new Date(o.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-right">
                  <RBtn small variant="danger" onClick={() => handleDissolve(o.id, o.callsign)}>Dissolve</RBtn>
                </td>
              </tr>
            ))
          }
        </Table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <RBtn small disabled={page <= 1} onClick={() => fetchOrgs(q, page - 1)}>← Prev</RBtn>
          <span>Page {page} of {totalPages}</span>
          <RBtn small disabled={page >= totalPages} onClick={() => fetchOrgs(q, page + 1)}>Next →</RBtn>
        </div>
      )}
    </div>
  );
}

// ─── Section: Servers (Phase A of multi-tenant infra) ─────────────────────────

// Must match REGION_ALLOWLIST in services/identity-node/src/utils/doProvisioning.ts.
const PROVISION_REGIONS = ['nyc3', 'sfo3', 'ams3', 'fra1', 'sgp1'];
const PROVISION_TIMEOUT_MS = 10 * 60_000; // client-side backstop, matches the server-side timed_out window

function SectionServers({ token, onError }) {
  const [nodes, setNodes]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [region, setRegion]   = useState(PROVISION_REGIONS[0]);
  const [provisioning, setProvisioning] = useState(false);
  // { node_id, region, requested_at, status: 'provisioning'|'failed'|'timed_out' }
  const [pendingProvisions, setPendingProvisions] = useState([]);

  const loadNodes = () => {
    setLoading(true);
    api.adminGetNodes(token).then(({ data, error }) => {
      setLoading(false);
      if (error) { onError(error); return; }
      setNodes(data.nodes || []);
    });
  };

  useEffect(() => { loadNodes(); }, [token]);

  // Only polls while something is actually pending — avoids needless requests
  // in the steady state once all provisions have resolved one way or another.
  useEffect(() => {
    if (pendingProvisions.length === 0) return;
    const poll = () => {
      loadNodes();
      api.adminGetProvisioning(token).then(({ data, error }) => {
        if (error || !data) return;
        const byNodeId = new Map((data.requests || []).map(r => [r.node_id, r]));
        setPendingProvisions(prev => prev
          .map(p => {
            const req = byNodeId.get(p.node_id);
            if (req && (req.status === 'failed' || req.status === 'timed_out')) return { ...p, status: req.status };
            return p;
          })
          // Drop entries once the node has actually registered (shows up in
          // the real node list) or the client-side timeout backstop fires.
          .filter(p => !nodes.some(n => n.node_id === p.node_id))
          .filter(p => p.status !== 'ready')
          .filter(p => Date.now() - p.requested_at < PROVISION_TIMEOUT_MS)
        );
      });
    };
    const interval = setInterval(poll, 10_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingProvisions.length, token]);

  // Reconcile immediately whenever a fresh node list arrives (don't wait for
  // the next 10s poll tick) — the node the admin just requested may already
  // have heartbeated in by the time this fires.
  useEffect(() => {
    if (pendingProvisions.length === 0) return;
    setPendingProvisions(prev => prev.filter(p => !nodes.some(n => n.node_id === p.node_id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes]);

  const handleProvision = async () => {
    if (!window.confirm(`This will create a new billable DigitalOcean droplet in ${region}. Continue?`)) return;
    setProvisioning(true);
    const { data, error } = await api.adminProvisionNode(token, region);
    setProvisioning(false);
    if (error) { onError(error); return; }
    setPendingProvisions(prev => [...prev, {
      node_id: data.node_id, region: data.region, requested_at: Date.now(), status: 'provisioning',
    }]);
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <span className="text-sm text-gray-600 font-medium">Media Node Capacity</span>
        <div className="flex items-center gap-2">
          <select
            className="bg-white border border-gray-300 rounded text-xs px-2 py-1.5"
            value={region}
            onChange={e => setRegion(e.target.value)}
          >
            {PROVISION_REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <RBtn small variant="success" disabled={provisioning} onClick={handleProvision}>
            {provisioning ? 'Provisioning…' : '+ Provision New Node'}
          </RBtn>
          <RBtn small onClick={loadNodes}>Refresh</RBtn>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Nodes" value={nodes.length} />
        <StatCard label="Online" value={nodes.filter(n => n.online).length} />
        <StatCard label="Voice Sessions" value={nodes.reduce((s, n) => s + (n.voice_sessions || 0), 0)} />
        <StatCard label="Video Viewers" value={nodes.reduce((s, n) => s + (n.video_viewers || 0), 0)} />
      </div>
      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <Table cols={['Node', 'Region', 'Status', 'Tenancy', 'Voice', 'Viewers', 'Sharers', 'Orgs', 'Last Heartbeat']}
          empty="No media nodes registered yet.">
          {loading
            ? <tr><td colSpan={9} className="px-4 py-6 text-center text-gray-400 text-sm">Loading...</td></tr>
            // Flat array (not a fragment) so Table's React.Children.count-based
            // empty-state check still works correctly when both are empty.
            : [
              ...pendingProvisions.map(p => (
                <tr key={`pending-${p.node_id}`} className="border-b border-gray-100 bg-amber-50">
                  <td className="px-4 py-3 font-semibold text-gray-800">{p.node_id}</td>
                  <td className="px-4 py-3 text-gray-500 text-sm">{p.region}</td>
                  <td className="px-4 py-3" colSpan={7}>
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      p.status === 'failed' || p.status === 'timed_out' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                    }`}>
                      {p.status === 'failed' ? 'Failed' : p.status === 'timed_out' ? 'Timed out — check DO console' : 'Provisioning…'}
                    </span>
                  </td>
                </tr>
              )),
              ...nodes.map(n => (
                <tr key={n.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 font-semibold text-gray-800">{n.node_id}</td>
                  <td className="px-4 py-3 text-gray-500 text-sm">{n.region}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${n.online ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                      {n.online ? 'Online' : 'Offline'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-sm capitalize">{n.tenancy_mode}</td>
                  <td className="px-4 py-3 text-gray-500 text-sm text-center">{n.voice_sessions}</td>
                  <td className="px-4 py-3 text-gray-500 text-sm text-center">{n.video_viewers}</td>
                  <td className="px-4 py-3 text-gray-500 text-sm text-center">{n.video_sharers}</td>
                  <td className="px-4 py-3 text-gray-500 text-sm text-center">{n.assigned_org_count}</td>
                  <td className="px-4 py-3 text-gray-400 text-sm">{n.last_heartbeat_at ? new Date(n.last_heartbeat_at).toLocaleTimeString() : '—'}</td>
                </tr>
              )),
            ]
          }
        </Table>
      </div>
    </div>
  );
}

// ─── Section: HWID Bans ───────────────────────────────────────────────────────

function SectionHwidBans({ token, onError }) {
  const [bans, setBans]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [msg, setMsg]           = useState(null);

  const loadBans = () => {
    setLoading(true);
    api.adminGetHwidBans(token).then(({ data, error }) => {
      setLoading(false);
      if (error) onError(error);
      else setBans(data.bans || []);
    });
  };

  useEffect(() => { loadBans(); }, [token]);

  const handleRevoke = async (hwid) => {
    const { error } = await api.adminRemoveHwidBan(token, hwid);
    if (error) { onError(error); return; }
    setMsg('HWID ban revoked.');
    loadBans();
  };

  return (
    <div className="space-y-4">
      {msg && <Alert type="success" onDismiss={() => setMsg(null)}>{msg}</Alert>}
      <div className="flex justify-between items-center">
        <span className="text-sm text-gray-600 font-medium">Hardware Identifier Blacklist</span>
        <RBtn small onClick={loadBans}>Refresh</RBtn>
      </div>
      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <Table cols={['HWID', 'Linked Account', 'Reason', 'Banned At', 'Actions']} empty="No HWID bans on record.">
          {loading
            ? <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400 text-sm">Loading...</td></tr>
            : bans.map((b, i) => (
              <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-gray-600 text-xs">{b.hwid.substring(0, 24)}…</td>
                <td className="px-4 py-3 text-gray-700 text-sm">{b.callsign || '—'}</td>
                <td className="px-4 py-3 text-gray-400 text-sm">{b.reason || '—'}</td>
                <td className="px-4 py-3 text-gray-400 text-sm">{new Date(b.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-right">
                  <RBtn small variant="success" onClick={() => handleRevoke(b.hwid)}>Revoke</RBtn>
                </td>
              </tr>
            ))
          }
        </Table>
      </div>
    </div>
  );
}

// ─── Section: Voice Reports ───────────────────────────────────────────────────

// Decodes a report clip — see the matching encoder, frameReportClip in
// web-portal's CommLink.jsx. Both sides are this app's own code, so this
// framing has no external spec to match.
//
// Two formats exist:
//   - New (4B magic "SEV2" prefix): repeated [8B ts u64 LE][4B ssrc u32 LE]
//     [4B opus_len u32 LE][opus bytes] — ssrc lets a segment be attributed to
//     a real speaker (via the report's speaker_map) once the source channel
//     ran the E2E voice relay instead of server-side mixing.
//   - Legacy (no magic prefix — every report submitted before this existed):
//     repeated [8B ts u64 LE][4B opus_len u32 LE][opus bytes], one blended
//     stream, ssrc implicitly 0 throughout.
// The magic tag is checked first so old, already-stored reports stay
// decodable without a data migration.
const REPORT_CLIP_MAGIC = 0x53455632; // "SEV2" as a big-endian u32

async function decodeReportClip(arrayBuffer) {
  const { OpusDecoder } = await import('opus-decoder');
  const dec = new OpusDecoder();
  await dec.ready;

  const buf = new Uint8Array(arrayBuffer);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 0;
  const chunks = [];
  let sampleRate = 48000;

  const hasSsrc = buf.length >= 4 && view.getUint32(0, false) === REPORT_CLIP_MAGIC;
  if (hasSsrc) offset = 4;
  const headerLen = hasSsrc ? 16 : 12;

  while (offset + headerLen <= buf.length) {
    const tsLow = view.getUint32(offset, true);
    const tsHigh = view.getUint32(offset + 4, true);
    const ts = tsHigh * 4294967296 + tsLow;
    let ssrc = 0;
    let lenOffset = offset + 8;
    if (hasSsrc) {
      ssrc = view.getUint32(offset + 8, true);
      lenOffset = offset + 12;
    }
    const len = view.getUint32(lenOffset, true);
    offset = lenOffset + 4;
    if (len < 0 || offset + len > buf.length) break;
    const opusBytes = buf.subarray(offset, offset + len);
    offset += len;
    try {
      const { channelData, samplesDecoded, sampleRate: sr } = dec.decodeFrame(opusBytes);
      if (samplesDecoded) {
        chunks.push({ ts, ssrc, samples: channelData[0].slice(0, samplesDecoded) });
        if (sr) sampleRate = sr;
      }
    } catch {
      // One malformed frame shouldn't sink the whole clip — skip and keep going.
    }
  }
  if (dec.free) dec.free();

  const totalSamples = chunks.reduce((sum, c) => sum + c.samples.length, 0);
  const samples = new Float32Array(totalSamples);
  let o = 0;
  for (const c of chunks) { samples.set(c.samples, o); o += c.samples.length; }
  const speakerSsrcs = [...new Set(chunks.map(c => c.ssrc))];
  return { samples, sampleRate, firstTs: chunks[0]?.ts ?? null, speakerSsrcs };
}

const STATUS_STYLES = {
  pending:   'bg-yellow-50 border-yellow-300 text-yellow-700',
  reviewed:  'bg-blue-50 border-blue-300 text-blue-700',
  dismissed: 'bg-gray-100 border-gray-300 text-gray-500',
  actioned:  'bg-red-50 border-red-300 text-red-700',
};

const StatusPill = ({ status }) => (
  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_STYLES[status] || STATUS_STYLES.pending}`}>
    {status}
  </span>
);

function SectionVoiceReports({ token, onError }) {
  const [reports, setReports]         = useState([]);
  const [loading, setLoading]         = useState(true);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [msg, setMsg]                 = useState(null);
  const [expandedId, setExpandedId]   = useState(null);
  const [notesDraft, setNotesDraft]   = useState({});
  const [audioBusyId, setAudioBusyId] = useState(null);
  // report id -> array of user_ids attributed to segments of the clip last
  // played for that report (via speaker_map + the clip's own ssrcs). Only
  // populated on play, not on list-load, since it requires decoding the clip.
  const [clipSpeakers, setClipSpeakers] = useState({});
  const audioCtxRef = React.useRef(null);

  const loadReports = () => {
    setLoading(true);
    api.adminGetVoiceReports(token, statusFilter === 'all' ? null : statusFilter).then(({ data, error }) => {
      setLoading(false);
      if (error) onError(error);
      else setReports(data.reports || []);
    });
  };

  useEffect(() => { loadReports(); }, [token, statusFilter]);

  const handleToggleExpand = (id, currentNotes) => {
    setExpandedId(expandedId === id ? null : id);
    setNotesDraft(prev => (prev[id] !== undefined ? prev : { ...prev, [id]: currentNotes || '' }));
  };

  const handleUpdateStatus = async (id, status) => {
    const { error } = await api.adminUpdateVoiceReport(token, id, status, notesDraft[id] ?? null);
    if (error) { onError(error); return; }
    setMsg(`Report marked ${status}.`);
    loadReports();
  };

  const handlePlayAudio = async (id) => {
    setAudioBusyId(id);
    try {
      const res = await fetch(api.adminGetVoiceReportAudioUrl(id), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Audio fetch failed (${res.status})`);
      const raw = await res.arrayBuffer();
      const { samples, sampleRate, speakerSsrcs } = await decodeReportClip(raw);
      if (samples.length === 0) throw new Error('Clip decoded to zero samples');

      // Resolve this clip's ssrcs to user_ids via the report's own speaker_map
      // (sent by the reporter's client — see submitVoiceReport in CommLink.jsx).
      // Empty for a clip from a still mixed-mode channel, where every frame is
      // ssrc=0 and there's nothing per-speaker to attribute.
      const report = reports.find(r => r.id === id);
      const speakerMap = report?.speaker_map || {};
      const speakerIds = [...new Set(
        (speakerSsrcs || [])
          .map(ssrc => speakerMap[String(ssrc)])
          .filter(Boolean)
      )];
      setClipSpeakers(prev => ({ ...prev, [id]: speakerIds }));

      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      const buffer = ctx.createBuffer(1, samples.length, sampleRate);
      buffer.getChannelData(0).set(samples);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
    } catch (err) {
      onError(err?.message || String(err));
    } finally {
      setAudioBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      {msg && <Alert type="success" onDismiss={() => setMsg(null)}>{msg}</Alert>}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600 font-medium">Voice Misconduct Reports</span>
          <select
            className="bg-white border border-gray-300 rounded text-sm px-2 py-1 text-gray-700"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
          >
            <option value="pending">Pending</option>
            <option value="reviewed">Reviewed</option>
            <option value="dismissed">Dismissed</option>
            <option value="actioned">Actioned</option>
            <option value="all">All</option>
          </select>
        </div>
        <RBtn small onClick={loadReports}>Refresh</RBtn>
      </div>
      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <Table cols={['Reporter', 'Accused', 'Reported', 'Status', 'Actions']} empty="No voice reports on record.">
          {loading
            ? <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400 text-sm">Loading...</td></tr>
            : reports.map((r) => (
              <React.Fragment key={r.id}>
                <tr className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-700 text-sm">{r.reporter_callsign || '—'}</td>
                  <td className="px-4 py-3 text-gray-700 text-sm">{r.accused_callsign || '—'}</td>
                  <td className="px-4 py-3 text-gray-400 text-sm">{new Date(r.reported_at).toLocaleString()}</td>
                  <td className="px-4 py-3"><StatusPill status={r.status} /></td>
                  <td className="px-4 py-3 text-right">
                    <RBtn small onClick={() => handleToggleExpand(r.id, r.admin_notes)}>
                      {expandedId === r.id ? 'Hide' : 'Review'}
                    </RBtn>
                  </td>
                </tr>
                {expandedId === r.id && (
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <td colSpan={5} className="px-4 py-4">
                      <div className="space-y-3">
                        {r.reporter_note && (
                          <div>
                            <div className="text-xs uppercase tracking-wider text-gray-400 mb-1">Reporter Note</div>
                            <div className="text-sm text-gray-700">{r.reporter_note}</div>
                          </div>
                        )}
                        <div>
                          <div className="text-xs uppercase tracking-wider text-gray-400 mb-1">Speaking Activity (window)</div>
                          {(r.speaking_history || []).length === 0
                            ? <div className="text-sm text-gray-400">No speaking-activity data attached.</div>
                            : (
                              <div className="flex flex-wrap gap-1">
                                {[...new Set((r.speaking_history || []).map(e => e.callsign))].map(cs => (
                                  <span key={cs} className="px-2 py-0.5 rounded bg-gray-200 text-gray-600 text-xs">{cs}</span>
                                ))}
                              </div>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                          <RBtn small onClick={() => handlePlayAudio(r.id)} disabled={audioBusyId === r.id}>
                            {audioBusyId === r.id ? 'Loading…' : '▶ Play Clip'}
                          </RBtn>
                          <span className="text-xs text-gray-400">Decrypted server-side on request; never stored in the browser.</span>
                        </div>
                        {clipSpeakers[r.id] !== undefined && (
                          <div>
                            <div className="text-xs uppercase tracking-wider text-gray-400 mb-1">Clip Attribution</div>
                            {clipSpeakers[r.id].length === 0
                              ? <div className="text-sm text-gray-400">No per-speaker attribution available for this clip (blended/mixed-mode audio, or no relay-mode speakers recognized).</div>
                              : (
                                <div className="flex flex-wrap gap-1">
                                  {clipSpeakers[r.id].map(uid => {
                                    // Best-effort label: the only two callsigns this list
                                    // response carries are the reporter's and accused's —
                                    // any other attributed speaker shows as a raw user_id
                                    // (cross-reference via the Users section if needed).
                                    const label =
                                      uid === r.reporter_id ? `${r.reporter_callsign || uid} (reporter)`
                                      : uid === r.accused_id ? `${r.accused_callsign || uid} (accused)`
                                      : uid;
                                    return (
                                      <span key={uid} className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-xs">{label}</span>
                                    );
                                  })}
                                </div>
                              )}
                          </div>
                        )}
                        <div>
                          <div className="text-xs uppercase tracking-wider text-gray-400 mb-1">Admin Notes</div>
                          <textarea
                            className="w-full border border-gray-300 rounded text-sm px-2 py-1 text-gray-700"
                            rows={2}
                            value={notesDraft[r.id] ?? ''}
                            onChange={e => setNotesDraft(prev => ({ ...prev, [r.id]: e.target.value }))}
                          />
                        </div>
                        <div className="flex gap-2">
                          <RBtn small variant="default" onClick={() => handleUpdateStatus(r.id, 'reviewed')}>Mark Reviewed</RBtn>
                          <RBtn small variant="default" onClick={() => handleUpdateStatus(r.id, 'dismissed')}>Dismiss</RBtn>
                          <RBtn small variant="danger" onClick={() => handleUpdateStatus(r.id, 'actioned')}>Mark Actioned</RBtn>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))
          }
        </Table>
      </div>
    </div>
  );
}

// ─── Section: System ──────────────────────────────────────────────────────────

function SectionSystem({ token, onError, onLogout }) {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    window.fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:8082'}/health`)
      .then(r => r.json())
      .then(d => setHealth(d))
      .catch(() => setHealth({ status: 'unreachable' }));
  }, []);

  const isOk = health?.status === 'ok';

  return (
    <div className="space-y-6">
      <div className="border border-gray-200 bg-white rounded-lg shadow-sm p-6 space-y-4">
        <div className="text-sm font-semibold text-gray-700 border-b border-gray-200 pb-3">Node Health</div>
        <div className="flex items-center gap-3">
          <span className={`w-3 h-3 rounded-full flex-shrink-0 ${isOk ? 'bg-green-500' : 'bg-red-400'}`} />
          <span className="text-sm text-gray-700">
            Identity Service: <span className={`font-semibold ${isOk ? 'text-green-600' : 'text-red-600'}`}>{health?.status?.toUpperCase() ?? 'Checking...'}</span>
          </span>
          {health?.timestamp && (
            <span className="text-gray-400 text-xs ml-auto">{new Date(health.timestamp).toLocaleString()}</span>
          )}
        </div>
      </div>

      <div className="border border-red-200 bg-red-50 rounded-lg p-6 space-y-4">
        <div className="text-sm font-semibold text-red-700 border-b border-red-200 pb-3">Danger Zone</div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-gray-800">End Admin Session</div>
            <div className="text-xs text-gray-500 mt-0.5">Clears local admin token and returns to login screen.</div>
          </div>
          <RBtn variant="danger" onClick={onLogout}>Logout</RBtn>
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar Nav ──────────────────────────────────────────────────────────────

const NAV = [
  { id: 'dashboard',  label: 'Dashboard'     },
  { id: 'users',      label: 'Users'         },
  { id: 'orgs',       label: 'Organizations' },
  { id: 'hwid',       label: 'HWID Bans'     },
  { id: 'voiceReports', label: 'Voice Reports' },
  { id: 'servers',    label: 'Servers'       },
  { id: 'system',     label: 'System'        },
];

// ─── Admin Portal Root ────────────────────────────────────────────────────────

const AdminPortal = ({ onExit }) => {
  const [adminToken, setAdminToken]       = useState(localStorage.getItem('specter_admin_token'));
  const [adminUser, setAdminUser]         = useState(null);
  const [loginForm, setLoginForm]         = useState({ username: '', password: '' });
  const [loginErr, setLoginErr]           = useState(null);
  const [activeSection, setActiveSection] = useState('dashboard');
  const [error, setError]                 = useState(null);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginErr(null);
    const { data, error } = await api.adminLogin(loginForm);
    if (error) return setLoginErr(error);
    localStorage.setItem('specter_admin_token', data.token);
    setAdminToken(data.token);
    setAdminUser(data.admin);
  };

  const handleLogout = () => {
    localStorage.removeItem('specter_admin_token');
    setAdminToken(null);
    setAdminUser(null);
  };

  if (!adminToken) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="bg-white border border-gray-200 rounded-xl shadow-lg p-8 w-full max-w-sm space-y-6">
          <div className="text-center border-b border-gray-200 pb-5">
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Specter Admin</h1>
            <p className="text-sm text-gray-400 mt-1">Restricted access — authorized personnel only</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="text-xs text-gray-500 font-medium uppercase tracking-wider block mb-1">Username or Email</label>
              <input
                className="w-full bg-white border border-gray-300 rounded focus:border-gray-500 focus:outline-none p-2.5 text-gray-800 text-sm"
                value={loginForm.username}
                onChange={e => setLoginForm(f => ({ ...f, username: e.target.value }))}
                autoComplete="username"
                required
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 font-medium uppercase tracking-wider block mb-1">Password</label>
              <input
                type="password"
                className="w-full bg-white border border-gray-300 rounded focus:border-gray-500 focus:outline-none p-2.5 text-gray-800 text-sm"
                value={loginForm.password}
                onChange={e => setLoginForm(f => ({ ...f, password: e.target.value }))}
                autoComplete="current-password"
                required
              />
            </div>
            {loginErr && <Alert>{loginErr}</Alert>}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onExit}
                className="flex-1 py-2 border border-gray-300 rounded text-gray-600 hover:bg-gray-50 text-sm font-medium transition-colors">
                Cancel
              </button>
              <button type="submit"
                className="flex-1 bg-gray-900 text-white rounded py-2 hover:bg-gray-700 text-sm font-medium transition-colors">
                Sign In
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col font-sans">
      <header className="bg-white border-b border-gray-200 px-4 sm:px-6 py-3 flex items-center justify-between shadow-sm flex-shrink-0 gap-2">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <span className="font-bold text-gray-900 tracking-tight truncate">Specter Admin</span>
          <span className="hidden sm:inline text-xs bg-gray-100 text-gray-500 border border-gray-200 px-2 py-0.5 rounded font-mono">OMNI-PANEL</span>
        </div>
        <div className="flex gap-3 sm:gap-4 items-center flex-shrink-0">
          {adminUser && <span className="hidden sm:inline text-sm text-gray-500">{adminUser.username}</span>}
          <button onClick={onExit}       className="text-sm text-gray-500 hover:text-gray-800 transition-colors">Exit</button>
          <button onClick={handleLogout} className="text-sm text-red-600 hover:text-red-800 font-medium transition-colors">Logout</button>
        </div>
      </header>

      {/* Below md: nav becomes a horizontally-scrollable tab bar on top instead of
          a fixed-width side rail, since a 208px sidebar eats most of a phone's width. */}
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden md:h-[calc(100vh-53px)]">
        <nav className="w-full md:w-52 bg-white border-b md:border-b-0 md:border-r border-gray-200 flex-shrink-0 flex flex-row md:flex-col gap-0.5 overflow-x-auto md:overflow-y-auto shadow-sm py-1 md:py-4">
          {NAV.map(n => (
            <button
              key={n.id}
              onClick={() => { setActiveSection(n.id); setError(null); }}
              className={`flex-shrink-0 md:w-full text-left px-4 md:px-5 py-2.5 text-sm font-medium whitespace-nowrap transition-colors rounded-none border-l-2 md:border-l-2 border-b-2 md:border-b-0 ${
                activeSection === n.id
                  ? 'bg-gray-100 text-gray-900 border-gray-900'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800 border-transparent'
              }`}
            >
              {n.label}
            </button>
          ))}
        </nav>

        <main className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">
          {error && (
            <div className="mb-6">
              <Alert onDismiss={() => setError(null)}>{error}</Alert>
            </div>
          )}

          {activeSection === 'dashboard' && <SectionDashboard token={adminToken} onError={setError} />}
          {activeSection === 'users'     && <SectionUsers     token={adminToken} onError={setError} />}
          {activeSection === 'orgs'      && <SectionOrgs      token={adminToken} onError={setError} />}
          {activeSection === 'hwid'      && <SectionHwidBans  token={adminToken} onError={setError} />}
          {activeSection === 'voiceReports' && <SectionVoiceReports token={adminToken} onError={setError} />}
          {activeSection === 'servers'   && <SectionServers   token={adminToken} onError={setError} />}
          {activeSection === 'system'    && <SectionSystem    token={adminToken} onError={setError} onLogout={handleLogout} />}
        </main>
      </div>
    </div>
  );
};

export default AdminPortal;
