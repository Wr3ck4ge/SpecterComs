import React, { useState, useEffect, useCallback } from 'react';
import {
  RBtn, Table, SearchBar, Alert, Pagination, Modal, Field, TextInput, Badge, Time, can, useDebounced,
} from './ui';

const TIER_LABEL = { 0: 'Free' };

function statusBadge(u) {
  if (u.erased_at) return <Badge tone="gray">Erased</Badge>;
  if (u.is_banned) return <Badge tone="red">Banned</Badge>;
  return <Badge tone="green">Active</Badge>;
}

// ─── Ban / unban ──────────────────────────────────────────────────────────────

function BanModal({ adminApi, user, hwid, onClose, onDone }) {
  const banning = !user.is_banned;
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [hwidBan, setHwidBan] = useState(false);
  const [ackShared, setAckShared] = useState(false);
  const [hwidUnban, setHwidUnban] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const bannable = !!hwid?.bannable;
  const shared = hwid?.shared_accounts || 0;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const body = banning
      ? { ban: true, reason, confirm_callsign: confirm, hwid_ban: hwidBan, acknowledge_shared_hwid: ackShared }
      : { ban: false, reason, confirm_callsign: confirm, hwid_unban: hwidUnban };
    const { data, error } = await adminApi.banUser(user.id, body);
    setBusy(false);
    if (error) { setErr(error); return; }
    onDone(banning
      ? `${user.callsign} banned. ${data.sessions_revoked ?? 0} session(s) revoked${data.hwid_ban_applied ? '; hardware ban applied' : ''}.`
      : `${user.callsign} unbanned${data.hwid_ban_removed ? '; hardware ban removed' : ''}.`);
  };

  return (
    <Modal title={`${banning ? 'Ban' : 'Revoke ban'} — ${user.callsign}`} onClose={onClose}>
      <div className="text-sm text-gray-600 space-y-1">
        {banning ? (
          <>
            <p><strong>Account ban:</strong> blocks this account and immediately revokes all of its refresh sessions (an open session can keep working for up to 30 minutes).</p>
            <p><strong>Hardware ban</strong> (optional): blocks sign-in and registration from this device for <em>every</em> account on it.</p>
          </>
        ) : (
          <p>Restores sign-in for this account.</p>
        )}
      </div>

      <Field label={banning ? 'Reason (required)' : 'Reason (optional)'}>
        <TextInput value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Terms of Service violation — ticket #123" />
      </Field>

      {banning ? (
        <div className="border border-gray-200 rounded p-3 space-y-2 text-sm">
          <label className={`flex items-start gap-2 ${bannable ? '' : 'opacity-60'}`}>
            <input type="checkbox" disabled={!bannable} checked={hwidBan} onChange={(e) => setHwidBan(e.target.checked)} className="mt-0.5" />
            <span>
              Also ban this device {hwid?.short && <code className="text-xs bg-gray-100 px-1 rounded">{hwid.short}</code>}
              <span className="block text-xs text-gray-500">{hwid?.reason || 'No hardware ID on record.'}</span>
            </span>
          </label>
          {bannable && hwidBan && shared > 0 && (
            <label className="flex items-start gap-2 text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
              <input type="checkbox" checked={ackShared} onChange={(e) => setAckShared(e.target.checked)} className="mt-0.5" />
              <span>I understand this device is also used by <strong>{shared}</strong> other account(s), which will all be blocked.</span>
            </label>
          )}
        </div>
      ) : (
        hwid?.is_banned && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={hwidUnban} onChange={(e) => setHwidUnban(e.target.checked)} />
            Also lift the hardware ban on this device ({shared + 1} account(s) affected)
          </label>
        )
      )}

      <Field label={`Type "${user.callsign}" to confirm`}>
        <TextInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
      </Field>

      {err && <Alert>{err}</Alert>}
      <div className="flex gap-3 pt-1 justify-end">
        <RBtn variant="ghost" onClick={onClose}>Cancel</RBtn>
        <RBtn
          variant={banning ? 'danger' : 'success'}
          disabled={busy || confirm.trim() !== user.callsign || (banning && !reason.trim()) || (hwidBan && shared > 0 && !ackShared)}
          onClick={submit}
        >
          {busy ? 'Working…' : banning ? 'Confirm Ban' : 'Revoke Ban'}
        </RBtn>
      </div>
    </Modal>
  );
}

