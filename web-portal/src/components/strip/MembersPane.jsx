import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2, UserMinus, Volume2 } from 'lucide-react';
import { Alert, Button, Input, Toggle } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { api } from '../../api';
import { PaneHeader } from './ServerTools';

// Server admin: Members & ranks (owner, 2026-11-08). The owner — and anyone
// whose rank grants "View member list" / "Manage ranks" — sees every member
// with their online status and rank, can re-rank members below their own
// rank, and edit the ranks below theirs. The server enforces every rule
// (utils/orgAuthority); the UI only hides what would be refused.

const errText = (error, fallback) => (typeof error === 'string' ? error : error?.message || fallback);

/** Owner, or a rank with can_view_members / can_manage_roles (server: canViewRoster). */
export const canViewMembers = (org, userId) =>
  Boolean(org && userId && (org.owner_id === userId
    || org.permissions?.can_view_members === true || org.permissions?.can_manage_roles === true));

export const PERMISSION_LABELS = {
  can_view_members: ['View member list', 'See every member, their rank and whether they are online'],
  can_manage_roles: ['Manage ranks', 'Change members’ ranks and edit ranks below their own'],
  can_manage_channels: ['Manage channels', 'Create, rename and delete channels, and set who can see them'],
  can_kick: ['Kick', 'Remove members from the server or a channel'],
  can_ban: ['Ban', 'Ban members from the server'],
  can_mute: ['Mute', 'Server-mute members'],
  can_invite: ['Invite', 'Create invite links'],
  can_create_events: ['Plan operations', 'Create and run events / operations'],
  can_view_calendar: ['View calendar', 'See the server’s scheduled events'],
  can_view_billing: ['View billing', 'See the server wallet and usage'],
};

const STATUS = {
  voice: { dot: 'bg-specter-state-success', label: 'In voice' },
  online: { dot: 'bg-specter-state-success', label: 'Online' },
  away: { dot: 'bg-amber-400', label: 'Away' },
  busy: { dot: 'bg-red-400', label: 'Busy' },
  offline: { dot: 'bg-white/20', label: 'Offline' },
};

const selectCls = cx(
  'h-8 px-2 rounded-ui-row text-ui-sm text-specter-text-main bg-specter-bg-deep/60 border border-specter-border',
  'hover:border-specter-border-strong focus:border-specter-primary-cyan focus:outline-none disabled:opacity-50',
);

const REFRESH_MS = 15_000;

