import React, { useCallback, useEffect, useState } from 'react';
import {
  REPORT_CATEGORIES, createOwnerKey, openSealed, reportFlags, unlockOwnerKey,
} from '@spectercoms/shared-web/src/sealedReport.js';
import { RBtn, Table, Alert, Pagination, Field, TextInput, Badge, Time } from './ui';

// D1: bug reports (owner only). Descriptions arrive sealed to the owner's
// report key; this page unlocks the private key with the owner's passphrase
// and opens them here, in the browser. Nothing decrypted is sent anywhere or
// stored: the opened text lives in this page's memory only and is shown as
// plain text (React-escaped, pre-wrap; no markdown, no links).
//
// The owner's note is the trusted channel: it's the only report text that
// Claude's tools see (bug_reports_agent_view withholds the description).

// Unlocked private keys (non-extractable CryptoKeys), keyed by key id. Kept
// for the tab's life so switching sections doesn't ask again; Lock or the end
// of the admin session clears it.
const unlocked = new Map();
export const lockBugReportKeys = () => unlocked.clear();

const CATEGORY = Object.fromEntries(REPORT_CATEGORIES.map((c) => [c.id, c.label]));
const STATUS_TONE = { new: 'amber', triaged: 'blue', closed: 'gray' };
const FLAG_LABELS = {
  has_urls: 'Contains links (not clickable)',
  looks_like_instructions: 'Reads like instructions to an AI',
  has_code: 'Contains code / commands',
  redacted: 'Secrets were redacted',
};

function KeyPanel({ adminApi, keys, onChanged, onUnlocked }) {
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [replacing, setReplacing] = useState(false);
  const isUnlocked = keys.some((k) => unlocked.has(k.key_id));

  const create = async (e) => {
    e.preventDefault();
    setErr(null);
    if (pass !== pass2) { setErr('The passphrases don’t match.'); return; }
    setBusy(true);
    try {
      const key = await createOwnerKey(pass);
      const { error } = await adminApi.setBugReportKey(key);
      if (error) throw new Error(error);
      unlocked.set(key.keyId, await unlockOwnerKey(key, pass));
      setPass(''); setPass2(''); setReplacing(false);
      onChanged();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };

  const unlock = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    let opened = 0;
    for (const k of keys) {
      try {
        unlocked.set(k.key_id, await unlockOwnerKey({ keyId: k.key_id, wrapped: k.wrapped }, pass));
        opened += 1;
      } catch { /* a different passphrase, or the wrong one */ }
    }
    setBusy(false);
    if (!opened) { setErr('Wrong passphrase.'); return; }
    setPass('');
    onUnlocked();
  };

  if (!keys.length || replacing) {
    return (
      <form onSubmit={create} className="border border-gray-200 bg-white rounded-lg shadow-sm p-4 space-y-3 max-w-lg">
        <div className="text-sm font-semibold text-gray-700">{replacing ? 'Replace the report key' : 'Set up the report key'}</div>
        <p className="text-xs text-gray-500">
          Bug-report descriptions are encrypted on the user&apos;s computer to this key. Only this page, after you type the
          passphrase, can read them: the server and anything with server access see ciphertext. If the passphrase is lost,
          existing reports can&apos;t be read (they&apos;re deleted after 30 days anyway).
          {replacing && ' Older reports stay readable with the old passphrase.'}
        </p>
        <Field label="Passphrase (12+ characters)">
          <TextInput type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </Field>
        <Field label="Again">
          <TextInput type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
        </Field>
        {err && <Alert>{err}</Alert>}
        <div className="flex gap-2">
          <RBtn type="submit" variant="success" disabled={busy || pass.length < 12}>{busy ? 'Creating…' : 'Create key'}</RBtn>
          {replacing && <RBtn variant="ghost" onClick={() => setReplacing(false)}>Cancel</RBtn>}
        </div>
      </form>
    );
  }

  if (isUnlocked) {
    // Someone with server access could swap in a key of their own so new
    // reports seal to them: the active key must be one this passphrase opens.
    const active = keys.find((k) => k.active);
    const foreign = active && !unlocked.has(active.key_id);
    return (
      <div className="space-y-2">
      {foreign && (
        <Alert>
          The active report key ({active.key_id}) doesn&apos;t open with your passphrase. If you didn&apos;t replace it with a
          different passphrase, it may have been swapped on the server: new reports would be readable by whoever holds that key.
          Replace the key now and check the audit log for &quot;bug_report.key_set&quot;.
        </Alert>
      )}
      <div className="flex items-center gap-3 text-sm text-gray-600">
        <Badge tone="green">Unlocked</Badge>
        <span className="text-xs text-gray-400">Reports open in this tab only.</span>
        <RBtn small onClick={() => { lockBugReportKeys(); onUnlocked(); }}>Lock</RBtn>
        <RBtn small variant="ghost" onClick={() => setReplacing(true)}>Replace key…</RBtn>
      </div>
      </div>
    );
  }

  return (
    <form onSubmit={unlock} className="flex items-end gap-2 flex-wrap">
      <Field label="Report passphrase">
        <TextInput type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
      </Field>
      <RBtn type="submit" disabled={busy || !pass}>{busy ? 'Unlocking…' : 'Unlock'}</RBtn>
      {err && <span className="text-xs text-red-600">{err}</span>}
    </form>
  );
}

