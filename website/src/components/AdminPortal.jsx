import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { API_BASE_URL } from '../api';
import { createAdminApi, adminTokenStore } from './admin/adminApi';
import {
  RBtn, StatCard, Table, Alert, Pagination, Modal, Field, TextInput, Badge, Time, can, SectionBoundary,
} from './admin/ui';
import UsersSection from './admin/UsersSection';
import OrgsSection from './admin/OrgsSection';
import HwidBansSection from './admin/HwidBansSection';
import AuditSection from './admin/AuditSection';
import AdminsSection from './admin/AdminsSection';
import TrafficSection from './admin/TrafficSection';
import PlansPricingSection from './admin/PlansPricingSection';
import AdminBillingSection from './billing/AdminBillingSection';

// Every request in this panel goes through admin/adminApi.js (its own client),
// and every permission it shows or hides is enforced again server-side in
// services/identity-node/src/routes/admin.ts — hiding a button here is UX only.

// ─── Section: Dashboard ───────────────────────────────────────────────────────

function SectionDashboard({ adminApi }) {
  const [data, setData]   = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    adminApi.overview().then(({ data, error }) => {
      if (error) setError(error);
      else setData(data);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) return <Alert>Could not load dashboard: {error} <button className="underline ml-2" onClick={load}>Retry</button></Alert>;
  if (!data) return <div className="text-gray-400 text-sm p-8 text-center">Loading dashboard...</div>;

  const s = data.stats || {};
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard label="Users"           value={s.users?.toLocaleString()}    />
        <StatCard label="Organizations"   value={s.orgs?.toLocaleString()}     />
        <StatCard label="Channels"        value={s.channels?.toLocaleString()} />
        <StatCard label="Banned"          value={s.banned?.toLocaleString()}   />
        <StatCard label="HWID Bans"       value={s.hwidBans?.toLocaleString()} />
        <StatCard label="Pending Reports" value={s.pendingReports?.toLocaleString()} sub={s.erased ? `${s.erased} erased accounts` : null} />
      </div>

      <div className="border border-gray-200 bg-white rounded-lg p-4 flex items-center gap-3 shadow-sm">
        <span className="w-2.5 h-2.5 rounded-full bg-green-500 flex-shrink-0" />
        <span className="text-sm font-medium text-gray-700">System Status: {data.status?.toUpperCase() ?? 'OPERATIONAL'}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {[['Recent Registrations', data.recentUsers, 'No recent registrations.'], ['Recent Organizations', data.recentOrgs, 'No recent organizations.']].map(([title, list, empty]) => (
          <div key={title} className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 text-xs uppercase tracking-wider text-gray-500 font-medium">{title}</div>
            <div className="divide-y divide-gray-100">
              {list?.length > 0
                ? list.map((x) => (
                  <div key={x.id ?? x.callsign} className="px-4 py-2 flex justify-between text-sm">
                    <span className="font-medium text-gray-800">{x.callsign ?? '—'}</span>
                    <span className="text-gray-400 text-xs"><Time ts={x.created_at} dateOnly /></span>
                  </div>
                ))
                : <div className="px-4 py-4 text-sm text-gray-400">{empty}</div>}
            </div>
          </div>
        ))}
      </div>

      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 text-xs uppercase tracking-wider text-gray-500 font-medium">Admin Accounts</div>
        <Table cols={['Username', 'Last Login']} empty="No admins.">
          {(data.admins || []).map((a) => (
            <tr key={a.username} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="px-4 py-3 font-semibold text-gray-800">{a.username}</td>
              <td className="px-4 py-3 text-gray-500 text-sm">{a.last_login ? <Time ts={a.last_login} /> : 'Never'}</td>
            </tr>
          ))}
        </Table>
      </div>
    </div>
  );
}

// ─── Section: Servers (Phase A of multi-tenant infra) ─────────────────────────

// Must match REGION_ALLOWLIST in services/identity-node/src/utils/doProvisioning.ts.
const PROVISION_REGIONS = ['nyc3', 'sfo3', 'ams3', 'fra1', 'sgp1'];
const PROVISION_TIMEOUT_MS = 10 * 60_000; // client-side backstop, matches the server-side timed_out window

