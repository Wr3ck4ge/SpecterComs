import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RBtn, Table, SearchBar, Alert, Pagination, Modal, Field, TextInput, Badge, Time, can, useDebounced } from './ui';

export default function HwidBansSection({ adminApi, role }) {
  const [bans, setBans]       = useState([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(1);
  const [q, setQ]             = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [msg, setMsg]         = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [reason, setReason]   = useState('');
  const [revokeErr, setRevokeErr] = useState(null);
  const dq = useDebounced(q);
  const seq = useRef(0);
  const limit = 50;

  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    adminApi.listHwidBans({ q: dq, page, limit }).then(({ data, error }) => {
      if (mine !== seq.current) return;
      setLoading(false);
      if (error) { setError(error); return; }
      setBans(data.bans || []);
      setTotal(data.total || 0);
    });
  }, [dq, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [dq]);

  const revoke = async () => {
    setRevokeErr(null);
    const { error } = await adminApi.removeHwidBan(revokeTarget.hwid, reason);
    if (error) { setRevokeErr(error); return; }
    setRevokeTarget(null);
    setReason('');
    setMsg('Hardware ban revoked.');
    load();
  };

  const invalidCount = bans.filter((b) => !b.valid_hardware_id).length;

  return (
    <div className="space-y-4">
      {msg && <Alert type="success" onDismiss={() => setMsg(null)}>{msg}</Alert>}
      {invalidCount > 0 && (
        <Alert type="warn">
          {invalidCount} ban(s) on this page target an ID that is not a real device fingerprint (e.g. the shared
          browser placeholder). Those block every user who sends the same ID — review and revoke them.
        </Alert>
      )}
      <div className="flex justify-between items-center flex-wrap gap-2">
        <SearchBar value={q} onChange={setQ} placeholder="HWID prefix or linked callsign…" />
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">{total.toLocaleString()} bans</span>
          <RBtn small onClick={load}>Refresh</RBtn>
        </div>
      </div>
      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <Table
          cols={['HWID', 'Banned From', 'Accounts Blocked', 'Reason', 'Banned At', '']}
          loading={loading}
          error={error}
          empty={dq ? 'No bans match.' : 'No HWID bans on record.'}
        >
          {bans.map((b) => (
            <tr key={b.hwid} className={`border-b border-gray-100 hover:bg-gray-50 ${b.valid_hardware_id ? '' : 'bg-amber-50'}`}>
              <td className="px-4 py-3">
                <code className="font-mono text-gray-600 text-xs" title={b.hwid}>{b.hwid_short ?? '—'}</code>
                {!b.valid_hardware_id && <div className="mt-1"><Badge tone="amber">{b.validity_note || 'Invalid ID'}</Badge></div>}
              </td>
              <td className="px-4 py-3 text-gray-700 text-sm">{b.source_callsign || b.callsign || '—'}</td>
              <td className="px-4 py-3 text-sm">
                <span className={b.linked_accounts > 1 ? 'text-red-600 font-semibold' : 'text-gray-600'}>{b.linked_accounts ?? 0}</span>
              </td>
              <td className="px-4 py-3 text-gray-500 text-sm max-w-xs truncate" title={b.reason || ''}>{b.reason || '—'}</td>
              <td className="px-4 py-3 text-gray-400 text-sm"><Time ts={b.created_at} /></td>
              <td className="px-4 py-3 text-right">
                {can(role, 'operator') && <RBtn small variant="success" onClick={() => setRevokeTarget(b)}>Revoke…</RBtn>}
              </td>
            </tr>
          ))}
        </Table>
      </div>
      <Pagination page={page} limit={limit} total={total} onPage={setPage} />

      {revokeTarget && (
        <Modal title="Revoke hardware ban" onClose={() => { setRevokeTarget(null); setRevokeErr(null); }}>
          <p className="text-sm text-gray-600">
            Lifts the device ban on <code className="text-xs bg-gray-100 px-1 rounded">{revokeTarget.hwid_short}</code>.{' '}
            {revokeTarget.linked_accounts ?? 0} account(s) use this ID; their individual account bans (if any) are not changed.
          </p>
          <Field label="Reason (optional)">
            <TextInput value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {revokeErr && <Alert>{revokeErr}</Alert>}
          <div className="flex justify-end gap-2">
            <RBtn variant="ghost" onClick={() => setRevokeTarget(null)}>Cancel</RBtn>
            <RBtn variant="success" onClick={revoke}>Revoke Ban</RBtn>
          </div>
        </Modal>
      )}
    </div>
  );
}