export default function BugReportsSection({ adminApi }) {
  const [keys, setKeys] = useState(null);
  const [reports, setReports] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('new');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionErr, setActionErr] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [notes, setNotes] = useState({});
  const [replies, setReplies] = useState({}); // id → unsent reply text
  const [opened, setOpened] = useState({}); // id → { text, flags } | { error }
  const [, bump] = useState(0);
  const limit = 25;

  const loadKeys = useCallback(() => {
    adminApi.listBugReportKeys().then(({ data, error: e }) => {
      if (e) setError(e); else setKeys(data.keys || []);
    });
  }, [adminApi]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    adminApi.listBugReports({ status: status === 'all' ? null : status, page, limit }).then(({ data, error: e }) => {
      setLoading(false);
      if (e) setError(e);
      else { setReports(data.reports || []); setTotal(data.total || 0); }
    });
  }, [adminApi, status, page]);

  useEffect(() => { loadKeys(); }, [loadKeys]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [status]);

  // Open what we can whenever the list or the unlocked keys change.
  const openAll = useCallback(async (list) => {
    const out = {};
    for (const r of list) {
      const key = unlocked.get(r.key_id);
      if (!key) continue;
      try {
        const text = await openSealed(key, r.sealed);
        out[r.id] = { text, flags: reportFlags(text) };
      } catch {
        out[r.id] = { error: 'Couldn’t open this report (damaged or not for this key).' };
      }
    }
    setOpened(out);
  }, []);
  useEffect(() => { openAll(reports); }, [reports, openAll]);
  const onUnlocked = () => { bump((x) => x + 1); openAll(reports); };

  // withReply: also send the reply box (undefined leaves the stored reply alone).
  const save = async (r, nextStatus, withReply = false) => {
    setActionErr(null);
    const reply = withReply ? (replies[r.id] ?? r.resolution ?? '') : undefined;
    const { error: e } = await adminApi.updateBugReport(r.id, nextStatus, notes[r.id] ?? r.owner_note ?? '', reply);
    if (e) setActionErr(e);
    else {
      if (withReply) setReplies((x) => { const n = { ...x }; delete n[r.id]; return n; });
      load();
    }
  };
  const remove = async (r) => {
    if (!window.confirm('Delete this report for good?')) return;
    setActionErr(null);
    const { error: e } = await adminApi.deleteBugReport(r.id);
    if (e) setActionErr(e); else { setExpanded(null); load(); }
  };

  if (keys === null && !error) return <div className="text-gray-400 text-sm p-8 text-center">Loading…</div>;

  return (
    <div className="space-y-4">
      {actionErr && <Alert onDismiss={() => setActionErr(null)}>{actionErr}</Alert>}
      <KeyPanel adminApi={adminApi} keys={keys || []} onChanged={() => { loadKeys(); load(); }} onUnlocked={onUnlocked} />
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600 font-medium">Bug Reports</span>
          <select className="bg-white border border-gray-300 rounded text-sm px-2 py-1 text-gray-700" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="new">New</option>
            <option value="triaged">Triaged</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">{total.toLocaleString()} reports · deleted after 30 days</span>
          <RBtn small onClick={load}>Refresh</RBtn>
        </div>
      </div>
      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <Table cols={['Reported', 'From', 'Category', 'Version', 'Length', 'Diagnostics', 'Status', '']} empty="No bug reports match." loading={loading} error={error}>
          {reports.map((r) => {
            const o = opened[r.id];
            const open = expanded === r.id;
            return (
              <React.Fragment key={r.id}>
                <tr className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-400 text-sm"><Time ts={r.created_at} /></td>
                  <td className="px-4 py-3 text-gray-700 text-sm">{r.callsign || '—'}</td>
                  <td className="px-4 py-3 text-gray-700 text-sm">{CATEGORY[r.category] || r.category}</td>
                  <td className="px-4 py-3 text-gray-500 text-sm font-mono">{r.app_version || '—'}</td>
                  <td className="px-4 py-3 text-gray-500 text-sm">{r.desc_chars}</td>
                  <td className="px-4 py-3 text-gray-500 text-sm">{r.diagnostics ? 'Sent' : '—'}</td>
                  <td className="px-4 py-3"><Badge tone={STATUS_TONE[r.status] || 'gray'}>{r.status}</Badge></td>
                  <td className="px-4 py-3 text-right">
                    <RBtn small onClick={() => setExpanded(open ? null : r.id)}>{open ? 'Hide' : 'Open'}</RBtn>
                  </td>
                </tr>
                {open && (
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <td colSpan={8} className="px-4 py-4 space-y-3">
                      <div>
                        <div className="text-xs uppercase tracking-wider text-gray-400 mb-1">What they wrote</div>
                        {!o && <div className="text-sm text-gray-400">Locked. Unlock above to read it.</div>}
                        {o?.error && <div className="text-sm text-red-600">{o.error}</div>}
                        {o?.text != null && (
                          <div className="text-sm text-gray-800 whitespace-pre-wrap break-words bg-white border border-gray-200 rounded p-3 font-mono">{o.text}</div>
                        )}
                      </div>
                      {o?.flags && (
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(FLAG_LABELS).filter(([k]) => o.flags[k]).map(([k, label]) => (
                            <Badge key={k} tone={k === 'looks_like_instructions' ? 'red' : 'amber'}>{label}</Badge>
                          ))}
                          {r.redactions > 0 && <Badge tone="gray">{r.redactions} redaction{r.redactions === 1 ? '' : 's'}</Badge>}
                        </div>
                      )}
                      {r.diagnostics && (
                        <div className="text-xs text-gray-500">
                          Diagnostics were sent with this report: look for the perf report from {r.callsign || 'this user'} at <Time ts={r.created_at} />.
                        </div>
                      )}
                      <div>
                        <div className="text-xs uppercase tracking-wider text-gray-400 mb-1">Owner&apos;s note (the only report text Claude sees)</div>
                        <textarea
                          className="w-full border border-gray-300 rounded text-sm px-2 py-1 text-gray-700"
                          rows={3}
                          maxLength={4000}
                          value={notes[r.id] ?? r.owner_note ?? ''}
                          onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                          placeholder="Your own summary, in your words. Don't paste their text if you wouldn't hand it to Claude."
                        />
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-wider text-gray-400 mb-1 flex items-center gap-2">
                          <span>Reply to {r.callsign || 'the reporter'} (shown in their app)</span>
                          {r.resolution && (r.reply_seen_at
                            ? <Badge tone="green">Seen <Time ts={r.reply_seen_at} /></Badge>
                            : <Badge tone="amber">Not seen yet</Badge>)}
                        </div>
                        <textarea
                          className="w-full border border-gray-300 rounded text-sm px-2 py-1 text-gray-700"
                          rows={3}
                          maxLength={1000}
                          value={replies[r.id] ?? r.resolution ?? ''}
                          onChange={(e) => setReplies((n) => ({ ...n, [r.id]: e.target.value }))}
                          placeholder="Plain text. E.g. what fixed it, or which version fixes it. They see this under Settings → About & diagnostics."
                        />
                        <div className="text-xs text-gray-400">
                          {Array.from(replies[r.id] ?? r.resolution ?? '').length} / 1000 · deleted with the report
                          {r.resolved_at && <> · last sent <Time ts={r.resolved_at} /></>}
                        </div>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <RBtn small variant="success" disabled={!(replies[r.id] ?? '').trim() || replies[r.id] === r.resolution}
                          onClick={() => save(r, 'closed', true)}>Send reply &amp; close</RBtn>
                        <RBtn small disabled={!(replies[r.id] ?? '').trim() || replies[r.id] === r.resolution}
                          onClick={() => save(r, r.status, true)}>Send reply</RBtn>
                        <RBtn small onClick={() => save(r, r.status)}>Save note</RBtn>
                        <RBtn small onClick={() => save(r, 'triaged')}>Mark triaged</RBtn>
                        <RBtn small onClick={() => save(r, 'closed')}>Close</RBtn>
                        <RBtn small variant="danger" onClick={() => remove(r)}>Delete</RBtn>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </Table>
      </div>
      <Pagination page={page} limit={limit} total={total} onPage={setPage} />
    </div>
  );
}
