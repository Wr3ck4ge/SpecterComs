/**
 * Pure config logic (tier catalog, thresholds, liveness window) and the
 * heartbeat wire contract between media-rust and identity-node.
 *
 * Contract C3: media-rust serializes the heartbeat with serde and pins the
 * output to services/media-rust/tests/fixtures/heartbeat.sample.json (a Rust
 * test fails if the serializer drifts from it). This side checks the same
 * fixture carries every field discovery.ts reads, in the agreed order.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DROPLET_TIERS, getNextTier } from '../../../src/config/dropletTiers.js';
import { DROPLET_SIZE, DROPLET_SIZE_TIER_ID } from '../../../src/utils/doProvisioning.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../../../..');

describe('droplet tiers', () => {
  it('catalog is ordered smallest → largest by vcpus, ram and price', () => {
    for (let i = 1; i < DROPLET_TIERS.length; i++) {
      const [a, b] = [DROPLET_TIERS[i - 1], DROPLET_TIERS[i]];
      expect(b.monthly_usd).toBeGreaterThan(a.monthly_usd);
      expect(b.ram_gb).toBeGreaterThanOrEqual(a.ram_gb);
      expect(b.vcpus).toBeGreaterThanOrEqual(a.vcpus);
    }
    expect(new Set(DROPLET_TIERS.map((t) => t.id)).size).toBe(DROPLET_TIERS.length);
  });

  it('getNextTier steps up one, and is null at the top / for unknown or missing tiers', () => {
    expect(getNextTier('basic-1vcpu-0.5gb')?.id).toBe('basic-1vcpu-1gb');
    expect(getNextTier('basic-2vcpu-4gb')?.id).toBe('basic-4vcpu-8gb');
    expect(getNextTier('basic-8vcpu-16gb')).toBeNull();
    expect(getNextTier('s-2vcpu-4gb')).toBeNull(); // a DO slug, not a catalog id
    expect(getNextTier(null)).toBeNull();
    expect(getNextTier(undefined)).toBeNull();
  });

  it('the provisioning droplet size maps to a real catalog tier (eval L2 fixed)', () => {
    const tier = DROPLET_TIERS.find((t) => t.id === DROPLET_SIZE_TIER_ID);
    expect(tier).toMatchObject({ vcpus: 2, ram_gb: 4 });
    expect(DROPLET_SIZE).toBe('s-2vcpu-4gb');
  });
});

describe('node thresholds and liveness', () => {
  const KEYS = ['NODE_CPU_ALERT_PCT', 'NODE_MEM_ALERT_PCT', 'NODE_BANDWIDTH_CAP_MBPS', 'NODE_BANDWIDTH_ALERT_PCT',
    'NODE_OVERLOAD_SUSTAIN_SECONDS', 'NODE_HEARTBEAT_INTERVAL_MS', 'NODE_STALE_MISSED_HEARTBEATS'];
  afterEach(() => { for (const k of KEYS) delete process.env[k]; vi.resetModules(); vi.restoreAllMocks(); });

  it('defaults', async () => {
    vi.resetModules();
    const t = await import('../../../src/config/nodeThresholds.js');
    expect([t.NODE_CPU_ALERT_PCT, t.NODE_MEM_ALERT_PCT, t.NODE_BANDWIDTH_CAP_MBPS, t.NODE_BANDWIDTH_ALERT_PCT, t.NODE_OVERLOAD_SUSTAIN_SECONDS])
      .toEqual([80, 85, 800, 80, 30]);
  });

  it('env overrides are read at module load', async () => {
    process.env.NODE_CPU_ALERT_PCT = '60';
    process.env.NODE_BANDWIDTH_CAP_MBPS = '2000';
    vi.resetModules();
    const t = await import('../../../src/config/nodeThresholds.js');
    expect(t.NODE_CPU_ALERT_PCT).toBe(60);
    expect(t.NODE_BANDWIDTH_CAP_MBPS).toBe(2000);
  });

  it('a typo in an override falls back to the default with a warning instead of silently disabling the check (eval L3 fixed)', async () => {
    process.env.NODE_CPU_ALERT_PCT = '80%';
    process.env.NODE_MEM_ALERT_PCT = '500';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    const t = await import('../../../src/config/nodeThresholds.js');
    expect(t.NODE_CPU_ALERT_PCT).toBe(80);
    expect(t.NODE_MEM_ALERT_PCT).toBe(85);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('staleness = 3 missed heartbeats: 15 s at the default 5 s interval, 6 s at 2 s (contract C3)', async () => {
    vi.resetModules();
    expect((await import('../../../src/config/nodeLiveness.js')).NODE_STALE_AFTER_SECONDS).toBe(15);
    process.env.NODE_HEARTBEAT_INTERVAL_MS = '2000';
    vi.resetModules();
    const l = await import('../../../src/config/nodeLiveness.js');
    expect(l.NODE_STALE_AFTER_SECONDS).toBe(6);
    expect(l.liveSql('x')).toBe('(x IS NOT NULL AND x > NOW() - make_interval(secs => 6))');
  });
});

describe('heartbeat wire contract (media-rust → discovery.ts)', () => {
  const FIXTURE = path.join(ROOT, 'services/media-rust/tests/fixtures/heartbeat.sample.json');
  const REQUIRED = ['status', 'public_url', 'node_id', 'region', 'voice_sessions', 'video_viewers', 'video_sharers',
    'cpu_pct', 'mem_pct', 'net_rx_mbps', 'net_tx_mbps'];
  const OPTIONAL = ['draining'];
  // Omitted entirely unless the relay has WEBTRANSPORT_ALT_PORT (heartbeat.alt_port.sample.json).
  const OPTIONAL_OMITTED = ['alt_port'];
  const ALT_FIXTURE = path.join(ROOT, 'services/media-rust/tests/fixtures/heartbeat.alt_port.sample.json');

  const fieldsRead = () => {
    const disc = fs.readFileSync(path.join(ROOT, 'services/identity-node/src/utils/discovery.ts'), 'utf8');
    return [...new Set([...disc.matchAll(/data\??\.([a-z_]+)/g)].map((x) => x[1]))];
  };

  it('the canonical sample exists and is valid JSON with the agreed fields, in order', () => {
    const json = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    expect(Object.keys(json)).toEqual([...REQUIRED, ...OPTIONAL]);
    expect(json.status).toBe('ok');
    expect(typeof json.voice_sessions).toBe('number');
    expect(typeof json.cpu_pct).toBe('number');
    expect(typeof json.draining).toBe('boolean');
  });

  it('carries every field discovery.ts reads (and discovery reads nothing outside the contract)', () => {
    const json = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const read = fieldsRead();
    for (const f of read) {
      if (OPTIONAL_OMITTED.includes(f)) continue;
      expect(json, `discovery reads data.${f}`).toHaveProperty(f);
    }
    for (const f of read) expect([...REQUIRED, ...OPTIONAL, ...OPTIONAL_OMITTED]).toContain(f);
  });

  it('the alt_port sample is the base sample plus alt_port (a number), last', () => {
    const base = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const alt = JSON.parse(fs.readFileSync(ALT_FIXTURE, 'utf8'));
    expect(Object.keys(alt)).toEqual([...Object.keys(base), 'alt_port']);
    expect(Number.isInteger(alt.alt_port)).toBe(true);
    expect(fieldsRead()).toContain('alt_port');
  });

  it('media-rust publishes the heartbeat on the scoped subject media.heartbeat.<NODE_ID> (contract C2)', () => {
    const src = fs.readdirSync(path.join(ROOT, 'services/media-rust/src'))
      .filter((f) => f.endsWith('.rs'))
      .map((f) => fs.readFileSync(path.join(ROOT, 'services/media-rust/src', f), 'utf8')).join('\n');
    expect(src).toMatch(/media\.heartbeat\.\{\}/);
    expect(src).toMatch(/specter\.usage\.session_end\.\{\}/);
  });
});