export function MembersPane({ org, onBack }) {
  const [tab, setTab] = useState('members'); // 'members' | 'ranks'
  const [state, setState] = useState({ loading: true, error: null, data: null });

  const load = useCallback(async () => {
    const { data, error } = await api.getMemberRoster(org.id);
    if (error) setState((s) => ({ loading: false, error: errText(error, 'Could not load members'), data: s.data }));
    else setState({ loading: false, error: null, data });
  }, [org.id]);
  useEffect(() => {
    setState({ loading: true, error: null, data: null });
    load();
    // Online status changes all the time; a light poll while the pane is open.
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const data = state.data;
  const me = data?.me;
  const canManageRanks = Boolean(me && (me.is_owner || me.permissions?.can_manage_roles));

  return (
    <div className="pb-2">
      <PaneHeader title={`Members · ${org.callsign}`} onBack={onBack} />
      <div className="px-4 pb-2">
        <div role="tablist" aria-label="Members or ranks" className="inline-flex rounded-ui-row border border-specter-border p-0.5">
          {[['members', 'Members'], ['ranks', 'Ranks']].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={cx('px-3 h-7 rounded-ui-row text-ui-sm transition-colors', focusRing,
                tab === id ? 'bg-specter-primary-cyan/15 text-specter-text-main' : 'text-specter-text-subtle hover:text-specter-text-main')}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {state.error && <div className="px-4 pb-2"><Alert variant="error">{state.error}</Alert></div>}
      {state.loading && !data && <p className="px-4 py-2 text-ui-sm text-specter-text-subtle">Loading members…</p>}
      {data && tab === 'members' && <MemberList org={org} data={data} canManageRanks={canManageRanks} onChanged={load} />}
      {data && tab === 'ranks' && <RankList org={org} data={data} canManageRanks={canManageRanks} onChanged={load} />}
    </div>
  );
}

// ── Members ────────────────────────────────────────────────────────────────
function MemberList({ org, data, canManageRanks, onChanged }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(null); // user_id
  const members = data.members || [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? members.filter((m) => m.callsign?.toLowerCase().includes(q) || m.role_name?.toLowerCase().includes(q)) : members;
  }, [members, query]);
  const onlineCount = members.filter((m) => m.status !== 'offline').length;

  return (
    <>
      <div className="px-4 pb-2">
        <Input aria-label="Search members" placeholder="Search by callsign or rank" value={query}
          onChange={(e) => setQuery(e.target.value)} />
        <p className="mt-1 text-ui-xs text-specter-text-subtle">
          {onlineCount} online · {members.length} {members.length === 1 ? 'member' : 'members'}
        </p>
      </div>
      <ul className="px-2 space-y-0.5" aria-label="Members">
        {shown.map((m) => (
          <MemberRow key={m.user_id} org={org} m={m} roles={data.roles || []} me={data.me}
            canManageRanks={canManageRanks} open={open === m.user_id}
            onToggle={() => setOpen((o) => (o === m.user_id ? null : m.user_id))} onChanged={onChanged} />
        ))}
        {!shown.length && <li className="px-2 py-2 text-ui-sm text-specter-text-subtle">No members match.</li>}
      </ul>
      <p className="px-4 pt-2 text-ui-xs text-specter-text-subtle">
        You can manage members below your own rank. Updates every 15 seconds.
      </p>
    </>
  );
}

function MemberRow({ org, m, roles, me, canManageRanks, open, onToggle, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmKick, setConfirmKick] = useState(false);
  const st = STATUS[m.status] || STATUS.offline;
  const canKick = m.manageable && (me.is_owner || me.permissions?.can_kick);
  const canRerank = m.manageable && canManageRanks;
  const expandable = canRerank || canKick;
  // Ranks I may hand out: strictly below mine (all of them for the owner).
  const assignable = roles.filter((r) => me.is_owner || r.level < (me.level ?? 0));

  const setRank = async (roleId) => {
    setBusy(true); setError(null);
    const { error: err } = await api.assignMemberRole(org.id, m.user_id, roleId || null);
    setBusy(false);
    if (err) { setError(errText(err, 'Could not change rank')); return; }
    onChanged();
  };
  const kick = async () => {
    setBusy(true); setError(null);
    const { error: err } = await api.kickMember(org.id, m.user_id);
    setBusy(false);
    if (err) { setError(errText(err, 'Could not remove member')); return; }
    setConfirmKick(false);
    onChanged();
  };

  return (
    <li className={cx('rounded-ui-row', open && 'bg-white/[0.03]')}>
      <button type="button" onClick={expandable ? onToggle : undefined} aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        className={cx('w-full flex items-center gap-2.5 px-2 py-1.5 rounded-ui-row text-left', focusRing,
          expandable ? 'hover:bg-white/5 cursor-pointer' : 'cursor-default')}>
        <span className={cx('h-2 w-2 shrink-0 rounded-full', st.dot)} aria-hidden="true" />
        <span className="flex-1 min-w-0">
          <span className="block truncate text-ui-sm font-medium text-specter-text-main">{m.callsign}</span>
          <span className="block truncate text-ui-xs text-specter-text-subtle">
            {st.label}
            {m.status === 'voice' && m.voice_channel?.name && (
              <> · <Volume2 size={10} className="inline -mt-0.5" aria-hidden="true" /> {m.voice_channel.name}</>
            )}
          </span>
        </span>
        <span className={cx('shrink-0 max-w-[40%] truncate text-ui-xs', m.is_owner ? 'text-specter-primary-neon' : 'text-specter-text-subtle')}>
          {m.role_name || 'No rank'}
        </span>
        {expandable && (open ? <ChevronDown size={14} className="shrink-0 text-specter-text-subtle" aria-hidden="true" />
          : <ChevronRight size={14} className="shrink-0 text-specter-text-subtle" aria-hidden="true" />)}
      </button>
      {open && expandable && (
        <div className="px-2 pb-2 pl-7 space-y-2">
          {canRerank && (
            <label className="flex items-center gap-2 text-ui-xs text-specter-text-subtle">
              Rank
              <select className={selectCls} disabled={busy} value={m.role_id || ''} onChange={(e) => setRank(e.target.value)}
                aria-label={`Rank for ${m.callsign}`}>
                {!m.role_id && <option value="">No rank</option>}
                {assignable.map((r) => <option key={r.id} value={r.id}>{r.name} (level {r.level})</option>)}
              </select>
            </label>
          )}
          {canKick && !confirmKick && (
            <Button size="sm" variant="ghost" icon={<UserMinus size={14} />} disabled={busy} onClick={() => setConfirmKick(true)}>
              Remove from server
            </Button>
          )}
          {confirmKick && (
            <div className="flex flex-wrap items-center gap-2 text-ui-xs text-specter-text-subtle">
              Remove {m.callsign} from {org.callsign}? They can rejoin with an invite.
              <Button size="sm" variant="danger" disabled={busy} onClick={kick}>Remove</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmKick(false)}>Cancel</Button>
            </div>
          )}
          {error && <Alert variant="error">{error}</Alert>}
        </div>
      )}
    </li>
  );
}

// ── Ranks ──────────────────────────────────────────────────────────────────
function RankList({ org, data, canManageRanks, onChanged }) {
  const [open, setOpen] = useState(null); // role id | 'new'
  const roles = data.roles || [];
  const counts = useMemo(() => {
    const c = {};
    for (const m of data.members || []) if (m.role_id && !m.is_owner) c[m.role_id] = (c[m.role_id] || 0) + 1;
    return c;
  }, [data.members]);

  return (
    <>
      <p className="px-4 pb-2 text-ui-xs text-specter-text-subtle">
        Higher levels outrank lower ones. A rank can manage members and ranks below its own level, and can only
        hand out permissions it has. Channels can be limited to a minimum level.
      </p>
      <ul className="px-2 space-y-0.5" aria-label="Ranks">
        {roles.map((r) => (
          <RankRow key={r.id} org={org} rank={r} me={data.me} keys={data.permission_keys} count={counts[r.id] || 0}
            open={open === r.id} onToggle={() => setOpen((o) => (o === r.id ? null : r.id))}
            onChanged={() => { onChanged(); }} onDeleted={() => { setOpen(null); onChanged(); }} />
        ))}
      </ul>
      {canManageRanks && (
        open === 'new'
          ? <div className="mx-2 mt-1 rounded-ui-row bg-white/[0.03]">
              <RankEditor org={org} me={data.me} keys={data.permission_keys} rank={null}
                onDone={() => { setOpen(null); onChanged(); }} onCancel={() => setOpen(null)} />
            </div>
          : <div className="px-4 pt-2">
              <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setOpen('new')}>New rank</Button>
            </div>
      )}
    </>
  );
}

