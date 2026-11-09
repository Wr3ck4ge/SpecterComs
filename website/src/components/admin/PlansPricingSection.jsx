import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { RBtn, Table, Alert, Modal, Field, TextInput, Badge, Time, can } from './ui';
import {
  POLICY_FIELDS, configToForm, formToConfig, mapServerErrors, diffConfigs, nextTierId, usd, dollarsToCents,
} from './billingFormat';

// Plans & Pricing: the versioned billing config (tiers + policy).
//
// UI contract (served by the billing workstream under /admin/billing/config):
//   GET  /admin/billing/config  -> { active: { version|null, config, createdAt|null, createdBy|null, reason|null },
//                                    source: 'db'|'env'|'default', defaults, history: [{ version, createdAt, createdBy, reason }] }
//   GET  /admin/billing/config/versions/:version -> { version, config, createdAt, createdBy, reason }
//   PUT  /admin/billing/config  { config, reason, expectedVersion }
//        -> 200 { version } | 400 { error, details: [{ path, message }] }
//        |  409 { error: 'version_conflict', currentVersion } | 409 { error: 'tier_in_use', tierId, orgCount }
// The editor is shown read-only to anyone below owner; a 403 from the server
// on save is treated as authoritative and switches the editor to read-only.
// Reads need operator, PUT needs owner and is rate-limited (429). PUT always
// sends the FULL config (unknown/extra fields from GET are carried through).

export const PRICE_CHANGE_NOTE =
  'Price changes apply to each server from the start of its next billing cycle; current cycles keep their locked price.';
export const LIMIT_CHANGE_NOTE = 'Limits (bitrate, resolution, data cap) apply the next time a member joins voice.';

const inputCls = (bad) => `w-full bg-white border rounded px-2 py-1 text-sm text-gray-800 focus:outline-none disabled:bg-gray-50 ${bad ? 'border-red-400' : 'border-gray-300 focus:border-gray-500'}`;

function Cell({ err, children }) {
  return (
    <td className="px-2 py-2 align-top">
      {children}
      {err && <div className="text-xs text-red-600 mt-0.5">{err}</div>}
    </td>
  );
}

function SaveModal({ diff, onClose, onSave }) {
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const hasPrice = diff.some((d) => d.kind === 'price' || d.kind === 'added' || d.kind === 'removed');
  const hasLimit = diff.some((d) => d.kind === 'limit' || d.kind === 'added');
  const save = async () => { setBusy(true); await onSave(reason.trim()); setBusy(false); };
  return (
    <Modal title="Review billing config change" onClose={onClose} wide>
      {diff.length === 0 ? <Alert type="warn">Nothing changed compared with the active version.</Alert> : (
        <Table cols={['Field', 'Current', 'New']}>
          {diff.map((d) => (
            <tr key={d.label} className="border-b border-gray-100">
              <td className="px-4 py-2 text-sm text-gray-700">{d.label}</td>
              <td className="px-4 py-2 text-sm text-gray-500 line-through decoration-gray-300">{d.from}</td>
              <td className={`px-4 py-2 text-sm font-medium ${d.kind === 'removed' ? 'text-red-700' : 'text-gray-900'}`}>{d.to}</td>
            </tr>
          ))}
        </Table>
      )}
      <div className="text-sm bg-amber-50 border border-amber-200 rounded p-3 text-amber-900 space-y-1">
        <p><b>{PRICE_CHANGE_NOTE}</b></p>
        <p>{LIMIT_CHANGE_NOTE}</p>
        {hasPrice && <p>This change touches prices.</p>}
        {hasLimit && !hasPrice && <p>This change touches limits only.</p>}
      </div>
      <Field label="Reason (required, stored with the version)">
        <TextInput value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <label className="flex items-start gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
        <span>I have checked the changes above and want to publish them as a new version.</span>
      </label>
      <div className="flex justify-end gap-2">
        <RBtn variant="ghost" onClick={onClose}>Cancel</RBtn>
        <RBtn variant="danger" disabled={busy || !reason.trim() || !ack || diff.length === 0} onClick={save}>
          {busy ? 'Saving…' : 'Save new version'}
        </RBtn>
      </div>
    </Modal>
  );
}

