// FriendsPanel.jsx â€” Cabinet view friends roster with add/search and notification tray
import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api';

// â”€â”€ Notification tray â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Accepts an array of notice objects:
//   { id, kind: 'friend_request' | 'org_invite', label, sublabel, onAccept, onDismiss }
// New kinds can be appended without changing the tray component itself.
function NoticeTray({ notices, onAccept, onDismiss }) {
  if (!notices.length) return null;

  const kindMeta = {
    friend_request: { icon: 'âŠ•', accent: 'border-yellow-500/70 bg-yellow-900/20', badge: 'bg-yellow-500/20 text-yellow-300 border-yellow-600/50', label: 'Friend Request' },
    org_invite:     { icon: 'âŠž', accent: 'border-cyan-500/70  bg-cyan-900/20',    badge: 'bg-cyan-500/20  text-cyan-300  border-cyan-600/50',   label: 'Org Invite'     },
  };

  return (
    <div className="border-b border-specter-primary-dim bg-specter-bg-panel/60">
      {/* Tray header */}
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-xs font-mono font-bold text-specter-state-warning uppercase tracking-widest">
          â–² {notices.length} Action{notices.length !== 1 ? 's' : ''} Required
        </span>
      </div>

      {/* Notice cards */}
      <div className="max-h-52 overflow-y-auto px-3 pb-3 space-y-2">
        {notices.map(n => {
          const meta = kindMeta[n.kind] ?? kindMeta.friend_request;
          return (
            <div key={n.id} className={`flex items-center gap-3 rounded border px-3 py-2 ${meta.accent}`}>
              {/* Avatar / icon */}
              <div className="w-8 h-8 rounded bg-specter-bg-surface border border-specter-primary-dim flex items-center justify-center text-specter-primary-cyan font-bold font-mono text-sm flex-shrink-0 select-none">
                {n.initial ?? meta.icon}
              </div>

              {/* Text */}
              <div className="flex-1 min-w-0">
                <div className="text-xs font-mono text-white truncate">{n.label}</div>
                <span className={`inline-block mt-0.5 text-xs font-mono border rounded px-1.5 py-px ${meta.badge}`}>
                  {meta.label}
                </span>
              </div>

              {/* Actions */}
              <div className="flex flex-col gap-1 flex-shrink-0">
                <button
                  onClick={() => onAccept(n)}
                  className="px-2.5 py-1 text-xs font-mono font-bold text-green-300 border border-green-700/60 rounded hover:bg-green-700/30 hover:border-green-500 transition-colors">
                  Accept
                </button>
                {n.onDismiss !== false && (
                  <button
                    onClick={() => onDismiss(n)}
                    className="px-2.5 py-1 text-xs font-mono text-specter-text-muted border border-specter-primary-dim rounded hover:text-red-400 hover:border-red-700/50 transition-colors">
                    Ignore
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const statusLabel = (s) => {
  if (s === 1) return { text: 'Away',   color: 'text-yellow-400', dot: 'bg-yellow-400', ring: 'border-yellow-500/40'  };
  if (s === 2) return { text: 'Busy',   color: 'text-red-400',    dot: 'bg-red-400',    ring: 'border-red-500/40'     };
  if (s === 3) return { text: 'Invis',  color: 'text-gray-500',   dot: 'bg-gray-600',   ring: 'border-gray-600/40'    };
               return { text: 'Online', color: 'text-green-400',  dot: 'bg-green-400',  ring: 'border-green-500/40'   };
};

export default function FriendsPanel({ user, onClose, onCallFriend, extraNotices = [] }) {
  const [friends, setFriends]             = useState([]);
  const [loading, setLoading]             = useState(true);
  const [friendFilter, setFriendFilter]   = useState('');
  const [tab, setTab]                     = useState('roster'); // 'roster' | 'add'
  const [addSearchQ, setAddSearchQ]       = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching]         = useState(false);
  const [msg, setMsg]                     = useState(null);
  // Notices dismissed client-side for this session (no backend decline endpoint yet)
  const [dismissed, setDismissed]         = useState(new Set());
  const searchTimer                       = useRef(null);

  useEffect(() => { fetchFriends(); }, []);

  const fetchFriends = () => {
    setLoading(true);
    api.getFriends().then(({ data, error }) => {
      setLoading(false);
      if (!error && data?.friends) setFriends(data.friends);
    });
  };

  const handleAddSearchInput = (val) => {
    setAddSearchQ(val);
    clearTimeout(searchTimer.current);
    if (val.length < 2) { setSearchResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      const { data } = await api.searchUsers(val);
      setSearching(false);
      if (data?.users) setSearchResults(data.users.filter(u => u.id !== user.id));
    }, 350);
  };

  const handleSendRequest = async (targetId) => {
    setMsg(null);
    const { error } = await api.sendFriendRequest(targetId);
    if (error) return setMsg({ type: 'error', text: error });
    setMsg({ type: 'success', text: 'Friend request sent.' });
    setAddSearchQ('');
    setSearchResults([]);
  };

  const handleAccept = async (targetId) => {
    setMsg(null);
    const { error } = await api.acceptFriendRequest(targetId);
    if (error) return setMsg({ type: 'error', text: error });
    setDismissed(prev => { const s = new Set(prev); s.delete(`friend_${targetId}`); return s; });
    fetchFriends();
  };

  const handleDecline = async (targetId) => {
    setMsg(null);
    const { error } = await api.declineFriendRequest(targetId);
    if (error) return setMsg({ type: 'error', text: error });
    setDismissed(prev => new Set(prev).add(`friend_${targetId}`));
    fetchFriends();
  };

  const handleRemove = async (targetId) => {
    setMsg(null);
    const { error } = await api.removeFriend(targetId);
    if (error) return setMsg({ type: 'error', text: error });
    fetchFriends();
  };

  const accepted = friends.filter(f => f.status === 1);
  const pending  = friends.filter(f => f.status === 0);
  // A pending row where we are the initiator is outgoing; all others are incoming to us.
  // initiated_by === null covers legacy rows written before the column existed (treat as incoming).
  const incoming = pending.filter(f => f.initiated_by !== user?.id);
  const outgoing = pending.filter(f => f.initiated_by === user?.id);

  // Build the notices array: only INCOMING friend requests + any extra notices from parent
  const friendNotices = incoming
    .filter(f => !dismissed.has(`friend_${f.id}`))
    .map(f => ({
      id:       `friend_${f.id}`,
      kind:     'friend_request',
      label:    f.callsign,
      initial:  f.callsign?.[0]?.toUpperCase() ?? '?',
      targetId: f.id,
      onDismiss: true,
    }));

  const notices = [
    ...friendNotices,
    ...extraNotices.filter(n => !dismissed.has(n.id)),
  ];

  const handleNoticeAccept = async (notice) => {
    if (notice.kind === 'friend_request') {
      await handleAccept(notice.targetId);
    } else if (notice.onAccept) {
      await notice.onAccept();
      setDismissed(prev => new Set(prev).add(notice.id));
    }
  };

  const handleNoticeDismiss = async (notice) => {
    setDismissed(prev => new Set(prev).add(notice.id));
    if (notice.kind === 'friend_request') {
      await api.declineFriendRequest(notice.targetId);
      fetchFriends();
    }
  };

  const filterMatch = (f) =>
    f.callsign?.toLowerCase().includes(friendFilter.toLowerCase()) ||
    f.global_tag?.toLowerCase().includes(friendFilter.toLowerCase());

  const filteredAccepted  = accepted.filter(filterMatch);
  const filteredOutgoing  = outgoing.filter(filterMatch);
  const rosterEmpty       = !loading && filteredAccepted.length === 0 && filteredOutgoing.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-96 bg-specter-bg-surface border-l border-specter-primary-dim flex flex-col h-full shadow-2xl">

        {/* Header */}
        <div className="px-4 py-3 border-b border-specter-primary-dim flex items-center justify-between">
          <span className="text-specter-primary-cyan font-bold font-mono text-sm tracking-widest uppercase">
            [ Friends ]
          </span>
          <button onClick={onClose} className="text-specter-text-muted hover:text-red-400 font-mono text-lg leading-none">&times;</button>
        </div>

        {/* Notice tray â€” rendered above tabs, pushes content down when present */}
        <NoticeTray
          notices={notices}
          onAccept={handleNoticeAccept}
          onDismiss={handleNoticeDismiss}
        />

        {/* Tabs */}
        <div className="flex border-b border-specter-primary-dim">
          <button
            onClick={() => setTab('roster')}
            className={`flex-1 py-2 text-xs font-mono uppercase tracking-wider transition-colors ${
              tab === 'roster'
                ? 'text-specter-primary-cyan border-b-2 border-specter-primary-cyan bg-specter-primary-dim/10'
                : 'text-specter-text-muted hover:text-white'
            }`}>
            Roster · {accepted.length}
          </button>
          <button
            onClick={() => { setTab('add'); setMsg(null); }}
            className={`flex-1 py-2 text-xs font-mono uppercase tracking-wider transition-colors ${
              tab === 'add'
                ? 'text-specter-primary-cyan border-b-2 border-specter-primary-cyan bg-specter-primary-dim/10'
                : 'text-specter-text-muted hover:text-white'
            }`}>
            + Add
          </button>
        </div>

        {tab === 'roster' ? (
          /* â”€â”€ Cabinet Roster View â”€â”€ */
          <div className="flex flex-col flex-1 overflow-hidden">
            {/* Filter */}
            <div className="px-4 py-3 border-b border-specter-primary-dim">
              <input
                className="w-full bg-black border border-specter-primary-dim rounded px-3 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-specter-primary-cyan placeholder-specter-text-muted"
                placeholder="Filter roster..."
                value={friendFilter}
                onChange={e => setFriendFilter(e.target.value)}
              />
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {loading && (
                <div className="text-xs text-specter-text-muted py-8 text-center">Loading roster...</div>
              )}
              {rosterEmpty && (
                <div className="text-xs text-specter-text-muted text-center py-8">
                  {friendFilter ? 'No matches.' : 'No friends yet â€” use the Add tab to find people.'}
                </div>
              )}

              {/* Cabinet grid â€” accepted friends + outgoing pending requests */}
              <div className="grid grid-cols-2 gap-3">
                {filteredAccepted.map(f => {
                  const pres = statusLabel(f.presence_status);
                  return (
                    <div
                      key={f.id}
                      className={`flex flex-col gap-2 p-3 rounded border bg-specter-bg-panel ${pres.ring} hover:border-specter-primary-cyan transition-colors`}
                    >
                      {/* Avatar row */}
                      <div className="flex items-center justify-between">
                        <div className="w-9 h-9 rounded bg-specter-primary-dim/30 border border-specter-primary-dim flex items-center justify-center text-specter-primary-cyan font-bold font-mono text-base select-none">
                          {f.callsign?.[0]?.toUpperCase() ?? '?'}
                        </div>
                        <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${pres.dot}`} title={pres.text} />
                      </div>

                      {/* Identity */}
                      <div className="min-w-0">
                        {f.global_tag && (
                          <div className="text-xs font-mono text-specter-text-muted truncate">[{f.global_tag}]</div>
                        )}
                        <div className="text-xs font-mono text-white leading-tight truncate">{f.callsign}</div>
                        <div className={`text-xs font-mono ${pres.color}`}>{pres.text}</div>
                      </div>

                      {/* Call / Remove actions */}
                      <div className="mt-auto flex flex-col gap-1">
                        {onCallFriend && (
                          <button
                            onClick={() => onCallFriend(f)}
                            className="w-full py-1 text-xs font-mono font-bold text-green-300 border border-green-700/60 rounded hover:bg-green-700/30 hover:border-green-500 transition-colors uppercase tracking-wider">
                            Call
                          </button>
                        )}
                        <button
                          onClick={() => handleRemove(f.id)}
                          className="w-full py-1 text-xs font-mono text-red-400/70 border border-red-700/30 rounded hover:text-red-400 hover:border-red-700/60 transition-colors uppercase tracking-wider">
                          Remove
                        </button>
                      </div>
                    </div>
                  );
                })}

                {/* Outgoing pending request cards */}
                {filteredOutgoing.map(f => (
                  <div
                    key={f.id}
                    className="flex flex-col gap-2 p-3 rounded border bg-specter-bg-panel border-specter-primary-dim/30 opacity-60"
                  >
                    {/* Avatar row */}
                    <div className="flex items-center justify-between">
                      <div className="w-9 h-9 rounded bg-specter-primary-dim/20 border border-dashed border-specter-primary-dim flex items-center justify-center text-specter-text-muted font-bold font-mono text-base select-none">
                        {f.callsign?.[0]?.toUpperCase() ?? '?'}
                      </div>
                      <span className="text-specter-text-muted text-xs font-mono">â³</span>
                    </div>

                    {/* Identity */}
                    <div className="min-w-0">
                      {f.global_tag && (
                        <div className="text-xs font-mono text-specter-text-muted truncate">[{f.global_tag}]</div>
                      )}
                      <div className="text-xs font-mono text-specter-text-muted leading-tight truncate">{f.callsign}</div>
                      <div className="text-xs font-mono text-specter-primary-dim">Req. Pending</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          /* â”€â”€ Add Friend / Pending â”€â”€ */
          <div className="flex-1 overflow-y-auto">
            {/* Incoming requests â€” full list (tray above handles quick-action) */}
            {incoming.length > 0 && (
              <div className="px-4 pt-4 pb-2">
                <div className="text-xs text-specter-state-warning uppercase tracking-wider mb-2">
                  Incoming Requests ({incoming.length})
                </div>
                <div className="space-y-2">
                  {incoming.map(f => (
                    <div key={f.id} className="flex items-center justify-between bg-specter-bg-panel border border-yellow-700/40 rounded px-3 py-2">
                      <div className="text-sm font-mono text-white">{f.callsign}</div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleAccept(f.id)}
                          className="text-xs text-green-400 hover:text-green-300 font-mono font-bold">
                          Accept
                        </button>
                        <button
                          onClick={() => handleDecline(f.id)}
                          className="text-xs text-red-400/70 hover:text-red-400 font-mono">
                          Ignore
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Search to add */}
            <div className="p-4 space-y-2">
              <div className="text-xs text-specter-text-muted uppercase tracking-wider mb-1">Search Users</div>
              <input
                className="w-full bg-black border border-specter-primary-dim rounded px-3 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-specter-primary-cyan placeholder-specter-text-muted"
                placeholder="Search by callsign..."
                value={addSearchQ}
                onChange={e => handleAddSearchInput(e.target.value)}
              />
              {searching && <div className="text-specter-text-muted text-xs">Searching...</div>}

              {msg && (
                <div className={`text-xs font-mono px-2 py-1 rounded border ${
                  msg.type === 'error' ? 'bg-red-950 border-red-700 text-red-300' : 'bg-green-950 border-green-700 text-green-300'
                }`}>{msg.text}</div>
              )}

              {searchResults.length > 0 && (
                <div className="border border-specter-primary-dim rounded bg-black divide-y divide-specter-primary-dim">
                  {searchResults.map(u => {
                    const isFriend = friends.some(f => f.id === u.id);
                    return (
                      <div key={u.id} className="flex items-center justify-between px-3 py-2">
                        <div className="text-sm font-mono text-white">
                          {u.global_tag && <span className="text-specter-text-muted text-xs">[{u.global_tag}] </span>}
                          {u.callsign}
                        </div>
                        {!isFriend ? (
                          <button
                            onClick={() => handleSendRequest(u.id)}
                            className="text-xs text-specter-primary-cyan hover:text-specter-primary-neon font-mono font-bold">
                            + Add
                          </button>
                        ) : (
                          <span className="text-xs text-specter-text-muted font-mono">Added</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
