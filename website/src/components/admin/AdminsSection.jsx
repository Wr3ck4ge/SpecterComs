import React, { useState, useEffect, useCallback } from 'react';
import { Table, Alert, Badge, Time } from './ui';

const ROLE_HELP = {
  viewer:   'Read-only: dashboard, user/org lists (emails masked), bans, servers.',
  operator: 'Moderation: ban/unban, reveal an email (audited), voice reports, node routing, audit log.',
  owner:    'Everything, incl. account erasure/export, dissolving orgs, provisioning, invoices, admin roles.',
};

export default function AdminsSection({ adminApi, self }) {
  const [admins, setAdmins]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [msg, setMsg]         = useState(null);
  const [actionErr, setActionErr] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    adminApi.listAdmins().then(({ data, error }) => {
      setLoading(false);
      if (error) { setError(error); return; }
      setAdmins(data.admins || []);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  const changeRole = async (a, role) => {
    if (role === a.role) return;
    setActionErr(null);
    const { error } = await adminApi.setAdminRole(a.id, role);
    if (error) { setActionErr(error); return; }
    setMsg(`${a.username} is now ${role}.`);
    load();
  };

  return (
    <div className="space-y-4">
      {msg && <Alert type="success" onDismiss={() => setMsg(null)}>{msg}</Alert>}
      {actionErr && <Alert onDismiss={() => setActionErr(null)}>{actionErr}</Alert>}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs text-gray-600">
        {Object.entries(ROLE_HELP).map(([r, t]) => (
          <div key={r} className="border border-gray-200 bg-white rounded p-3"><div className="font-semibold uppercase tracking-wider text-gray-800 mb-1">{r}</div>{t}</div>
        ))}
      </div>
      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <Table cols={['Username', 'Role', 'Last Login', 'Created']} loading={loading} error={error} empty="No admins.">
          {admins.map((a) => (
            <tr key={a.id} className="border-b border-gray-100">
              <td className="px-4 py-3 font-semibold text-gray-800">{a.username}{a.id === self?.id && <span className="ml-2"><Badge>you</Badge></span>}</td>
              <td className="px-4 py-3">
                <select
                  className="bg-white border border-gray-300 rounded text-xs px-2 py-1 disabled:opacity-50"
                  value={a.role || ''}
                  disabled={a.id === self?.id}
                  onChange={(e) => changeRole(a, e.target.value)}
                >
                  {!a.role && <option value="">(no access)</option>}
                  <option value="viewer">viewer</option>
                  <option value="operator">operator</option>
                  <option value="owner">owner</option>
                </select>
                {a.role_is_legacy && a.role && <span className="ml-2 text-xs text-gray-400">(from legacy super_admin)</span>}
              </td>
              <td className="px-4 py-3 text-gray-500 text-sm"><Time ts={a.last_login} /></td>
              <td className="px-4 py-3 text-gray-400 text-sm"><Time ts={a.created_at} dateOnly /></td>
            </tr>
          ))}
        </Table>
      </div>
    </div>
  );
}
