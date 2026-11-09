import React, { useState, useEffect, useCallback } from 'react';
import { RBtn, StatCard, Table, Alert, fmtDate } from './ui';
import { isOptedOut, setOptedOut } from '../../traffic.js';

// Website traffic counter: daily aggregates from GET /admin/traffic. Answers
// "is anyone but me visiting?" — no per-visitor data exists to show.

// The server sends UTC calendar days as 'YYYY-MM-DD'. Pinning to noon UTC
// keeps fmtDate on the same calendar date in every viewer timezone.
const dayLabel = (day) => fmtDate(`${day}T12:00:00Z`);

const n = (v) => (typeof v === 'number' ? v.toLocaleString() : '—');

function sumRows(rows, key) {
  let total = 0;
  for (const r of rows) total += r[key] ?? 0;
  return total;
}

function Panel({ title, children }) {
  return (
    <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 text-xs uppercase tracking-wider text-gray-500 font-medium">{title}</div>
      {children}
    </div>
  );
}

function Totals({ label, rows }) {
  const bots = sumRows(rows, 'bot_hits') + sumRows(rows, 'download_bot_hits');
  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-widest text-gray-500 font-medium">{label}</div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Page views" value={n(sumRows(rows, 'views'))} />
        <StatCard label="Unique visitors" value={n(sumRows(rows, 'uniques'))} sub="Counted per day, summed" />
        <StatCard label="Downloads" value={n(sumRows(rows, 'downloads'))} />
        <StatCard label="Bot hits" value={n(bots)} sub="Not included above" />
      </div>
    </div>
  );
}

function NoTrackToggle() {
  const [on, setOn] = useState(() => isOptedOut(globalThis.localStorage));
  const toggle = (e) => {
    setOptedOut(globalThis.localStorage, e.target.checked);
    setOn(isOptedOut(globalThis.localStorage));
  };
  return (
    <label className="flex items-start gap-3 border border-gray-200 bg-white rounded-lg p-4 shadow-sm cursor-pointer">
      <input type="checkbox" className="mt-0.5" checked={on} onChange={toggle} />
      <span className="text-sm">
        <span className="font-medium text-gray-800">Don&apos;t count visits from this browser</span>
        <span className="block text-xs text-gray-500 mt-0.5">
          Stored in this browser only. Turn it on in each browser you use for the site.
          Admin panel pages are never counted either way.
        </span>
      </span>
    </label>
  );
}

export default function TrafficSection({ adminApi }) {
  const [data, setData]   = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy]   = useState(false);

  const load = useCallback(() => {
    setError(null);
    setBusy(true);
    adminApi.traffic(30).then(({ data, error }) => {
      setBusy(false);
      if (error) setError(error);
      else setData(data);
    });
  }, [adminApi]);

  useEffect(() => { load(); }, [load]);

  const daily = Array.isArray(data?.daily) ? data.daily : [];
  const last7 = daily.slice(0, 7);
  const peak = Math.max(1, ...daily.map((d) => d.views ?? 0));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-500">
          Daily totals in UTC. No cookies, IP addresses or user agents are stored.
        </p>
        <RBtn onClick={load} disabled={busy}>{busy ? 'Loading…' : 'Refresh'}</RBtn>
      </div>

      <NoTrackToggle />

      {error && <Alert>Could not load traffic: {error}</Alert>}
      {!data && !error && <div className="text-gray-400 text-sm p-8 text-center">Loading traffic…</div>}

      {data && (
        <>
          <Totals label="Last 7 days" rows={last7} />
          <Totals label="Last 30 days" rows={daily} />

          <Panel title="Per day">
            <Table cols={['Day', 'Views', '', 'Visitors', 'Downloads', 'Bot hits']} empty="No data yet.">
              {daily.map((d) => (
                <tr key={d.day} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-700 whitespace-nowrap">{dayLabel(d.day)}</td>
                  <td className="px-4 py-2 text-gray-800 font-medium">{n(d.views)}</td>
                  <td className="px-4 py-2 w-1/3">
                    <div className="h-2 rounded bg-gray-100" aria-hidden="true">
                      <div className="h-2 rounded bg-gray-500" style={{ width: `${((d.views ?? 0) / peak) * 100}%` }} />
                    </div>
                  </td>
                  <td className="px-4 py-2 text-gray-700">{n(d.uniques)}</td>
                  <td className="px-4 py-2 text-gray-700">{n(d.downloads)}</td>
                  <td className="px-4 py-2 text-gray-400">{n((d.bot_hits ?? 0) + (d.download_bot_hits ?? 0))}</td>
                </tr>
              ))}
            </Table>
          </Panel>

          <div className="space-y-6">
            <Panel title="Top pages (30 days)">
              <Table cols={['Path', 'Views', 'Bot hits']} empty="No page views yet.">
                {(data.top_paths || []).map((p) => (
                  <tr key={p.path} className="border-b border-gray-100">
                    <td className="px-4 py-2 font-mono text-gray-800">{p.path}</td>
                    <td className="px-4 py-2 text-gray-700">{n(p.views)}</td>
                    <td className="px-4 py-2 text-gray-400">{n(p.bot_hits)}</td>
                  </tr>
                ))}
              </Table>
            </Panel>
            <Panel title="Top refs (30 days)">
              <Table cols={['?ref=', 'Views']} empty="No tagged visits yet.">
                {(data.top_refs || []).map((r) => (
                  <tr key={r.ref} className="border-b border-gray-100">
                    <td className="px-4 py-2 font-mono text-gray-800">{r.ref}</td>
                    <td className="px-4 py-2 text-gray-700">{n(r.views)}</td>
                  </tr>
                ))}
              </Table>
            </Panel>
            <Panel title="Downloads by platform (30 days)">
              <Table cols={['Platform', 'Downloads', 'Bot hits']} empty="No downloads yet.">
                {(data.downloads_by_platform || []).map((p) => (
                  <tr key={p.platform} className="border-b border-gray-100">
                    <td className="px-4 py-2 text-gray-800 capitalize">{p.platform}</td>
                    <td className="px-4 py-2 text-gray-700">{n(p.downloads)}</td>
                    <td className="px-4 py-2 text-gray-400">{n(p.bot_hits)}</td>
                  </tr>
                ))}
              </Table>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
