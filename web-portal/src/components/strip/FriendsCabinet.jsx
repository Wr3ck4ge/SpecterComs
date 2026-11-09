// The tray strip's Friends cabinet: your friends, incoming/outgoing requests,
// and add-by-search. Talks to the API directly (like Games / Servers do); the
// engine only needs to know about a friend when a DM is opened, which the
// "Message" button does through onMessage (StripApp.openDm).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, MessageSquare, Search, UserMinus, UserPlus, X } from 'lucide-react';
import { Alert, Button, Input } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { api as realApi } from '../../api';
import { FRIEND, friendStatesById } from '../../engine/people';
import { PanelHeader, SectionLabel } from './stripOpsUi';

const errText = (error, fallback) => (typeof error === 'string' ? error : error?.message || fallback);

const rowBtn = cx(
  'inline-flex h-8 w-8 items-center justify-center rounded-ui-row text-specter-text-subtle',
  'hover:bg-white/5 hover:text-specter-text-main disabled:opacity-50', focusRing,
);

function Avatar({ callsign }) {
  return (
    <span aria-hidden="true" className="shrink-0 inline-flex h-[30px] w-[30px] items-center justify-center rounded-full bg-specter-primary-cyan/10 text-ui-sm font-semibold text-specter-primary-neon">
      {(callsign || '?')[0].toUpperCase()}
    </span>
  );
}

function Person({ callsign, tag, children }) {
  return (
    <li className="flex items-center gap-3 px-2 py-1.5 rounded-ui-row">
      <Avatar callsign={callsign} />
      <span className="flex-1 min-w-0">
        <span className="block truncate text-ui-base font-medium text-specter-text-main">{callsign}</span>
        {tag ? <span className="block truncate text-ui-xs text-specter-text-subtle">{tag}</span> : null}
      </span>
      {children}
    </li>
  );
}

/**
 * userId, onClose, maxHeight
 * onMessage({ userId, callsign })  opens the DM pane (null hides the button)
 * onRequestsChange(n)              incoming request count, for a bar badge
 * api                              defaults to the real client
 */