function SectionServers({ adminApi, role }) {
  const [nodes, setNodes]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [region, setRegion]   = useState(PROVISION_REGIONS[0]);
  const [provisioning, setProvisioning] = useState(false);
  const [provisionErr, setProvisionErr] = useState(null);
  // { node_id, region, requested_at, status: 'provisioning'|'failed'|'timed_out' }
  const [pendingProvisions, setPendingProvisions] = useState([]);

  const loadNodes = () => {
    setLoading(true);
    setError(null);
    adminApi.listNodes().then(({ data, error }) => {
      setLoading(false);
      if (error) { setError(error); return; }
      setNodes(data.nodes || []);
    });
  };

  useEffect(() => { loadNodes(); }, []);

  // Only polls while something is actually pending — avoids needless requests
  // in the steady state once all provisions have resolved one way or another.
  useEffect(() => {
    if (pendingProvisions.length === 0) return;
    const poll = () => {
      loadNodes();
      adminApi.listProvisioning().then(({ data, error }) => {
        if (error || !data) return;
        const byNodeId = new Map((data.requests || []).map(r => [r.node_id, r]));
        setPendingProvisions(prev => prev
          .map(p => {
            const req = byNodeId.get(p.node_id);
            if (req && (req.status === 'failed' || req.status === 'timed_out')) return { ...p, status: req.status };
            return p;
          })
          // Drop entries once the node has actually registered (shows up in
          // the real node list) or the client-side timeout backstop fires.
          .filter(p => !nodes.some(n => n.node_id === p.node_id))
          .filter(p => p.status !== 'ready')
          .filter(p => Date.now() - p.requested_at < PROVISION_TIMEOUT_MS)
        );
      });
    };
    const interval = setInterval(poll, 10_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingProvisions.length]);

  // Reconcile immediately whenever a fresh node list arrives (don't wait for
  // the next 10s poll tick) — the node the admin just requested may already
  // have heartbeated in by the time this fires.
  useEffect(() => {
    if (pendingProvisions.length === 0) return;
    setPendingProvisions(prev => prev.filter(p => !nodes.some(n => n.node_id === p.node_id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes]);

  const handleProvision = async () => {
    if (!window.confirm(`This will create a new billable DigitalOcean droplet in ${region}. Continue?`)) return;
    setProvisioning(true);
    setProvisionErr(null);
    const { data, error } = await adminApi.provisionNode(region);
    setProvisioning(false);
    if (error) { setProvisionErr(error); return; }
    setPendingProvisions(prev => [...prev, {
      node_id: data.node_id, region: data.region, requested_at: Date.now(), status: 'provisioning',
    }]);
  };

  return (
    <div className="space-y-4">
      {provisionErr && <Alert onDismiss={() => setProvisionErr(null)}>{provisionErr}</Alert>}
      <div className="flex justify-between items-center flex-wrap gap-2">
        <span className="text-sm text-gray-600 font-medium">Media Node Capacity</span>
        <div className="flex items-center gap-2">
          {can(role, 'owner') && (
            <>
              <select
                className="bg-white border border-gray-300 rounded text-xs px-2 py-1.5"
                value={region}
                onChange={e => setRegion(e.target.value)}
              >
                {PROVISION_REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <RBtn small variant="success" disabled={provisioning} onClick={handleProvision}>
                {provisioning ? 'Provisioning…' : '+ Provision New Node'}
              </RBtn>
            </>
          )}
          <RBtn small onClick={loadNodes}>Refresh</RBtn>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Nodes" value={nodes.length} />
        <StatCard label="Online" value={nodes.filter(n => n.online).length} />
        <StatCard label="Voice Sessions" value={nodes.reduce((s, n) => s + (n.voice_sessions || 0), 0)} />
        <StatCard label="Video Viewers" value={nodes.reduce((s, n) => s + (n.video_viewers || 0), 0)} />
      </div>
      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <Table
          cols={['Node', 'Region', 'Status', 'Tenancy', 'Voice', 'Viewers', 'Sharers', 'Orgs', 'Last Heartbeat']}
          empty="No media nodes registered yet."
          loading={loading && nodes.length === 0}
          error={error}
        >
          {[
            ...pendingProvisions.map(p => (
              <tr key={`pending-${p.node_id}`} className="border-b border-gray-100 bg-amber-50">
                <td className="px-4 py-3 font-semibold text-gray-800">{p.node_id}</td>
                <td className="px-4 py-3 text-gray-500 text-sm">{p.region}</td>
                <td className="px-4 py-3" colSpan={7}>
                  <Badge tone={p.status === 'failed' || p.status === 'timed_out' ? 'red' : 'amber'}>
                    {p.status === 'failed' ? 'Failed' : p.status === 'timed_out' ? 'Timed out — check DO console' : 'Provisioning…'}
                  </Badge>
                </td>
              </tr>
            )),
            ...nodes.map(n => (
              <tr key={n.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-semibold text-gray-800">{n.node_id}</td>
                <td className="px-4 py-3 text-gray-500 text-sm">{n.region}</td>
                <td className="px-4 py-3"><Badge tone={n.online ? 'green' : 'red'}>{n.online ? 'Online' : 'Offline'}</Badge></td>
                <td className="px-4 py-3 text-gray-500 text-sm capitalize">{n.tenancy_mode}</td>
                <td className="px-4 py-3 text-gray-500 text-sm text-center">{n.voice_sessions ?? 0}</td>
                <td className="px-4 py-3 text-gray-500 text-sm text-center">{n.video_viewers ?? 0}</td>
                <td className="px-4 py-3 text-gray-500 text-sm text-center">{n.video_sharers ?? 0}</td>
                <td className="px-4 py-3 text-gray-500 text-sm text-center">{n.assigned_org_count ?? 0}</td>
                <td className="px-4 py-3 text-gray-400 text-sm"><Time ts={n.last_heartbeat_at} /></td>
              </tr>
            )),
          ]}
        </Table>
      </div>
    </div>
  );
}

// ─── Section: Voice Reports ───────────────────────────────────────────────────

// Decodes a report clip — see the matching encoder, frameReportClip in
// web-portal's CommLink.jsx. Both sides are this app's own code, so this
// framing has no external spec to match.
//
// Two formats exist:
//   - New (4B magic "SEV2" prefix): repeated [8B ts u64 LE][4B ssrc u32 LE]
//     [4B opus_len u32 LE][opus bytes] — ssrc lets a segment be attributed to
//     a real speaker (via the report's speaker_map) once the source channel
//     ran the E2E voice relay instead of server-side mixing.
//   - Legacy (no magic prefix — every report submitted before this existed):
//     repeated [8B ts u64 LE][4B opus_len u32 LE][opus bytes], one blended
//     stream, ssrc implicitly 0 throughout.
// The magic tag is checked first so old, already-stored reports stay
// decodable without a data migration.
const REPORT_CLIP_MAGIC = 0x53455632; // "SEV2" as a big-endian u32

async function decodeReportClip(arrayBuffer) {
  const { OpusDecoder } = await import('opus-decoder');
  const dec = new OpusDecoder();
  await dec.ready;

  const buf = new Uint8Array(arrayBuffer);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 0;
  const chunks = [];
  let sampleRate = 48000;

  const hasSsrc = buf.length >= 4 && view.getUint32(0, false) === REPORT_CLIP_MAGIC;
  if (hasSsrc) offset = 4;
  const headerLen = hasSsrc ? 16 : 12;

  while (offset + headerLen <= buf.length) {
    const tsLow = view.getUint32(offset, true);
    const tsHigh = view.getUint32(offset + 4, true);
    const ts = tsHigh * 4294967296 + tsLow;
    let ssrc = 0;
    let lenOffset = offset + 8;
    if (hasSsrc) {
      ssrc = view.getUint32(offset + 8, true);
      lenOffset = offset + 12;
    }
    const len = view.getUint32(lenOffset, true);
    offset = lenOffset + 4;
    if (len < 0 || offset + len > buf.length) break;
    const opusBytes = buf.subarray(offset, offset + len);
    offset += len;
    try {
      const { channelData, samplesDecoded, sampleRate: sr } = dec.decodeFrame(opusBytes);
      if (samplesDecoded) {
        chunks.push({ ts, ssrc, samples: channelData[0].slice(0, samplesDecoded) });
        if (sr) sampleRate = sr;
      }
    } catch {
      // One malformed frame shouldn't sink the whole clip — skip and keep going.
    }
  }
  if (dec.free) dec.free();

  const totalSamples = chunks.reduce((sum, c) => sum + c.samples.length, 0);
  const samples = new Float32Array(totalSamples);
  let o = 0;
  for (const c of chunks) { samples.set(c.samples, o); o += c.samples.length; }
  const speakerSsrcs = [...new Set(chunks.map(c => c.ssrc))];
  return { samples, sampleRate, firstTs: chunks[0]?.ts ?? null, speakerSsrcs };
}

const STATUS_STYLES = {
  pending:   'bg-yellow-50 border-yellow-300 text-yellow-700',
  reviewed:  'bg-blue-50 border-blue-300 text-blue-700',
  dismissed: 'bg-gray-100 border-gray-300 text-gray-500',
  actioned:  'bg-red-50 border-red-300 text-red-700',
};

const StatusPill = ({ status }) => (
  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_STYLES[status] || STATUS_STYLES.pending}`}>
    {status ?? 'pending'}
  </span>
);

function SectionVoiceReports({ adminApi }) {
  const [reports, setReports]         = useState([]);
  const [total, setTotal]             = useState(0);
  const [page, setPage]               = useState(1);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [actionErr, setActionErr]     = useState(null);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [msg, setMsg]                 = useState(null);
  const [expandedId, setExpandedId]   = useState(null);
  const [notesDraft, setNotesDraft]   = useState({});
  const [audioBusyId, setAudioBusyId] = useState(null);
  // report id -> array of user_ids attributed to segments of the clip last
  // played for that report (via speaker_map + the clip's own ssrcs). Only
  // populated on play, not on list-load, since it requires decoding the clip.
  const [clipSpeakers, setClipSpeakers] = useState({});
  const audioCtxRef = useRef(null);
  const limit = 50;

  const loadReports = () => {
    setLoading(true);
    setError(null);
    adminApi.listVoiceReports({ status: statusFilter === 'all' ? null : statusFilter, page, limit }).then(({ data, error }) => {
      setLoading(false);
      if (error) setError(error);
      else { setReports(data.reports || []); setTotal(data.total || 0); }
    });
  };

  useEffect(() => { loadReports(); }, [statusFilter, page]);
  useEffect(() => { setPage(1); }, [statusFilter]);

  const handleToggleExpand = (id, currentNotes) => {
    setExpandedId(expandedId === id ? null : id);
    setNotesDraft(prev => (prev[id] !== undefined ? prev : { ...prev, [id]: currentNotes || '' }));
  };

  const handleUpdateStatus = async (id, status) => {
    setActionErr(null);
    const { error } = await adminApi.updateVoiceReport(id, status, notesDraft[id] ?? null);
    if (error) { setActionErr(error); return; }
    setMsg(`Report marked ${status}.`);
    loadReports();
  };

  const handlePlayAudio = async (id) => {
    setAudioBusyId(id);
    setActionErr(null);
    try {
      const { data: raw, error } = await adminApi.voiceReportAudio(id);
      if (error) throw new Error(error);
      const { samples, sampleRate, speakerSsrcs } = await decodeReportClip(raw);
      if (samples.length === 0) throw new Error('Clip decoded to zero samples');

      // Resolve this clip's ssrcs to user_ids via the report's own speaker_map
      // (sent by the reporter's client — see submitVoiceReport in CommLink.jsx).
      // Empty for a clip from a still mixed-mode channel, where every frame is
      // ssrc=0 and there's nothing per-speaker to attribute.
      const report = reports.find(r => r.id === id);
      const speakerMap = report?.speaker_map || {};
      const speakerIds = [...new Set(
        (speakerSsrcs || [])
          .map(ssrc => speakerMap[String(ssrc)])
          .filter(Boolean)
      )];
      setClipSpeakers(prev => ({ ...prev, [id]: speakerIds }));

      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      const buffer = ctx.createBuffer(1, samples.length, sampleRate);
      buffer.getChannelData(0).set(samples);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
    } catch (err) {
      setActionErr(err?.message || String(err));
    } finally {
      setAudioBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      {msg && <Alert type="success" onDismiss={() => setMsg(null)}>{msg}</Alert>}
      {actionErr && <Alert onDismiss={() => setActionErr(null)}>{actionErr}</Alert>}
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600 font-medium">Voice Misconduct Reports</span>
          <select
            className="bg-white border border-gray-300 rounded text-sm px-2 py-1 text-gray-700"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
          >
            <option value="pending">Pending</option>
            <option value="reviewed">Reviewed</option>
            <option value="dismissed">Dismissed</option>
            <option value="actioned">Actioned</option>
            <option value="all">All</option>
          </select>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">{total.toLocaleString()} reports</span>
          <RBtn small onClick={loadReports}>Refresh</RBtn>
        </div>
      </div>
      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <Table cols={['Reporter', 'Accused', 'Reported', 'Status', '']} empty="No voice reports match." loading={loading} error={error}>
          {reports.map((r) => (
            <React.Fragment key={r.id}>
              <tr className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-700 text-sm">{r.reporter_callsign || '—'}</td>
                <td className="px-4 py-3 text-gray-700 text-sm">{r.accused_callsign || '—'}</td>
                <td className="px-4 py-3 text-gray-400 text-sm"><Time ts={r.reported_at} /></td>
                <td className="px-4 py-3"><StatusPill status={r.status} /></td>
                <td className="px-4 py-3 text-right">
                  <RBtn small onClick={() => handleToggleExpand(r.id, r.admin_notes)}>
                    {expandedId === r.id ? 'Hide' : 'Review'}
                  </RBtn>
                </td>
              </tr>
              {expandedId === r.id && (
                <tr className="border-b border-gray-100 bg-gray-50">
                  <td colSpan={5} className="px-4 py-4">
                    <div className="space-y-3">
                      {r.reporter_note && (
                        <div>
                          <div className="text-xs uppercase tracking-wider text-gray-400 mb-1">Reporter Note</div>
                          <div className="text-sm text-gray-700 whitespace-pre-wrap">{r.reporter_note}</div>
                        </div>
                      )}
                      <div>
                        <div className="text-xs uppercase tracking-wider text-gray-400 mb-1">Speaking Activity (window)</div>
                        {(Array.isArray(r.speaking_history) ? r.speaking_history : []).length === 0
                          ? <div className="text-sm text-gray-400">No speaking-activity data attached.</div>
                          : (
                            <div className="flex flex-wrap gap-1">
                              {[...new Set(r.speaking_history.map(e => e?.callsign).filter(Boolean))].map(cs => (
                                <span key={cs} className="px-2 py-0.5 rounded bg-gray-200 text-gray-600 text-xs">{cs}</span>
                              ))}
                            </div>
                          )}
                      </div>
                      <div className="flex items-center gap-2">
                        <RBtn small onClick={() => handlePlayAudio(r.id)} disabled={audioBusyId === r.id}>
                          {audioBusyId === r.id ? 'Loading…' : '▶ Play Clip'}
                        </RBtn>
                        <span className="text-xs text-gray-400">Decrypted server-side on request (access is audited); never stored in the browser.</span>
                      </div>
                      {clipSpeakers[r.id] !== undefined && (
                        <div>
                          <div className="text-xs uppercase tracking-wider text-gray-400 mb-1">Clip Attribution</div>
                          {clipSpeakers[r.id].length === 0
                            ? <div className="text-sm text-gray-400">No per-speaker attribution available for this clip (blended/mixed-mode audio, or no relay-mode speakers recognized).</div>
                            : (
                              <div className="flex flex-wrap gap-1">
                                {clipSpeakers[r.id].map(uid => {
                                  // Best-effort label: the only two callsigns this list
                                  // response carries are the reporter's and accused's —
                                  // any other attributed speaker shows as a raw user_id
                                  // (cross-reference via the Users section if needed).
                                  const label =
                                    uid === r.reporter_id ? `${r.reporter_callsign || uid} (reporter)`
                                    : uid === r.accused_id ? `${r.accused_callsign || uid} (accused)`
                                    : uid;
                                  return (
                                    <span key={uid} className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-xs">{label}</span>
                                  );
                                })}
                              </div>
                            )}
                        </div>
                      )}
                      <div>
                        <div className="text-xs uppercase tracking-wider text-gray-400 mb-1">Admin Notes</div>
                        <textarea
                          className="w-full border border-gray-300 rounded text-sm px-2 py-1 text-gray-700"
                          rows={2}
                          maxLength={4000}
                          value={notesDraft[r.id] ?? ''}
                          onChange={e => setNotesDraft(prev => ({ ...prev, [r.id]: e.target.value }))}
                        />
                      </div>
                      <div className="flex gap-2">
                        <RBtn small variant="default" onClick={() => handleUpdateStatus(r.id, 'reviewed')}>Mark Reviewed</RBtn>
                        <RBtn small variant="default" onClick={() => handleUpdateStatus(r.id, 'dismissed')}>Dismiss</RBtn>
                        <RBtn small variant="danger" onClick={() => handleUpdateStatus(r.id, 'actioned')}>Mark Actioned</RBtn>
                      </div>
                    </div>
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

// ─── Section: System ──────────────────────────────────────────────────────────

function SectionSystem({ onLogout, session }) {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    window.fetch(`${API_BASE_URL}/health`)
      .then(r => r.json())
      .then(d => setHealth(d))
      .catch(() => setHealth({ status: 'unreachable' }));
  }, []);

  const isOk = health?.status === 'ok';

  return (
    <div className="space-y-6">
      <div className="border border-gray-200 bg-white rounded-lg shadow-sm p-6 space-y-4">
        <div className="text-sm font-semibold text-gray-700 border-b border-gray-200 pb-3">Node Health</div>
        <div className="flex items-center gap-3">
          <span className={`w-3 h-3 rounded-full flex-shrink-0 ${isOk ? 'bg-green-500' : 'bg-red-400'}`} />
          <span className="text-sm text-gray-700">
            Identity Service: <span className={`font-semibold ${isOk ? 'text-green-600' : 'text-red-600'}`}>{health?.status?.toUpperCase() ?? 'Checking...'}</span>
          </span>
          {health?.timestamp && (
            <span className="text-gray-400 text-xs ml-auto"><Time ts={health.timestamp} /></span>
          )}
        </div>
      </div>

      <div className="border border-gray-200 bg-white rounded-lg shadow-sm p-6 space-y-2 text-sm text-gray-600">
        <div className="text-sm font-semibold text-gray-700 border-b border-gray-200 pb-3">Session</div>
        <div>Signed out automatically after <strong>{session?.idle_timeout_minutes ?? 30} minutes</strong> of inactivity (enforced by the server).</div>
        <div>Destructive owner actions ask for your password again if it was last entered more than {session?.reauth_window_minutes ?? 5} minutes ago.</div>
      </div>

      <div className="border border-red-200 bg-red-50 rounded-lg p-6 space-y-4">
        <div className="text-sm font-semibold text-red-700 border-b border-red-200 pb-3">Danger Zone</div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-gray-800">End Admin Session</div>
            <div className="text-xs text-gray-500 mt-0.5">Revokes this session on the server and returns to the login screen.</div>
          </div>
          <RBtn variant="danger" onClick={onLogout}>Logout</RBtn>
        </div>
      </div>
    </div>
  );
}

// ─── Re-auth prompt ───────────────────────────────────────────────────────────

function ReauthModal({ adminApi, onResult }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const { error } = await adminApi.reauth(password);
    setBusy(false);
    if (error) { setErr(error); return; }
    onResult(true);
  };

  return (
    <Modal title="Confirm it's you" onClose={() => onResult(false)}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-600">This action is sensitive. Re-enter your admin password to continue.</p>
        <Field label="Password">
          <TextInput type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {err && <Alert>{err}</Alert>}
        <div className="flex justify-end gap-2">
          <RBtn variant="ghost" onClick={() => onResult(false)}>Cancel</RBtn>
          <RBtn type="submit" variant="danger" disabled={busy || !password}>{busy ? 'Checking…' : 'Confirm'}</RBtn>
        </div>
      </form>
    </Modal>
  );
}

// ─── Sidebar Nav ──────────────────────────────────────────────────────────────

const NAV = [
  { id: 'dashboard',    label: 'Dashboard',     role: 'viewer'   },
  { id: 'traffic',      label: 'Traffic',       role: 'viewer'   },
  { id: 'users',        label: 'Users',         role: 'viewer'   },
  { id: 'orgs',         label: 'Organizations', role: 'viewer'   },
  { id: 'hwid',         label: 'HWID Bans',     role: 'viewer'   },
  { id: 'billing',      label: 'Billing',       role: 'viewer'   },
  { id: 'plans',        label: 'Plans & Pricing', role: 'operator' },
  { id: 'voiceReports', label: 'Voice Reports', role: 'operator' },
  { id: 'servers',      label: 'Servers',       role: 'viewer'   },
  { id: 'audit',        label: 'Audit Log',     role: 'operator' },
  { id: 'admins',       label: 'Admins',        role: 'owner'    },
  { id: 'system',       label: 'System',        role: 'viewer'   },
];

// Client-side mirror of the server idle timeout so an unattended screen
// clears itself; the server enforces the real limit regardless.
const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'scroll', 'touchstart'];

// ─── Admin Portal Root ────────────────────────────────────────────────────────

const AdminPortal = ({ onExit }) => {
  const [hasToken, setHasToken]           = useState(() => !!adminTokenStore.get());
  const [adminUser, setAdminUser]         = useState(null);
  const [session, setSession]             = useState(null);
  const [loginForm, setLoginForm]         = useState({ username: '', password: '' });
  const [loginErr, setLoginErr]           = useState(null);
  const [loginBusy, setLoginBusy]         = useState(false);
  const [activeSection, setActiveSection] = useState('dashboard');
  const [reauthPrompt, setReauthPrompt]   = useState(null); // resolver fn while open
  const lastActivity = useRef(Date.now());

  const endSession = useCallback((message) => {
    adminTokenStore.clear();
    setHasToken(false);
    setAdminUser(null);
    setSession(null);
    setReauthPrompt(null);
    if (message) setLoginErr(message);
  }, []);

  const adminApi = useMemo(() => createAdminApi({
    onSessionExpired: (message) => endSession(message),
    requestReauth: () => new Promise((resolve) => setReauthPrompt(() => resolve)),
  }), [endSession]);

  // Purge any token an older build left in localStorage.
  useEffect(() => {
    try { localStorage.removeItem('specter_admin_token'); } catch { /* ignore */ }
  }, []);

  // Resolve who we are (and validate a token restored from sessionStorage).
  const [meError, setMeError] = useState(null);
  const loadMe = useCallback(() => {
    setMeError(null);
    adminApi.me().then(({ data, error, status }) => {
      if (data) { setAdminUser(data.admin); setSession(data.session); }
      else if (status !== 401) setMeError(error || 'Could not load your admin session.');
    });
  }, [adminApi]);
  useEffect(() => {
    if (hasToken) loadMe();
  }, [hasToken, loadMe]);

  // Idle auto-logout.
  useEffect(() => {
    if (!hasToken) return;
    const bump = () => { lastActivity.current = Date.now(); };
    ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, bump, { passive: true }));
    const timer = setInterval(() => {
      const idleMs = (session?.idle_timeout_minutes ?? 30) * 60_000;
      if (Date.now() - lastActivity.current > idleMs) {
        adminApi.logout().finally(() => endSession('Signed out after inactivity.'));
      }
    }, 30_000);
    return () => {
      ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, bump));
      clearInterval(timer);
    };
  }, [hasToken, session, adminApi, endSession]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginErr(null);
    setLoginBusy(true);
    const { data, error } = await adminApi.login(loginForm.username, loginForm.password);
    setLoginBusy(false);
    if (error) return setLoginErr(error);
    adminTokenStore.set(data.token);
    lastActivity.current = Date.now();
    setLoginForm({ username: '', password: '' });
    setAdminUser(data.admin);
    setSession(data.session);
    setHasToken(true);
    setActiveSection('dashboard');
  };

  const handleLogout = async () => {
    await adminApi.logout();
    endSession(null);
  };

  const resolveReauth = (ok) => {
    const resolve = reauthPrompt;
    setReauthPrompt(null);
    resolve?.(ok);
  };

  if (!hasToken) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="bg-white border border-gray-200 rounded-xl shadow-lg p-8 w-full max-w-sm space-y-6">
          <div className="text-center border-b border-gray-200 pb-5">
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Specter Admin</h1>
            <p className="text-sm text-gray-400 mt-1">Restricted access — authorized personnel only</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="text-xs text-gray-500 font-medium uppercase tracking-wider block mb-1">Username or Email</label>
              <input
                className="w-full bg-white border border-gray-300 rounded focus:border-gray-500 focus:outline-none p-2.5 text-gray-800 text-sm"
                value={loginForm.username}
                onChange={e => setLoginForm(f => ({ ...f, username: e.target.value }))}
                autoComplete="username"
                maxLength={255}
                required
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 font-medium uppercase tracking-wider block mb-1">Password</label>
              <input
                type="password"
                className="w-full bg-white border border-gray-300 rounded focus:border-gray-500 focus:outline-none p-2.5 text-gray-800 text-sm"
                value={loginForm.password}
                onChange={e => setLoginForm(f => ({ ...f, password: e.target.value }))}
                autoComplete="current-password"
                required
              />
            </div>
            {loginErr && <Alert>{loginErr}</Alert>}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onExit}
                className="flex-1 py-2 border border-gray-300 rounded text-gray-600 hover:bg-gray-50 text-sm font-medium transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={loginBusy}
                className="flex-1 bg-gray-900 text-white rounded py-2 hover:bg-gray-700 text-sm font-medium transition-colors disabled:opacity-50">
                {loginBusy ? 'Signing in…' : 'Sign In'}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  const role = adminUser?.role;
  const nav = NAV.filter((n) => can(role, n.role));
  const section = nav.some((n) => n.id === activeSection) ? activeSection : 'dashboard';
  const props = { adminApi, role };

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col font-sans">
      <header className="bg-white border-b border-gray-200 px-4 sm:px-6 py-3 flex items-center justify-between shadow-sm flex-shrink-0 gap-2">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <span className="font-bold text-gray-900 tracking-tight truncate">Specter Admin</span>
          <span className="hidden sm:inline text-xs bg-gray-100 text-gray-500 border border-gray-200 px-2 py-0.5 rounded font-mono">OMNI-PANEL</span>
        </div>
        <div className="flex gap-3 sm:gap-4 items-center flex-shrink-0">
          {adminUser && (
            <span className="hidden sm:inline text-sm text-gray-500">
              {adminUser.username} <Badge tone={role === 'owner' ? 'red' : role === 'operator' ? 'amber' : 'gray'}>{role}</Badge>
            </span>
          )}
          <button onClick={onExit}       className="text-sm text-gray-500 hover:text-gray-800 transition-colors">Exit</button>
          <button onClick={handleLogout} className="text-sm text-red-600 hover:text-red-800 font-medium transition-colors">Logout</button>
        </div>
      </header>

      {/* Below md: nav becomes a horizontally-scrollable tab bar on top instead of
          a fixed-width side rail, since a 208px sidebar eats most of a phone's width. */}
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden md:h-[calc(100vh-53px)]">
        <nav className="w-full md:w-52 bg-white border-b md:border-b-0 md:border-r border-gray-200 flex-shrink-0 flex flex-row md:flex-col gap-0.5 overflow-x-auto md:overflow-y-auto shadow-sm py-1 md:py-4">
          {nav.map(n => (
            <button
              key={n.id}
              onClick={() => setActiveSection(n.id)}
              className={`flex-shrink-0 md:w-full text-left px-4 md:px-5 py-2.5 text-sm font-medium whitespace-nowrap transition-colors rounded-none border-l-2 md:border-l-2 border-b-2 md:border-b-0 ${
                section === n.id
                  ? 'bg-gray-100 text-gray-900 border-gray-900'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800 border-transparent'
              }`}
            >
              {n.label}
            </button>
          ))}
        </nav>

        <main className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">
          {!adminUser ? (
            meError
              ? <Alert>{meError} <button className="underline ml-2" onClick={loadMe}>Retry</button></Alert>
              : <div className="text-gray-400 text-sm p-8 text-center">Loading session…</div>
          ) : (
            <SectionBoundary key={section}>
              {section === 'dashboard'    && <SectionDashboard {...props} />}
              {section === 'traffic'      && <TrafficSection {...props} />}
              {section === 'users'        && <UsersSection {...props} />}
              {section === 'orgs'         && <OrgsSection {...props} />}
              {section === 'hwid'         && <HwidBansSection {...props} />}
              {section === 'billing'      && <AdminBillingSection {...props} />}
              {section === 'plans'        && <PlansPricingSection {...props} />}
              {section === 'voiceReports' && <SectionVoiceReports {...props} />}
              {section === 'servers'      && <SectionServers {...props} />}
              {section === 'audit'        && <AuditSection {...props} />}
              {section === 'admins'       && <AdminsSection {...props} self={adminUser} />}
              {section === 'system'       && <SectionSystem onLogout={handleLogout} session={session} />}
            </SectionBoundary>
          )}
        </main>
      </div>

      {reauthPrompt && <ReauthModal adminApi={adminApi} onResult={resolveReauth} />}
    </div>
  );
};

export default AdminPortal;