function RankRow({ org, rank, me, keys, count, open, onToggle, onChanged, onDeleted }) {
  const granted = (keys || []).filter((k) => rank.permissions?.[k] === true);
  return (
    <li className={cx('rounded-ui-row', open && 'bg-white/[0.03]')}>
      <button type="button" onClick={rank.editable ? onToggle : undefined} disabled={!rank.editable} aria-expanded={rank.editable ? open : undefined}
        className={cx('w-full flex items-center gap-2.5 px-2 py-1.5 rounded-ui-row text-left', focusRing,
          rank.editable ? 'hover:bg-white/5' : 'cursor-default')}>
        <span className="w-9 shrink-0 text-center font-mono text-ui-xs text-specter-text-subtle" title="Level">{rank.level}</span>
        <span className="flex-1 min-w-0">
          <span className="block truncate text-ui-sm font-medium text-specter-text-main">{rank.name}</span>
          <span className="block truncate text-ui-xs text-specter-text-subtle">
            {count} {count === 1 ? 'member' : 'members'} · {granted.length ? granted.map((k) => PERMISSION_LABELS[k]?.[0] || k).join(', ') : 'no permissions'}
          </span>
        </span>
        {rank.editable && (open ? <ChevronDown size={14} className="shrink-0 text-specter-text-subtle" aria-hidden="true" />
          : <ChevronRight size={14} className="shrink-0 text-specter-text-subtle" aria-hidden="true" />)}
      </button>
      {open && rank.editable && (
        <RankEditor org={org} me={me} keys={keys} rank={rank} count={count} onDone={onChanged} onDeleted={onDeleted} />
      )}
    </li>
  );
}

