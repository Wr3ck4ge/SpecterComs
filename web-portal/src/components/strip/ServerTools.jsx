import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Copy, Plus, Search, Trash2 } from 'lucide-react';
import { Alert, Button, Input } from '../ui';
import { cx, focusRing } from '../ui/styles';
import HexBadge from '../HexBadge';
import { getOrgColor } from '../../utils/orgColors';
import { api, UPLOADS_BASE_URL } from '../../api';

// Server discovery, joining by invite code, and invite-link management for
// the strip's server cabinet (StripView's ServerCabinet).

const errText = (error, fallback) => (typeof error === 'string' ? error : error?.message || fallback);

/** Owner, or a member whose role grants can_invite (same rule the server enforces). */
export const canManageInvites = (org, userId) =>
  Boolean(org && userId && (org.owner_id === userId || org.permissions?.can_invite === true));

export function PaneHeader({ title, onBack }) {
  return (
    <div className="flex items-center gap-1 px-2 pb-1">
      <button type="button" onClick={onBack} aria-label="Back to servers"
        className={cx('inline-flex h-8 w-8 items-center justify-center rounded-ui-row text-specter-text-subtle hover:bg-white/5 hover:text-specter-text-main', focusRing)}>
        <ArrowLeft size={16} aria-hidden="true" />
      </button>
      <h3 className="text-ui-base font-semibold text-specter-text-main">{title}</h3>
    </div>
  );
}

/** A launcher row in the server cabinet. */
export function ToolRow({ icon, title, subtitle, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className={cx('w-full flex items-center gap-3 px-2 py-2 rounded-ui-row text-left transition-colors hover:bg-white/5', focusRing)}>
      <span className="shrink-0 inline-flex h-[30px] w-[30px] items-center justify-center rounded-ui-row bg-specter-primary-cyan/10 text-specter-primary-neon">
        {icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-ui-sm font-medium text-specter-text-main">{title}</span>
        <span className="block truncate text-ui-xs text-specter-text-subtle">{subtitle}</span>
      </span>
    </button>
  );
}

// ── Join with an invite code ───────────────────────────────────────────────
export function JoinWithCode({ onBack, onJoined }) {
  const [code, setCode] = useState('');
  const [state, setState] = useState({ busy: false, error: null, done: null });

  const submit = async (e) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!c) return;
    setState({ busy: true, error: null, done: null });
    const { data, error } = await api.redeemInvite(c);
    if (error) {
      setState({ busy: false, error: errText(error, 'That invite did not work'), done: null });
      return;
    }
    const name = data?.org?.callsign || 'the server';
    setState({ busy: false, error: null, done: `Joined ${name}` });
    setCode('');
    onJoined?.(data?.org?.id);
  };

  return (
    <div className="pb-2">
      <PaneHeader title="Join with invite code" onBack={onBack} />
      <form onSubmit={submit} className="px-4 space-y-2">
        <Input label="Invite code" value={code} onChange={(e) => setCode(e.target.value)}
          placeholder="e.g. 9F3A12BC" autoComplete="off" spellCheck={false} maxLength={16} />
        {state.error && <Alert variant="error">{state.error}</Alert>}
        {state.done && <p role="status" className="text-ui-xs text-specter-primary-neon">{state.done}</p>}
        <Button type="submit" size="sm" disabled={state.busy || !code.trim()}>
          {state.busy ? 'Joining…' : 'Join server'}
        </Button>
      </form>
    </div>
  );
}

// ── Discover public servers ────────────────────────────────────────────────
const JOIN_LABEL = { 0: 'Join', 1: 'Apply' };

