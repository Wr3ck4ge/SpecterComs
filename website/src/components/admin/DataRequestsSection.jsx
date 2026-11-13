import React, { useCallback, useEffect, useState } from 'react';
import { RBtn, Table, Alert, Badge, Time } from './ui';
import { DsrModal } from './UsersSection';

// L6: account data requests (owner only). Users ask for an export or an
// erasure from Settings -> Your data; nothing runs automatically. "Run" opens
// the same audited export / erasure dialog the Users page uses (callsign
// confirmation, reason, re-auth, legal-hold checks); once it succeeds the
// request is marked done with an audit entry.

const TYPE_LABEL = { export: 'Data export', delete: 'Account deletion' };

export default function DataRequestsSection({ adminApi }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [running, setRunning] = useState(null);

  const load = useCallback(async () => {
    const { data, error } = await adminApi.listDataRequests('open');
    if (error) { setErr(error); return; }
    setErr(null);
    setRows(data.requests);
  }, [adminApi]);
  useEffect(() => { load(); }, [load]);

  const done = async (req, text) => {
    const { error } = await adminApi.completeDataRequest(req.id, null);
    setRunning(null);
    setMsg(error ? `${text} The request could not be marked done: ${error}` : `${text} Request marked done.`);
    load();
  };

  const overdue = (r) => new Date(r.due_by).getTime() < Date.now();

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">Data requests</h2>
        <p className="text-sm text-gray-500">
          Users asked for a copy of their data or for their account to be erased. Handle each within 30 days. Deliver exports
          over a secure channel.
        </p>
      </div>
      {err && <Alert>{err}</Alert>}
      {msg && <Alert type="warn">{msg}</Alert>}
      {rows && rows.length === 0 && <div className="text-sm text-gray-400">No open requests.</div>}
      {rows && rows.length > 0 && (
        <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-x-auto">
          <Table cols={['User', 'Request', 'Asked', 'Due by', '']}>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-gray-100">
                <td className="px-4 py-3 text-sm font-medium">{r.callsign || '(erased)'}</td>
                <td className="px-4 py-3 text-sm"><Badge tone={r.type === 'delete' ? 'red' : 'blue'}>{TYPE_LABEL[r.type]}</Badge></td>
                <td className="px-4 py-3 text-sm"><Time ts={r.created_at} /></td>
                <td className="px-4 py-3 text-sm">
                  <Time ts={r.due_by} />{overdue(r) && <> <Badge tone="red">Overdue</Badge></>}
                </td>
                <td className="px-4 py-3 text-right">
                  {r.user_id
                    ? <RBtn small variant={r.type === 'delete' ? 'danger' : undefined} onClick={() => { setMsg(null); setRunning(r); }}>
                      {r.type === 'delete' ? 'Run erasure' : 'Run export'}
                    </RBtn>
                    : <RBtn small onClick={() => done(r, 'Account already erased.')}>Mark done</RBtn>}
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      {running && (
        <DsrModal
          adminApi={adminApi}
          user={{ id: running.user_id, callsign: running.callsign }}
          mode={running.type === 'delete' ? 'erase' : 'export'}
          onClose={() => setRunning(null)}
          onDone={(text) => done(running, text)}
        />
      )}
    </div>
  );
}