function VersionModal({ v, onClose, onRestore, canRestore }) {
  return (
    <Modal title={`Version ${v.version}`} onClose={onClose} wide>
      <div className="text-sm text-gray-600">
        <Time ts={v.createdAt} /> · {v.createdBy || 'unknown'}{v.reason ? ` · "${v.reason}"` : ''}
      </div>
      <pre className="text-xs bg-gray-50 border border-gray-200 rounded p-2 overflow-auto max-h-96">{JSON.stringify(v.config, null, 2)}</pre>
      <div className="flex justify-end gap-2">
        <RBtn variant="ghost" onClick={onClose}>Close</RBtn>
        {canRestore && <RBtn onClick={() => onRestore(v)}>Load into editor</RBtn>}
      </div>
    </Modal>
  );
}

export default function PlansPricingSection({ adminApi, role }) {
  const [data, setData] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null); // { type, text, action? }
  const [review, setReview] = useState(null); // { config, diff }
  const [viewing, setViewing] = useState(null);
  const [forcedReadOnly, setForcedReadOnly] = useState(false);
  const [restoredFrom, setRestoredFrom] = useState(null);

  const editable = can(role, 'owner') && !forcedReadOnly;

  const load = useCallback(() => {
    setLoadErr(null);
    adminApi.billingConfig().then(({ data, error, status, body }) => {
      if (error) { setLoadErr(status === 403 ? 'Your admin role cannot view the billing config.' : (body?.error || error)); return; }
      setData(data);
      setForm(configToForm(data.active?.config));
      setErrors({});
      setRestoredFrom(null);
    });
  }, [adminApi]);
  useEffect(() => { load(); }, [load]);

  const baseline = data?.active?.config;
  const dirty = useMemo(() => {
    if (!form || !baseline) return false;
    return diffConfigs(baseline, formToConfig(form).config).length > 0;
  }, [form, baseline]);

  if (loadErr) return <Alert>Could not load plans &amp; pricing: {loadErr} <button className="underline ml-2" onClick={load}>Retry</button></Alert>;
  if (!data || !form) return <div className="text-gray-400 text-sm p-8 text-center">Loading plans &amp; pricing…</div>;

  const setTier = (i, patch) => setForm((f) => ({ ...f, tiers: f.tiers.map((t, n) => (n === i ? { ...t, ...patch } : t)) }));
  const setPolicy = (k, v) => setForm((f) => ({ ...f, policy: { ...f.policy, [k]: v } }));
  const addTier = () => setForm((f) => ({
    ...f,
    tiers: [...f.tiers, { id: nextTierId(f), name: '', priceUsd: '0.00', dataGb: '0', bitrate: '1280', resolution: '720p', overageOn: false, overage: '', selectable: true }],
  }));
  const removeTier = (i) => setForm((f) => ({ ...f, tiers: f.tiers.filter((_, n) => n !== i) }));
  const e = (path) => errors[path];

  const startReview = () => {
    const { config, errors: errs } = formToConfig(form);
    setErrors(errs);
    if (Object.keys(errs).length) { setBanner({ type: 'error', text: 'Fix the highlighted fields first.' }); return; }
    setBanner(null);
    setReview({ config, diff: diffConfigs(baseline, config) });
  };

  const save = async (reason) => {
    const { data: out, error, status, body } = await adminApi.saveBillingConfig({
      config: review.config, reason, expectedVersion: data.active?.version ?? null,
    });
    if (!error) {
      setReview(null);
      setBanner({ type: 'success', text: `Saved as version ${out?.version ?? '?'}. ${PRICE_CHANGE_NOTE}` });
      load();
      return;
    }
    setReview(null);
    if (status === 403 && body?.code === 'REAUTH_REQUIRED') {
      // Password prompt was cancelled or failed: keep the editor (and edits).
      setBanner({ type: 'warn', text: 'Password confirmation is required to save prices. Nothing was saved.' });
    } else if (status === 403) {
      setForcedReadOnly(true);
      setBanner({ type: 'error', text: body?.message || body?.error || 'Your admin role cannot change the billing config.' });
    } else if (status === 429) {
      setBanner({ type: 'warn', text: 'Too many config saves in a short time (rate limit). Nothing was saved; try again in a few minutes.' });
    } else if (status === 409 && body?.error === 'version_conflict') {
      setBanner({ type: 'warn', text: `Someone else saved version ${body.currentVersion} while you were editing. Reload to see it (your edits here will be discarded).`, action: 'reload' });
    } else if (status === 409 && body?.error === 'tier_in_use') {
      setBanner({ type: 'error', text: `Plan ${body.tierId} is used by ${body.orgCount} server(s), so it cannot be removed. Move those servers to another plan first, or keep the plan and untick "selectable" to hide it.` });
    } else if (status === 400 && Array.isArray(body?.details)) {
      setErrors(mapServerErrors(body.details));
      setBanner({ type: 'error', text: `The server rejected the config: ${body.error || 'validation failed'}. See the highlighted fields.` });
    } else {
      setBanner({ type: 'error', text: body?.error || error });
    }
  };

  const restore = async (v) => {
    const full = v.config ? { data: v } : await adminApi.billingConfigVersion(v.version);
    if (full.error) { setBanner({ type: 'error', text: full.body?.error || full.error }); return; }
    setForm(configToForm(full.data.config));
    setErrors({});
    setViewing(null);
    setRestoredFrom(full.data.version);
    setBanner({ type: 'warn', text: `Version ${full.data.version} loaded into the editor. Nothing is saved until you review and save it with a reason.` });
  };

  const view = async (v) => {
    const { data: full, error, body } = await adminApi.billingConfigVersion(v.version);
    if (error) { setBanner({ type: 'error', text: body?.error || error }); return; }
    setViewing(full);
  };

  const tierIds = form.tiers.map((t) => t.id);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-gray-600 font-medium">Plans &amp; Pricing</span>
        <Badge tone={data.source === 'db' ? 'green' : 'amber'}>source: {data.source}</Badge>
        {data.active?.version != null && <span className="text-xs text-gray-500">active version {data.active.version} · <Time ts={data.active.createdAt} /> · {data.active.createdBy || '—'}</span>}
        {!editable && <Badge>read-only</Badge>}
        {restoredFrom != null && <Badge tone="blue">editing a copy of v{restoredFrom}</Badge>}
        <div className="ml-auto flex gap-2">
          {editable && data.defaults && <RBtn small onClick={() => { setForm(configToForm(data.defaults)); setErrors({}); }}>Load defaults</RBtn>}
          {editable && dirty && <RBtn small onClick={() => { setForm(configToForm(baseline)); setErrors({}); setRestoredFrom(null); }}>Discard edits</RBtn>}
          <RBtn small onClick={load}>Reload</RBtn>
        </div>
      </div>

      {data.source !== 'db' && (
        <Alert type="warn">
          The active config comes from {data.source === 'env' ? 'environment variables (BILLING_CONFIG_JSON / BILLING_* env)' : 'the built-in defaults'}.
          Saving here creates the first database version, and from then on the database version overrides the environment.
        </Alert>
      )}
      {banner && (
        <Alert type={banner.type} onDismiss={() => setBanner(null)}>
          {banner.text}
          {banner.action === 'reload' && <button className="underline ml-2" onClick={() => { setBanner(null); load(); }}>Reload now</button>}
        </Alert>
      )}
      {e('tiers') && <Alert>{e('tiers')}</Alert>}
      {e('_') && <Alert>{e('_')}</Alert>}

      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-x-auto">
        <table className="w-full text-left text-sm min-w-[980px]">
          <thead>
            <tr className="border-b border-gray-200 text-gray-500 text-xs uppercase tracking-wider">
              <th className="px-2 py-3 w-12">Id</th><th className="px-2 py-3">Name</th><th className="px-2 py-3">Price / cycle (USD)</th>
              <th className="px-2 py-3">Data / cycle (GB)</th><th className="px-2 py-3">Video bitrate (kbps)</th><th className="px-2 py-3">Resolution label</th>
              <th className="px-2 py-3">Overage</th><th className="px-2 py-3">Selectable</th><th className="px-2 py-3" />
            </tr>
          </thead>
          <tbody>
            {form.tiers.map((t, i) => {
              const p = `tiers.${i}`;
              const cents = dollarsToCents(t.priceUsd);
              return (
                <tr key={`${t.id}-${i}`} className="border-b border-gray-100">
                  <Cell err={e(`${p}.id`)}><span className="font-mono text-gray-600">{t.id}</span></Cell>
                  <Cell err={e(`${p}.name`)}><input className={inputCls(e(`${p}.name`))} disabled={!editable} value={t.name} maxLength={60} onChange={(ev) => setTier(i, { name: ev.target.value })} /></Cell>
                  <Cell err={e(`${p}.priceCents`)}>
                    <input className={inputCls(e(`${p}.priceCents`))} disabled={!editable} value={t.priceUsd} inputMode="decimal" onChange={(ev) => setTier(i, { priceUsd: ev.target.value })} />
                    {cents !== null && <div className="text-xs text-gray-400">{cents}¢</div>}
                  </Cell>
                  <Cell err={e(`${p}.cycleDataLimitBytes`)}><input className={inputCls(e(`${p}.cycleDataLimitBytes`))} disabled={!editable} value={t.dataGb} inputMode="decimal" onChange={(ev) => setTier(i, { dataGb: ev.target.value })} /></Cell>
                  <Cell err={e(`${p}.maxVideoBitrateKbps`)}><input className={inputCls(e(`${p}.maxVideoBitrateKbps`))} disabled={!editable} value={t.bitrate} inputMode="numeric" onChange={(ev) => setTier(i, { bitrate: ev.target.value })} /></Cell>
                  <Cell err={e(`${p}.maxResolutionLabel`)}><input className={inputCls(e(`${p}.maxResolutionLabel`))} disabled={!editable} value={t.resolution} maxLength={20} onChange={(ev) => setTier(i, { resolution: ev.target.value })} /></Cell>
                  <Cell err={e(`${p}.overageCentsPerGb`)}>
                    <select className={inputCls(false)} disabled={!editable} value={t.overageOn ? 'bill' : 'off'} onChange={(ev) => setTier(i, { overageOn: ev.target.value === 'bill' })}>
                      <option value="off">Off (throttle at cap)</option>
                      <option value="bill">Bill ¢/GB</option>
                    </select>
                    {t.overageOn && <input className={`${inputCls(e(`${p}.overageCentsPerGb`))} mt-1`} disabled={!editable} value={t.overage} placeholder="¢ per GB" inputMode="decimal" onChange={(ev) => setTier(i, { overage: ev.target.value })} />}
                  </Cell>
                  <Cell err={e(`${p}.selectable`)}><input type="checkbox" disabled={!editable} checked={t.selectable} onChange={(ev) => setTier(i, { selectable: ev.target.checked })} title="Unticked: hidden from owners (existing servers keep it)" /></Cell>
                  <Cell>{editable && t.id !== 0 && <RBtn small variant="danger" onClick={() => removeTier(i)}>Remove</RBtn>}</Cell>
                </tr>
              );
            })}
          </tbody>
        </table>
        {editable && <div className="p-2 border-t border-gray-100"><RBtn small onClick={addTier}>+ Add plan (id {nextTierId(form)})</RBtn></div>}
      </div>
      <p className="text-xs text-gray-500">Prices are per billing cycle (one calendar month from each server's cycle start). GB means 10⁹ bytes. Plan 0 is the default for new servers and cannot be removed. Removing a plan that servers still use is refused by the server.</p>

      <div className="border border-gray-200 bg-white rounded-lg shadow-sm p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        {POLICY_FIELDS.map((f) => (
          <div key={f.key}>
            <label className="text-xs text-gray-500 uppercase tracking-wider block mb-1">
              {f.label}{f.kind === 'usd' ? ' (USD)' : f.unit ? ` (${f.unit})` : ''}
            </label>
            {f.kind === 'enum' ? (
              <select className={inputCls(e(f.key))} disabled={!editable} value={form.policy[f.key]} onChange={(ev) => setPolicy(f.key, ev.target.value)}>
                {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.kind === 'tier' ? (
              <select className={inputCls(e(f.key))} disabled={!editable} value={form.policy[f.key]} onChange={(ev) => setPolicy(f.key, ev.target.value)}>
                {!tierIds.map(String).includes(String(form.policy[f.key])) && <option value={form.policy[f.key]}>— pick a plan —</option>}
                {form.tiers.map((t) => <option key={t.id} value={String(t.id)}>{t.id} · {t.name || 'unnamed'}</option>)}
              </select>
            ) : f.kind === 'bool' ? (
              <input type="checkbox" disabled={!editable} checked={!!form.policy[f.key]} onChange={(ev) => setPolicy(f.key, ev.target.checked)} />
            ) : (
              <input className={inputCls(e(f.key))} disabled={!editable} value={form.policy[f.key]} inputMode="decimal" onChange={(ev) => setPolicy(f.key, ev.target.value)} />
            )}
            {f.kind === 'usd' && dollarsToCents(form.policy[f.key]) !== null && <span className="text-xs text-gray-400"> = {usd(dollarsToCents(form.policy[f.key]))}</span>}
            {e(f.key) && <div className="text-xs text-red-600 mt-0.5">{e(f.key)}</div>}
            <div className="text-xs text-gray-400 mt-0.5">{f.help}</div>
          </div>
        ))}
      </div>

      {editable && (
        <div className="flex items-center gap-3">
          <RBtn variant="danger" disabled={!dirty} onClick={startReview}>Review &amp; save…</RBtn>
          <span className="text-xs text-gray-500">{dirty ? PRICE_CHANGE_NOTE : 'No unsaved changes.'}</span>
        </div>
      )}

      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 text-xs uppercase tracking-wider text-gray-500 font-medium">Version history</div>
        <Table cols={['Version', 'Saved', 'By', 'Reason', '']} empty="No saved versions yet.">
          {(data.history || []).map((v) => (
            <tr key={v.version} className="border-b border-gray-100">
              <td className="px-4 py-2 font-mono text-sm">v{v.version}{v.version === data.active?.version && <span className="ml-2"><Badge tone="green">active</Badge></span>}</td>
              <td className="px-4 py-2 text-xs text-gray-500"><Time ts={v.createdAt} /></td>
              <td className="px-4 py-2 text-sm text-gray-600">{v.createdBy || '—'}</td>
              <td className="px-4 py-2 text-sm text-gray-600">{v.reason || '—'}</td>
              <td className="px-4 py-2 text-right space-x-1 whitespace-nowrap">
                <RBtn small onClick={() => view(v)}>View</RBtn>
                {editable && v.version !== data.active?.version && <RBtn small onClick={() => restore(v)}>Restore this version</RBtn>}
              </td>
            </tr>
          ))}
        </Table>
      </div>

      {review && <SaveModal diff={review.diff} onClose={() => setReview(null)} onSave={save} />}
      {viewing && <VersionModal v={viewing} canRestore={editable} onClose={() => setViewing(null)} onRestore={restore} />}
    </div>
  );
}