function RankEditor({ org, me, keys, rank, count = 0, onDone, onCancel, onDeleted }) {
  const [name, setName] = useState(rank?.name || '');
  const [level, setLevel] = useState(rank ? String(rank.level) : '');
  const [perms, setPerms] = useState(() => ({ ...(rank?.permissions || {}) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const holds = (k) => me.is_owner || me.permissions?.[k] === true;
  const maxLevel = me.is_owner ? null : (me.level ?? 0) - 1;

  const save = async () => {
    const lv = Number(level);
    if (!name.trim()) { setError('Give the rank a name'); return; }
    if (!Number.isInteger(lv) || lv < 0) { setError('Level must be a whole number from 0'); return; }
    if (maxLevel != null && lv > maxLevel) { setError(`Level must be below your own (${me.level})`); return; }
    setBusy(true); setError(null); setSaved(false);
    const body = { name: name.trim(), level: lv, permissions: Object.fromEntries((keys || []).map((k) => [k, perms[k] === true])) };
    const { error: err } = rank ? await api.updateRole(org.id, rank.id, body) : await api.createRole(org.id, body);
    setBusy(false);
    if (err) { setError(errText(err, 'Could not save rank')); return; }
    setSaved(true);
    onDone?.();
  };
  const remove = async () => {
    setBusy(true); setError(null);
    const { error: err } = await api.deleteRole(org.id, rank.id);
    setBusy(false);
    if (err) { setError(errText(err, 'Could not delete rank')); return; }
    onDeleted?.();
  };

  return (
    <div className="px-2 pb-2 pt-1 space-y-2">
      <div className="flex gap-2">
        <div className="flex-1"><Input label="Name" value={name} maxLength={32} onChange={(e) => { setName(e.target.value); setSaved(false); }} /></div>
        <div className="w-24"><Input label="Level" type="number" min={0} max={maxLevel ?? undefined} value={level}
          onChange={(e) => { setLevel(e.target.value); setSaved(false); }} /></div>
      </div>
      <div className="space-y-1.5">
        {(keys || []).map((k) => (
          <Toggle key={k} label={PERMISSION_LABELS[k]?.[0] || k}
            description={holds(k) ? PERMISSION_LABELS[k]?.[1] : 'You can only grant permissions you have'}
            checked={perms[k] === true} disabled={busy || (!holds(k) && perms[k] !== true)}
            onChange={(on) => { setPerms((p) => ({ ...p, [k]: on })); setSaved(false); }} />
        ))}
      </div>
      {error && <Alert variant="error">{error}</Alert>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : rank ? 'Save rank' : 'Create rank'}</Button>
        {onCancel && <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>}
        {saved && <span className="text-ui-xs text-specter-primary-neon">Saved</span>}
        {rank && !confirmDelete && (
          <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} disabled={busy} onClick={() => setConfirmDelete(true)} className="ml-auto">
            Delete
          </Button>
        )}
        {rank && confirmDelete && (
          <span className="ml-auto flex items-center gap-2 text-ui-xs text-specter-text-subtle">
            {count ? `${count} ${count === 1 ? 'member is' : 'members are'} left with no rank.` : 'Delete this rank?'}
            <Button size="sm" variant="danger" disabled={busy} onClick={remove}>Delete</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep</Button>
          </span>
        )}
      </div>
    </div>
  );
}