export function DiscoverPane({ myOrgIds, onBack, onJoined }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState({ loading: true, error: null, servers: [] });
  const [rowState, setRowState] = useState({}); // orgId -> { busy, error, done }
  const reqRef = useRef(0);

  useEffect(() => {
    const seq = ++reqRef.current;
    setList((l) => ({ ...l, loading: true, error: null }));
    const t = setTimeout(async () => {
      const { data, error } = await api.getPublicOrgs(q.trim());
      if (seq !== reqRef.current) return; // a newer search is in flight
      if (error) setList({ loading: false, error: errText(error, 'Could not load servers'), servers: [] });
      else setList({ loading: false, error: null, servers: data?.servers || [] });
    }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q]);

  const join = useCallback(async (org) => {
    setRowState((s) => ({ ...s, [org.id]: { busy: true } }));
    const { error } = await api.joinOrg(org.id);
    if (error) {
      setRowState((s) => ({ ...s, [org.id]: { error: errText(error, 'Could not join') } }));
      return;
    }
    const applied = org.join_method === 1;
    setRowState((s) => ({ ...s, [org.id]: { done: applied ? 'Application sent' : 'Joined' } }));
    if (!applied) onJoined?.(org.id);
  }, [onJoined]);

  const visible = list.servers.filter((s) => !myOrgIds.has(s.id));

  return (
    <div className="pb-2">
      <PaneHeader title="Discover servers" onBack={onBack} />
      <div className="px-4 pb-2">
        <div className="relative">
          <Search size={14} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-specter-text-subtle" />
          <Input aria-label="Search public servers" placeholder="Search by name" value={q}
            onChange={(e) => setQ(e.target.value)} inputClassName="pl-8" maxLength={64} />
        </div>
      </div>
      {list.error && <div className="px-4"><Alert variant="error">{list.error}</Alert></div>}
      {!list.error && list.loading && !visible.length && (
        <p className="px-4 py-2 text-ui-sm text-specter-text-subtle">Searching…</p>
      )}
      {!list.error && !list.loading && !visible.length && (
        <p className="px-4 py-2 text-ui-sm text-specter-text-subtle">
          {q ? 'No public servers match that name.' : 'No public servers to show.'}
        </p>
      )}
      <ul className="px-2 space-y-0.5" aria-label="Public servers">
        {visible.map((org, i) => {
          const st = rowState[org.id] || {};
          const label = JOIN_LABEL[org.join_method];
          return (
            <li key={org.id} className="flex items-center gap-3 px-2 py-2 rounded-ui-row">
              <HexBadge letter={(org.callsign || '?')[0]} colorKey={getOrgColor(i)} size={30}
                imageUrl={org.logo_url ? `${UPLOADS_BASE_URL}${org.logo_url}` : null} />
              <span className="flex-1 min-w-0">
                <span className="block truncate text-ui-base font-medium text-specter-text-main">{org.callsign}</span>
                <span className="block truncate text-ui-xs text-specter-text-subtle">
                  {org.member_count} {Number(org.member_count) === 1 ? 'member' : 'members'}
                  {org.description ? ` · ${org.description}` : ''}
                </span>
                {st.error && <span role="alert" className="block text-ui-xs text-red-300">{st.error}</span>}
              </span>
              {st.done ? (
                <span role="status" className="shrink-0 text-ui-xs text-specter-primary-neon">{st.done}</span>
              ) : label ? (
                <Button size="sm" variant="secondary" className="shrink-0" disabled={st.busy} onClick={() => join(org)}>
                  {st.busy ? '…' : label}
                </Button>
              ) : (
                <span className="shrink-0 text-ui-xs text-specter-text-subtle">Invite only</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Invite links (owner / can_invite) ──────────────────────────────────────
const EXPIRY_OPTIONS = [
  { label: '1 hour', hours: 1 },
  { label: '1 day', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: '30 days', hours: 24 * 30 },
  { label: 'Never', hours: null },
];
const USES_OPTIONS = [
  { label: '1 use', uses: 1 },
  { label: '5 uses', uses: 5 },
  { label: '25 uses', uses: 25 },
  { label: 'Unlimited', uses: null },
];

const selectCls = cx(
  'h-8 px-2 rounded-ui-row text-ui-sm text-specter-text-main bg-specter-bg-deep/60 border border-specter-border',
  'hover:border-specter-border-strong focus:border-specter-primary-cyan focus:outline-none',
);

function describeInvite(inv) {
  const uses = inv.uses_left == null ? 'unlimited uses' : `${inv.uses_left} ${inv.uses_left === 1 ? 'use' : 'uses'} left`;
  let exp = 'never expires';
  if (inv.expires_at) {
    const ms = new Date(inv.expires_at).getTime() - Date.now();
    const h = Math.max(1, Math.round(ms / 3600_000));
    exp = h >= 48 ? `expires in ${Math.round(h / 24)} days` : `expires in ${h} h`;
  }
  return `${uses} · ${exp}${inv.created_by_callsign ? ` · by ${inv.created_by_callsign}` : ''}`;
}

export function InvitesPane({ org, onBack }) {
  const [list, setList] = useState({ loading: true, error: null, invites: [] });
  const [hours, setHours] = useState(24 * 7);
  const [uses, setUses] = useState(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [revoking, setRevoking] = useState(null); // code being revoked
  const [copied, setCopied] = useState(null);
  const [actionError, setActionError] = useState(null);

  const load = useCallback(async () => {
    const { data, error } = await api.listInvites(org.id);
    if (error) setList({ loading: false, error: errText(error, 'Could not load invites'), invites: [] });
    else setList({ loading: false, error: null, invites: data?.invites || [] });
  }, [org.id]);
  useEffect(() => { setList({ loading: true, error: null, invites: [] }); load(); }, [load]);

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    const body = {};
    if (hours != null) body.expires_in_hours = hours;
    if (uses != null) body.uses_left = uses;
    const { data, error } = await api.createInvite(org.id, body);
    setCreating(false);
    if (error) { setCreateError(errText(error, 'Could not create invite')); return; }
    if (data?.code) copy(data.code);
    load();
  };

  const copy = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied((c) => (c === code ? null : c)), 1800);
    } catch { /* clipboard blocked: the code is still on screen */ }
  };

  const revoke = async (code) => {
    setRevoking(code);
    setActionError(null);
    const { error } = await api.revokeInvite(org.id, code);
    setRevoking(null);
    if (error) { setActionError(errText(error, 'Could not revoke invite')); return; }
    setList((l) => ({ ...l, invites: l.invites.filter((i) => i.code !== code) }));
  };

  return (
    <div className="pb-2">
      <PaneHeader title={`Invites · ${org.callsign}`} onBack={onBack} />
      <div className="px-4 pb-2 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Expires after" className={selectCls} value={hours ?? 'never'}
            onChange={(e) => setHours(e.target.value === 'never' ? null : Number(e.target.value))}>
            {EXPIRY_OPTIONS.map((o) => <option key={o.label} value={o.hours ?? 'never'}>{o.label}</option>)}
          </select>
          <select aria-label="Maximum uses" className={selectCls} value={uses ?? 'unlimited'}
            onChange={(e) => setUses(e.target.value === 'unlimited' ? null : Number(e.target.value))}>
            {USES_OPTIONS.map((o) => <option key={o.label} value={o.uses ?? 'unlimited'}>{o.label}</option>)}
          </select>
          <Button size="sm" disabled={creating} onClick={create} icon={<Plus size={14} />}>
            {creating ? 'Creating…' : 'New invite'}
          </Button>
        </div>
        {createError && <Alert variant="error">{createError}</Alert>}
        {actionError && <Alert variant="error">{actionError}</Alert>}
      </div>
      {list.error && <div className="px-4"><Alert variant="error">{list.error}</Alert></div>}
      {!list.error && list.loading && <p className="px-4 py-2 text-ui-sm text-specter-text-subtle">Loading invites…</p>}
      {!list.error && !list.loading && !list.invites.length && (
        <p className="px-4 py-2 text-ui-sm text-specter-text-subtle">No active invites. New ones are copied to your clipboard.</p>
      )}
      <ul className="px-2 space-y-0.5" aria-label="Active invites">
        {list.invites.map((inv) => (
          <li key={inv.code} className="flex items-center gap-2 px-2 py-1.5 rounded-ui-row">
            <span className="flex-1 min-w-0">
              <span className="block font-mono text-ui-base tracking-wider text-specter-text-main">{inv.code}</span>
              <span className="block truncate text-ui-xs text-specter-text-subtle">{describeInvite(inv)}</span>
            </span>
            <button type="button" onClick={() => copy(inv.code)} aria-label={`Copy invite ${inv.code}`}
              className={cx('inline-flex h-8 w-8 items-center justify-center rounded-ui-row text-specter-text-subtle hover:bg-white/5 hover:text-specter-text-main', focusRing)}>
              {copied === inv.code ? <Check size={15} className="text-specter-primary-neon" /> : <Copy size={15} />}
            </button>
            <button type="button" disabled={revoking === inv.code} onClick={() => revoke(inv.code)}
              aria-label={`Revoke invite ${inv.code}`}
              className={cx('inline-flex h-8 w-8 items-center justify-center rounded-ui-row text-red-300 hover:bg-specter-state-error/15 disabled:opacity-50', focusRing)}>
              <Trash2 size={15} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
