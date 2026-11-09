import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RBtn, Table, Alert, Pagination, Time, useDebounced } from './ui';

const ACTION_GROUPS = [
  ['', 'All actions'],
  ['admin.', 'Admin sessions & roles'],
  ['user.', 'Users'],
  ['org.', 'Organizations'],
  ['hwid_ban.', 'Hardware bans'],
  ['voice_report.', 'Voice reports'],
  ['node.', 'Nodes'],
];

function toIsoOrEmpty(localValue) {
  if (!localValue) return '';
  const d = new Date(localValue); // datetime-local is interpreted in the browser's zone
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export default function AuditSection({ adminApi }) {
  const [entries, setEntries] = useState([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(1);
  const [action, setAction]   = useState('');
  const [targetId, setTargetId] = useState('');
  const [from, setFrom]       = useState('');
  const [to, setTo]           = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [expanded, setExpanded] = useState(null);
  const dTarget = useDebounced(targetId.trim());
  const seq = useRef(0);
  const limit = 50;

  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    adminApi.listAudit({ action, target_id: dTarget, from: toIsoOrEmpty(from), to: toIsoOrEmpty(to), page, limit }).then(({ data, error }) => {
      if (mine !== seq.current) return;
      setLoading(false);
      if (error) { setError(error); return; }
      setEntries(data.entries || []);
      setTotal(data.total || 0);
    });
  }, [action, dTarget, from, to, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [action, dTarget, from, to]);

  return (
    <div className="space-y-4">
      <Alert type="warn">Append-only record of every admin action. Entries cannot be edited or deleted (enforced by a database trigger).</Alert>
      <div className="flex flex-wrap items-end gap-2">
        <select className="bg-white border border-gray-300 rounded text-sm px-2 py-1.5" value={action} onChange={(e) => setAction(e.target.value)}>
          {ACTION_GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input
          className="bg-white border border-gray-300 rounded px-3 py-1.5 text-sm w-72 font-mono"
          placeholder="Target id (user / org UUID)"
          value={targetId}
          maxLength={128}
          onChange={(e) => setTargetId(e.target.value)}
        />
        <label className="text-xs text-gray-500">From <input type="datetime-local" className="border border-gray-300 rounded px-2 py-1 text-sm" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-xs text-gray-500">To <input type="datetime-local" className="border border-gray-300 rounded px-2 py-1 text-sm" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <RBtn small onClick={load}>Refresh</RBtn>
        <span className="text-sm text-gray-500 ml-auto">{total.toLocaleString()} entries</span>
      </div>
      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <Table cols={['When', 'Admin', 'Action', 'Target', 'Reason', 'IP', '']} loading={loading} error={error} empty="No audit entries match.">
          {entries.map((e) => (
            <React.Fragment key={e.id}>
              <tr className="border-b border-gray-100 hover:bg-gray-50 text-sm">
                <td className="px-4 py-2 text-gray-500 whitespace-nowrap"><Time ts={e.created_at} /></td>
                <td className="px-4 py-2 text-gray-700">{e.admin_username || '—'}</td>
                <td className="px-4 py-2 font-mono text-xs">{e.action}</td>
                <td className="px-4 py-2 text-xs text-gray-500">
                  {e.target_type ? <span>{e.target_type}: <span className="font-mono">{e.target_id || '—'}</span></span> : '—'}
                </td>
                <td className="px-4 py-2 text-gray-500 max-w-xs truncate" title={e.reason || ''}>{e.reason || '—'}</td>
                <td className="px-4 py-2 text-xs text-gray-400 font-mono">{e.ip || '—'}</td>
                <td className="px-4 py-2 text-right">
                  <RBtn small variant="ghost" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>{expanded === e.id ? 'Hide' : 'Details'}</RBtn>
                </td>
              </tr>
              {expanded === e.id && (
                <tr className="bg-gray-50 border-b border-gray-100">
                  <td colSpan={7} className="px-4 py-3">
                    <pre className="text-xs text-gray-700 whitespace-pre-wrap break-all">{JSON.stringify(e.summary ?? {}, null, 2)}</pre>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </Table>
      </div>
      <Pagination page={page} limit={limit} total={total} onPage={setPage} />
    </div>
  );
}