// ─── Data-subject requests ────────────────────────────────────────────────────

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function DsrModal({ adminApi, user, mode, onClose, onDone }) {
  const [preview, setPreview] = useState(null);
  const [previewErr, setPreviewErr] = useState(null);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const erase = mode === 'erase';

  useEffect(() => {
    if (!erase) return;
    adminApi.erasurePreview(user.id).then(({ data, error }) => {
      if (error) setPreviewErr(error); else setPreview(data);
    });
  }, [erase, user.id]);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const body = { reason, confirm_callsign: confirm, override_legal_hold: override };
    const { data, error, body: errBody } = erase ? await adminApi.eraseUser(user.id, body) : await adminApi.exportUser(user.id, body);
    setBusy(false);
    if (error) {
      setErr(errBody?.owned_orgs?.length
        ? `${error} (${errBody.owned_orgs.map((o) => o.callsign).join(', ')})`
        : error);
      return;
    }
    if (erase) onDone(`Account erased. ${Object.keys(data.affected || {}).length} related table(s) cleaned.`);
    else {
      downloadJson(data, `account-export-${user.id}.json`);
      onDone('Export downloaded. Deliver it to the data subject over a secure channel, then delete your local copy.');
    }
  };

  const blockers = preview?.blockers;
  const blocked = erase && (blockers?.owned_orgs?.length > 0 || (blockers?.pending_reports_as_accused > 0 && !override));

  return (
    <Modal title={`${erase ? 'Erase account' : 'Export account data'} — ${user.callsign}`} onClose={onClose} wide>
      {erase ? (
        <div className="space-y-3 text-sm">
          <Alert type="warn">Irreversible. Use only for a verified erasure request (GDPR Art. 17 / CCPA delete).</Alert>
          {previewErr && <Alert>{previewErr}</Alert>}
          {!preview && !previewErr && <div className="text-gray-400">Loading impact preview…</div>}
          {preview && (
            <>
              {blockers.owned_orgs.length > 0 && (
                <Alert>Owns {blockers.owned_orgs.length} organization(s): {blockers.owned_orgs.map((o) => o.callsign).join(', ')}. Transfer or dissolve them first.</Alert>
              )}
              {blockers.pending_reports_as_accused > 0 && (
                <label className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded p-2 text-amber-800">
                  <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} className="mt-0.5" />
                  <span>Accused in {blockers.pending_reports_as_accused} pending misconduct report(s). Override this hold (it will be recorded in the audit log).</span>
                </label>
              )}
              <div className="border border-gray-200 rounded max-h-48 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-gray-500 text-left"><th className="px-3 py-1">Table</th><th className="px-3 py-1">Rows</th><th className="px-3 py-1">Action</th></tr></thead>
                  <tbody>
                    {preview.tables.length === 0
                      ? <tr><td colSpan={3} className="px-3 py-2 text-gray-400">No related rows.</td></tr>
                      : preview.tables.map((t) => (
                        <tr key={`${t.table}.${t.column}`} className="border-t border-gray-100">
                          <td className="px-3 py-1 font-mono">{t.table}.{t.column}</td>
                          <td className="px-3 py-1">{t.rows}</td>
                          <td className="px-3 py-1">{{ delete: 'delete', nullify: 'unlink', default: 'reset', retain: 'retain (anonymised)' }[t.plan] || t.plan}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <ul className="list-disc pl-5 text-xs text-gray-500 space-y-0.5">
                {preview.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            </>
          )}
        </div>
      ) : (
        <div className="text-sm text-gray-600 space-y-1">
          <p>Builds a JSON copy of everything the server holds about this account (GDPR Art. 15 / CCPA access), including the decrypted email.</p>
          <p className="text-xs text-gray-500">Credentials, encrypted message content (never readable server-side) and reporters' identities are excluded. The export is recorded in the audit log.</p>
        </div>
      )}

      <Field label="Request reference / reason (required)">
        <TextInput value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. DSR-2026-014, verified via account email" />
      </Field>
      <Field label={`Type "${user.callsign}" to confirm`}>
        <TextInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
      </Field>
      {err && <Alert>{err}</Alert>}
      <div className="flex gap-3 justify-end">
        <RBtn variant="ghost" onClick={onClose}>Cancel</RBtn>
        <RBtn
          variant={erase ? 'danger' : 'default'}
          disabled={busy || blocked || !reason.trim() || confirm.trim() !== user.callsign || (erase && !preview)}
          onClick={submit}
        >
          {busy ? 'Working…' : erase ? 'Erase Permanently' : 'Export'}
        </RBtn>
      </div>
    </Modal>
  );
}

// ─── Detail ───────────────────────────────────────────────────────────────────

function RevealEmail({ adminApi, userId, masked, status, role }) {
  const [email, setEmail] = useState(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);

  if (status !== 'present') {
    return <span className="text-gray-400">{status === 'unavailable' ? 'Unreadable' : 'None on file'}</span>;
  }
  if (email) return <span className="font-mono break-all">{email}</span>;

  const reveal = async () => {
    setErr(null);
    const { data, error } = await adminApi.revealEmail(userId, reason);
    if (error) { setErr(error); return; }
    setEmail(data.email);
    setAsking(false);
  };

  return (
    <div className="space-y-1">
      <span className="font-mono">{masked}</span>
      {can(role, 'operator') && !asking && (
        <button className="ml-2 text-xs text-blue-600 hover:underline" onClick={() => setAsking(true)}>Reveal</button>
      )}
      {asking && (
        <div className="flex gap-1 items-center">
          <input
            className="border border-gray-300 rounded px-2 py-0.5 text-xs flex-1"
            placeholder="Reason (logged)"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
          <RBtn small disabled={reason.trim().length < 5} onClick={reveal}>Show</RBtn>
        </div>
      )}
      {err && <div className="text-xs text-red-600">{err}</div>}
    </div>
  );
}

function UserDetailModal({ adminApi, userId, role, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [action, setAction] = useState(null); // 'ban' | 'export' | 'erase'
  const [msg, setMsg] = useState(null);

  const load = useCallback(() => {
    setError(null);
    adminApi.getUser(userId).then(({ data, error }) => {
      if (error) setError(error); else setData(data);
    });
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const done = (text) => {
    setAction(null);
    setMsg(text);
    load();
    onChanged?.();
  };

  if (error) {
    return <Modal title="User detail" onClose={onClose}><Alert>{error}</Alert></Modal>;
  }
  if (!data) {
    return <Modal title="User detail" onClose={onClose}><div className="text-gray-400 text-sm">Loading…</div></Modal>;
  }

  const u = data.user || {};
  const hw = data.hwid || {};
  const erased = !!u.erased_at;

  return (
    <>
      <Modal title={`${u.callsign ?? 'Unknown'} — User Detail`} onClose={onClose} wide>
        {msg && <Alert type="success" onDismiss={() => setMsg(null)}>{msg}</Alert>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          {[
            ['UUID', <span className="font-mono text-xs break-all">{u.id}</span>],
            ['Status', statusBadge(u)],
            ['Email', erased ? '—' : <RevealEmail adminApi={adminApi} userId={u.id} masked={u.email_masked} status={u.email_status} role={role} />],
            ['Tag', u.global_tag || '—'],
            ['Tier', TIER_LABEL[u.subscription_tier] ?? (u.subscription_tier ?? '—')],
            ['Timezone', u.timezone || '—'],
            ['Joined', <Time ts={u.created_at} />],
            ['Active sessions / devices', `${data.stats?.active_sessions ?? 0} / ${data.stats?.active_devices ?? 0}`],
            ...(u.is_banned && !erased ? [['Banned', <span><Time ts={u.banned_at} />{u.ban_reason ? ` — ${u.ban_reason}` : ''}</span>]] : []),
            ...(erased ? [['Erased', <Time ts={u.erased_at} />]] : []),
          ].map(([label, val]) => (
            <div key={label}>
              <div className="text-gray-400 text-xs uppercase tracking-wider mb-0.5">{label}</div>
              <div className="font-medium text-gray-800">{val}</div>
            </div>
          ))}
        </div>

        {!erased && (
          <div className="border border-gray-200 rounded p-3 text-sm space-y-1">
            <div className="text-xs uppercase tracking-wider text-gray-400">Hardware ID</div>
            {hw.present ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="text-xs bg-gray-100 px-1 rounded">{hw.short}</code>
                  {hw.bannable ? <Badge tone="blue">Desktop fingerprint</Badge> : <Badge tone="amber">Not bannable</Badge>}
                  {hw.is_banned && <Badge tone="red">Hardware-banned</Badge>}
                </div>
                <div className="text-xs text-gray-500">{hw.reason}</div>
                <div className="text-xs text-gray-500">
                  {hw.shared_accounts > 0
                    ? <>Shared with <strong>{hw.shared_accounts}</strong> other account(s) — a hardware ban affects all of them.</>
                    : 'No other accounts use this device.'}
                </div>
              </>
            ) : <div className="text-xs text-gray-500">{hw.reason || 'None on record.'}</div>}
          </div>
        )}

        <div>
          <div className="text-gray-400 text-xs uppercase tracking-wider mb-2">Org Memberships ({data.orgs_total ?? 0})</div>
          {(data.orgs || []).length === 0
            ? <div className="text-sm text-gray-400">None.</div>
            : (
              <div className="max-h-40 overflow-y-auto rounded border border-gray-200">
                {data.orgs.map((o) => (
                  <div key={o.id} className="flex justify-between text-sm px-3 py-1.5 bg-gray-50 border-b border-gray-100 last:border-0">
                    <span className="font-medium text-gray-700">{o.callsign}{o.is_owner && <span className="ml-2"><Badge tone="blue">Owner</Badge></span>}</span>
                    <span className="text-gray-400">{o.role_name || 'Member'}</span>
                  </div>
                ))}
                {data.orgs_total > data.orgs.length && (
                  <div className="px-3 py-1.5 text-xs text-gray-400">…and {data.orgs_total - data.orgs.length} more</div>
                )}
              </div>
            )}
        </div>

        {(data.audit || []).length > 0 && (
          <div>
            <div className="text-gray-400 text-xs uppercase tracking-wider mb-2">Admin history</div>
            <div className="max-h-32 overflow-y-auto text-xs space-y-1">
              {data.audit.map((a) => (
                <div key={a.id} className="flex justify-between gap-2">
                  <span><span className="font-mono">{a.action}</span> by {a.admin_username || 'unknown'}{a.reason ? ` — ${a.reason}` : ''}</span>
                  <span className="text-gray-400 whitespace-nowrap"><Time ts={a.created_at} /></span>
                </div>
              ))}
            </div>
          </div>
        )}

        {!erased && (
          <div className="flex flex-wrap gap-2 justify-end border-t border-gray-200 pt-3">
            {can(role, 'operator') && (
              <RBtn small variant={u.is_banned ? 'success' : 'danger'} onClick={() => setAction('ban')}>
                {u.is_banned ? 'Unban…' : 'Ban…'}
              </RBtn>
            )}
            {can(role, 'owner') && <RBtn small onClick={() => setAction('export')}>Export data…</RBtn>}
            {can(role, 'owner') && <RBtn small variant="danger" onClick={() => setAction('erase')}>Erase account…</RBtn>}
          </div>
        )}
      </Modal>
      {action === 'ban' && <BanModal adminApi={adminApi} user={u} hwid={hw} onClose={() => setAction(null)} onDone={done} />}
      {(action === 'export' || action === 'erase') && (
        <DsrModal adminApi={adminApi} user={u} mode={action} onClose={() => setAction(null)} onDone={done} />
      )}
    </>
  );
}

// ─── Section ──────────────────────────────────────────────────────────────────

export default function UsersSection({ adminApi, role }) {
  const [rows, setRows]       = useState([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(1);
  const [limit, setLimit]     = useState(50);
  const [q, setQ]             = useState('');
  const [email, setEmail]     = useState('');
  const [emailQuery, setEmailQuery] = useState('');
  const [status, setStatus]   = useState('all');
  const [sort, setSort]       = useState('created_at');
  const [dir, setDir]         = useState('desc');
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [detailId, setDetailId] = useState(null);
  const dq = useDebounced(q);
  const seq = React.useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    adminApi.listUsers({ q: dq, email: emailQuery, status, sort, dir, page, limit }).then(({ data, error }) => {
      if (mine !== seq.current) return; // a newer request superseded this one
      setLoading(false);
      if (error) { setError(error); return; }
      setRows(data.users || []);
      setTotal(data.total || 0);
    });
  }, [dq, emailQuery, status, sort, dir, page, limit]);

  useEffect(() => { load(); }, [load]);
  // Any filter change goes back to page 1.
  useEffect(() => { setPage(1); }, [dq, emailQuery, status, sort, dir, limit]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <SearchBar value={q} onChange={setQ} placeholder="Search callsign / tag…" className="w-56" />
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => { e.preventDefault(); setEmailQuery(email.trim()); }}
          >
            <input
              type="email"
              className="bg-white border border-gray-300 rounded px-3 py-1.5 text-sm w-56"
              placeholder="Exact email lookup (audited)"
              value={email}
              maxLength={254}
              onChange={(e) => setEmail(e.target.value)}
            />
            <RBtn small type="submit">Find</RBtn>
            {emailQuery && <RBtn small variant="ghost" onClick={() => { setEmail(''); setEmailQuery(''); }}>Clear</RBtn>}
          </form>
          <select className="bg-white border border-gray-300 rounded text-sm px-2 py-1.5" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="banned">Banned</option>
            <option value="erased">Erased</option>
          </select>
          <select className="bg-white border border-gray-300 rounded text-sm px-2 py-1.5" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[25, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}
          </select>
        </div>
        <span className="text-sm text-gray-500">{total.toLocaleString()} users</span>
      </div>

      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <Table
          cols={[
            { key: 'callsign', label: 'Callsign', sortable: true },
            { key: 'tier', label: 'Tier', sortable: true },
            { key: 'created_at', label: 'Joined', sortable: true },
            { key: 'device', label: 'Device' },
            { key: 'status', label: 'Status' },
          ]}
          sort={sort}
          dir={dir}
          onSort={(k, d) => { setSort(k); setDir(d); }}
          loading={loading}
          error={error}
          empty={dq || emailQuery || status !== 'all' ? 'No users match these filters.' : 'No users yet.'}
        >
          {rows.map((u) => (
            <tr key={u.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors cursor-pointer" onClick={() => setDetailId(u.id)}>
              <td className="px-4 py-3">
                <span className="font-semibold text-gray-800 text-sm">{u.callsign ?? '—'}</span>
                {u.global_tag && <span className="ml-2 text-xs text-gray-400">[{u.global_tag}]</span>}
              </td>
              <td className="px-4 py-3 text-gray-500 text-sm">{TIER_LABEL[u.subscription_tier] ?? (u.subscription_tier ?? '—')}</td>
              <td className="px-4 py-3 text-gray-500 text-sm"><Time ts={u.created_at} dateOnly /></td>
              <td className="px-4 py-3 text-xs text-gray-500">
                {!u.hwid_present ? 'web only' : u.hwid_bannable ? 'desktop' : <Badge tone="amber">placeholder</Badge>}
              </td>
              <td className="px-4 py-3">{statusBadge(u)}</td>
            </tr>
          ))}
        </Table>
      </div>
      <Pagination page={page} limit={limit} total={total} onPage={setPage} />

      {detailId && (
        <UserDetailModal adminApi={adminApi} userId={detailId} role={role} onClose={() => setDetailId(null)} onChanged={load} />
      )}
    </div>
  );
}
