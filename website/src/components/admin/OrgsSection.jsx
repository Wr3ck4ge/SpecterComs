import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RBtn, Table, SearchBar, Alert, Pagination, Modal, Field, TextInput, Badge, Time, can, useDebounced } from './ui';

const JOIN_LABEL = { 0: 'Open', 1: 'Application', 2: 'Invite Only' };

function DissolveModal({ adminApi, org, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ackBilling, setAckBilling] = useState(false);
  const [needsBillingAck, setNeedsBillingAck] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const { error, code, body } = await adminApi.dissolveOrg(org.id, {
      reason, confirm_callsign: confirm, acknowledge_billing_loss: ackBilling,
    });
    setBusy(false);
    if (code === 'BILLING_RECORDS_PRESENT') { setNeedsBillingAck(body?.payments ?? 1); return; }
    if (error) { setErr(error); return; }
    onDone(`"${org.callsign}" dissolved.`);
  };

  return (
    <Modal title={`Dissolve organization — ${org.callsign}`} onClose={onClose}>
      <div className="text-sm text-gray-600 space-y-1">
        <p>Permanently deletes the organization, its {org.member_count ?? 0} membership(s), {org.channel_count ?? 0} channel(s), roles, events and invites. Members' accounts are not affected.</p>
      </div>
      {needsBillingAck && (
        <label className="flex items-start gap-2 text-sm bg-amber-50 border border-amber-200 rounded p-2 text-amber-800">
          <input type="checkbox" checked={ackBilling} onChange={(e) => setAckBilling(e.target.checked)} className="mt-0.5" />
          <span>This org has {needsBillingAck} completed payment record(s); dissolving it deletes its billing history. Export it for bookkeeping first. I understand.</span>
        </label>
      )}
      <Field label="Reason (required)">
        <TextInput value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Field label={`Type "${org.callsign}" to confirm`}>
        <TextInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
      </Field>
      {err && <Alert>{err}</Alert>}
      <div className="flex justify-end gap-2">
        <RBtn variant="ghost" onClick={onClose}>Cancel</RBtn>
        <RBtn
          variant="danger"
          disabled={busy || !reason.trim() || confirm.trim() !== org.callsign || (needsBillingAck && !ackBilling)}
          onClick={submit}
        >
          {busy ? 'Working…' : 'Dissolve Permanently'}
        </RBtn>
      </div>
    </Modal>
  );
}

export default function OrgsSection({ adminApi, role }) {
  const [orgs, setOrgs]       = useState([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(1);
  const [q, setQ]             = useState('');
  const [sort, setSort]       = useState('created_at');
  const [dir, setDir]         = useState('desc');
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [msg, setMsg]         = useState(null);
  const [actionErr, setActionErr] = useState(null);
  const [nodes, setNodes]     = useState([]);
  const [dissolveTarget, setDissolveTarget] = useState(null);
  const dq = useDebounced(q);
  const seq = useRef(0);
  const limit = 50;

  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    adminApi.listOrgs({ q: dq, sort, dir, page, limit }).then(({ data, error }) => {
      if (mine !== seq.current) return;
      setLoading(false);
      if (error) { setError(error); return; }
      setOrgs(data.orgs || []);
      setTotal(data.total || 0);
    });
  }, [dq, sort, dir, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [dq, sort, dir]);
  // Node list for the assignment dropdown — shared endpoint with the Servers tab.
  useEffect(() => {
    adminApi.listNodes().then(({ data }) => { if (data) setNodes(data.nodes || []); });
  }, []);

  const handleAssign = async (orgId, nodeId) => {
    setActionErr(null);
    const { error } = nodeId ? await adminApi.assignOrgNode(orgId, nodeId) : await adminApi.unassignOrgNode(orgId);
    if (error) { setActionErr(error); return; }
    load();
  };

  return (
    <div className="space-y-4">
      {msg && <Alert type="success" onDismiss={() => setMsg(null)}>{msg}</Alert>}
      {actionErr && <Alert onDismiss={() => setActionErr(null)}>{actionErr}</Alert>}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <SearchBar value={q} onChange={setQ} placeholder="Search org callsign…" />
        <span className="text-sm text-gray-500">{total.toLocaleString()} organizations</span>
      </div>
      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <Table
          cols={[
            { key: 'callsign', label: 'Callsign', sortable: true },
            { key: 'owner', label: 'Owner' },
            { key: 'member_count', label: 'Members', sortable: true },
            { key: 'channels', label: 'Channels' },
            { key: 'visibility', label: 'Visibility' },
            { key: 'join', label: 'Join Method' },
            { key: 'server', label: 'Server' },
            { key: 'created_at', label: 'Created', sortable: true },
            { key: 'actions', label: '' },
          ]}
          sort={sort}
          dir={dir}
          onSort={(k, d) => { setSort(k); setDir(d); }}
          loading={loading}
          error={error}
          empty={dq ? 'No organizations match.' : 'No organizations yet.'}
        >
          {orgs.map((o) => (
            <tr key={o.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
              <td className="px-4 py-3 font-semibold text-gray-800">{o.callsign ?? '—'}</td>
              <td className="px-4 py-3 text-gray-500 text-sm">{o.owner_callsign ?? '—'}</td>
              <td className="px-4 py-3 text-gray-500 text-sm text-center">{o.member_count ?? 0}</td>
              <td className="px-4 py-3 text-gray-500 text-sm text-center">{o.channel_count ?? 0}</td>
              <td className="px-4 py-3"><Badge tone={o.is_public ? 'blue' : 'gray'}>{o.is_public ? 'Public' : 'Private'}</Badge></td>
              <td className="px-4 py-3 text-gray-400 text-sm">{JOIN_LABEL[o.join_method] ?? '—'}</td>
              <td className="px-4 py-3">
                <select
                  className="bg-white border border-gray-300 rounded text-xs px-2 py-1 disabled:opacity-50"
                  value={o.assigned_node_id || ''}
                  disabled={!can(role, 'operator')}
                  onChange={(e) => handleAssign(o.id, e.target.value)}
                >
                  <option value="">Default (shared)</option>
                  {nodes.map((n) => <option key={n.node_id} value={n.node_id}>{n.node_id} ({n.region})</option>)}
                </select>
              </td>
              <td className="px-4 py-3 text-gray-400 text-sm"><Time ts={o.created_at} dateOnly /></td>
              <td className="px-4 py-3 text-right">
                {can(role, 'owner') && <RBtn small variant="danger" onClick={() => setDissolveTarget(o)}>Dissolve…</RBtn>}
              </td>
            </tr>
          ))}
        </Table>
      </div>
      <Pagination page={page} limit={limit} total={total} onPage={setPage} />
      {dissolveTarget && (
        <DissolveModal
          adminApi={adminApi}
          org={dissolveTarget}
          onClose={() => setDissolveTarget(null)}
          onDone={(m) => { setDissolveTarget(null); setMsg(m); load(); }}
        />
      )}
    </div>
  );
}