export default function FriendsCabinet({ userId, onClose, maxHeight = 560, onMessage = null, onRequestsChange = null, api = realApi }) {
  const [friends, setFriends] = useState(null); // rows from GET /friends, null = loading
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState({ loading: false, error: null, users: [] });
  const [busy, setBusy] = useState({}); // userId -> true while a call is in flight
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [notice, setNotice] = useState(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const { data, error: err } = await api.getFriends();
    if (err) { setError(errText(err, 'Could not load friends')); setFriends((f) => f ?? []); return; }
    setError(null);
    setFriends(data?.friends || []);
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const states = friendStatesById(friends || [], userId);
  const rows = friends || [];
  const idOf = (f) => f.id ?? f.user_id;
  const incoming = rows.filter((f) => states[idOf(f)] === FRIEND.INCOMING);
  const outgoing = rows.filter((f) => states[idOf(f)] === FRIEND.OUTGOING);
  const accepted = rows.filter((f) => states[idOf(f)] === FRIEND.FRIENDS)
    .sort((a, b) => String(a.callsign).localeCompare(String(b.callsign)));

  useEffect(() => { onRequestsChange?.(incoming.length); }, [incoming.length, onRequestsChange]);

  // Search (2+ characters, debounced; the newest request wins).
  useEffect(() => {
    const term = q.trim();
    const mine = ++seq.current;
    if (term.length < 2) { setResults({ loading: false, error: null, users: [] }); return undefined; }
    setResults((r) => ({ ...r, loading: true, error: null }));
    const t = setTimeout(async () => {
      const { data, error: err } = await api.searchUsers(term);
      if (mine !== seq.current) return;
      if (err) setResults({ loading: false, error: errText(err, 'Search failed'), users: [] });
      else setResults({ loading: false, error: null, users: (data?.users || []).filter((u) => u.id !== userId) });
    }, 300);
    return () => clearTimeout(t);
  }, [q, api, userId]);

  const act = async (id, call, okMsg) => {
    setBusy((b) => ({ ...b, [id]: true }));
    setNotice(null);
    const { error: err } = await call();
    setBusy((b) => ({ ...b, [id]: false }));
    if (err) { setNotice({ ok: false, text: errText(err, 'That did not work') }); return; }
    if (okMsg) setNotice({ ok: true, text: okMsg });
    setConfirmRemove(null);
    load();
  };

  const add = (u) => act(u.id, () => api.sendFriendRequest(u.id), `Request sent to ${u.callsign}`);
  const accept = (f) => act(idOf(f), () => api.acceptFriendRequest(idOf(f)), `You and ${f.callsign} are friends`);
  const decline = (f) => act(idOf(f), () => api.declineFriendRequest(idOf(f)));
  const remove = (f) => act(idOf(f), () => api.removeFriend(idOf(f)), `Removed ${f.callsign}`);

  const searching = q.trim().length >= 2;

  return (
    <div className="flex flex-col" style={{ maxHeight }}>
      <PanelHeader title="Friends" subtitle="Message people and keep in touch" onClose={onClose} />
      <div className="strip-scroll min-h-0 flex-1 px-2 pb-3">
        <div className="px-2 pb-2 relative">
          <Search size={14} aria-hidden="true" className="absolute left-5 top-1/2 -translate-y-1/2 text-specter-text-subtle" />
          <Input aria-label="Find people by callsign" placeholder="Find people by callsign" value={q}
            onChange={(e) => setQ(e.target.value)} inputClassName="pl-8" maxLength={32} autoComplete="off" />
        </div>
        {notice && (
          <p role="status" className={cx('px-2 pb-1 text-ui-xs', notice.ok ? 'text-specter-primary-neon' : 'text-red-300')}>{notice.text}</p>
        )}
        {error && <div className="px-2 pb-2"><Alert variant="error">{error}</Alert></div>}

        {searching ? (
          <>
            <SectionLabel className="px-2">Results</SectionLabel>
            {results.error && <div className="px-2"><Alert variant="error">{results.error}</Alert></div>}
            {!results.error && results.loading && <p className="px-2 py-1 text-ui-sm text-specter-text-subtle">Searching…</p>}
            {!results.error && !results.loading && !results.users.length && (
              <p className="px-2 py-1 text-ui-sm text-specter-text-subtle">No one found. Search matches the start of a callsign.</p>
            )}
            <ul aria-label="Search results" className="space-y-0.5">
              {results.users.map((u) => {
                const st = states[u.id];
                return (
                  <Person key={u.id} callsign={u.callsign} tag={u.global_tag}>
                    {st === FRIEND.FRIENDS ? <span className="text-ui-xs text-specter-text-subtle">Friends</span>
                      : st === FRIEND.OUTGOING ? <span className="text-ui-xs text-specter-text-subtle">Request sent</span>
                      : st === FRIEND.INCOMING ? (
                        <Button size="sm" disabled={busy[u.id]} onClick={() => accept({ id: u.id, callsign: u.callsign })}>Accept</Button>
                      ) : (
                        <Button size="sm" variant="secondary" disabled={busy[u.id]} icon={<UserPlus size={14} />} onClick={() => add(u)}>Add</Button>
                      )}
                  </Person>
                );
              })}
            </ul>
          </>
        ) : (
          <>
            {incoming.length > 0 && (
              <>
                <SectionLabel className="px-2">Requests · {incoming.length}</SectionLabel>
                <ul aria-label="Friend requests" className="space-y-0.5">
                  {incoming.map((f) => (
                    <Person key={idOf(f)} callsign={f.callsign} tag={f.global_tag}>
                      <button type="button" aria-label={`Accept ${f.callsign}`} disabled={busy[idOf(f)]} onClick={() => accept(f)}
                        className={cx(rowBtn, 'text-specter-primary-neon')}><Check size={16} /></button>
                      <button type="button" aria-label={`Decline ${f.callsign}`} disabled={busy[idOf(f)]} onClick={() => decline(f)}
                        className={rowBtn}><X size={16} /></button>
                    </Person>
                  ))}
                </ul>
              </>
            )}
            <SectionLabel className="px-2">Friends{accepted.length ? ` · ${accepted.length}` : ''}</SectionLabel>
            {friends === null && <p className="px-2 py-1 text-ui-sm text-specter-text-subtle">Loading friends…</p>}
            {friends !== null && !accepted.length && (
              <p className="px-2 py-1 text-ui-sm text-specter-text-subtle">No friends yet. Search above to add someone.</p>
            )}
            <ul aria-label="Friends" className="space-y-0.5">
              {accepted.map((f) => (
                <Person key={idOf(f)} callsign={f.callsign} tag={f.global_tag}>
                  {confirmRemove === idOf(f) ? (
                    <>
                      <Button size="sm" variant="danger" disabled={busy[idOf(f)]} onClick={() => remove(f)}>Remove</Button>
                      <button type="button" aria-label="Cancel" onClick={() => setConfirmRemove(null)} className={rowBtn}><X size={16} /></button>
                    </>
                  ) : (
                    <>
                      {onMessage && (
                        <button type="button" aria-label={`Message ${f.callsign}`} onClick={() => onMessage({ userId: idOf(f), callsign: f.callsign })}
                          className={rowBtn}><MessageSquare size={16} /></button>
                      )}
                      <button type="button" aria-label={`Remove ${f.callsign}`} onClick={() => setConfirmRemove(idOf(f))}
                        className={rowBtn}><UserMinus size={16} /></button>
                    </>
                  )}
                </Person>
              ))}
            </ul>
            {outgoing.length > 0 && (
              <>
                <SectionLabel className="px-2">Sent · {outgoing.length}</SectionLabel>
                <ul aria-label="Sent requests" className="space-y-0.5">
                  {outgoing.map((f) => (
                    <Person key={idOf(f)} callsign={f.callsign} tag="Waiting for a reply">
                      <button type="button" aria-label={`Cancel request to ${f.callsign}`} disabled={busy[idOf(f)]} onClick={() => remove(f)}
                        className={rowBtn}><X size={16} /></button>
                    </Person>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
