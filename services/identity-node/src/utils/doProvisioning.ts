import crypto from 'crypto';
import { getDoApiToken } from '../config/doApiToken.js';

/**
 * Phase B of multi-tenant infra (docs/MULTI_TENANT_INFRASTRUCTURE_PLAN_2026_07_04.md):
 * provisions a new DigitalOcean droplet running only media-rust, joins it to
 * the shared VPC and central NATS, and lets it self-register with the control
 * plane the same way node-1 already does (media_nodes upsert on heartbeat —
 * see utils/discovery.ts). No SSH from this server to the new droplet at any
 * point — DO's own infrastructure runs the cloud-init user_data script on
 * first boot, so this process never needs to hold an SSH private key.
 *
 * What a node gets (docs/MULTI_NODE_HARDENING_ROLLOUT_2026_10_29.md):
 *   - MEDIA_TICKET_PUBLIC_KEY to verify ES256 media tickets — NEVER JWT_SECRET;
 *   - its own NATS user (= NODE_ID) and secret — never the shared token;
 *   - a read-only GHCR pull token, used once and removed;
 *   - NO DigitalOcean credential: the control plane creates the A record, and
 *     the node gets its certificate by certbot HTTP-01 standalone.
 *
 * Plain fetch against the DO REST API (Node 20 has this built in) rather than
 * a client library, matching this codebase's generally dependency-light style.
 */

const DO_API_BASE = 'https://api.digitalocean.com/v2';
export const DOMAIN = 'spectercoms.net';
// Fixed for v1 — not admin-configurable, keeps the provisioning surface small
// while this automation is new/unproven.
export const DROPLET_SIZE = 's-2vcpu-4gb';
// The DROPLET_TIERS catalog id (config/dropletTiers.ts) for DROPLET_SIZE, so a
// provisioned node is tagged with a plan_tier and gets tier recommendations (eval L2).
export const DROPLET_SIZE_TIER_ID = 'basic-2vcpu-4gb';
const DROPLET_IMAGE = 'docker-20-04';
export const MANAGED_TAG = 'specter-managed';

const REGION_ALLOWLIST = ['nyc3', 'sfo3', 'ams3', 'fra1', 'sgp1'];

export function isValidRegion(region: string): boolean {
  return REGION_ALLOWLIST.includes(region);
}

// node_id flows into a DNS record name, a droplet name, a NATS user name, and
// gets interpolated into bash heredocs in buildCloudInit(). A short
// DNS-label-safe charset closes off heredoc/command injection entirely.
const NODE_ID_PATTERN = /^[a-z0-9-]{3,20}$/;

export function isValidNodeId(nodeId: string): boolean {
  return NODE_ID_PATTERN.test(nodeId);
}

// ── Values interpolated into cloud-init (eval M4) ──────────────────────────────
// Every value is checked before it goes into a heredoc or the node .env: no
// whitespace/newline (so no heredoc can be ended early), and nothing compose
// or bash would expand ($, quotes, backslash, backtick).
const ENV_SAFE = /^[\w.~+/=:@-]+$/;
const NATS_URL_PATTERN = /^nats:\/\/[A-Za-z0-9.-]+:\d{1,5}$/;
// A pinned image: a tag that isn't `latest`, or a digest (eval H3).
const IMAGE_REF_PATTERN = /^ghcr\.io\/[a-z0-9][a-z0-9._/-]*(?::([\w][\w.-]{0,127})|@sha256:[a-f0-9]{64})$/;

export function isPinnedImageRef(ref: string): boolean {
  const m = IMAGE_REF_PATTERN.exec(ref);
  if (!m) return false;
  return m[1] === undefined || m[1] !== 'latest';
}

function assertSafe(name: string, value: string, pattern: RegExp = ENV_SAFE): void {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Refusing to build cloud-init: ${name} has an unsafe or invalid value`);
  }
}

/** Normalises and validates a PEM public key; returns it as one .env-safe line with literal \n. */
function publicKeyEnvValue(pem: string): string {
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey(pem.replace(/\\n/g, '\n'));
  } catch {
    throw new Error('Refusing to build cloud-init: MEDIA_TICKET_PUBLIC_KEY is not a valid PEM public key');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Refusing to build cloud-init: MEDIA_TICKET_PUBLIC_KEY must be an EC P-256 key');
  }
  const normalized = key.export({ type: 'spki', format: 'pem' }).toString().trim();
  // Double-quoted in .env: docker compose turns each \n back into a newline.
  return `"${normalized.replace(/\n/g, '\\n')}"`;
}

async function doApiRequest(path: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${DO_API_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${getDoApiToken()}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`DigitalOcean API ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  // DELETE-style calls can return an empty body.
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

const isTransient = (e: any) => e?.status === 429 || (typeof e?.status === 'number' && e.status >= 500);

export function generateNodeId(): string {
  return `node-${crypto.randomUUID().slice(0, 8)}`;
}

export interface CloudInitParams {
  nodeId: string;
  region: string;
  natsUrl: string;
  /** NATS user = nodeId; this is its per-node secret (contract C2). */
  natsPassword: string;
  /** PEM (real or literal \n newlines). Nodes verify ES256 media tickets with it (contract C1). */
  mediaTicketPublicKey: string;
  /** Pinned media image, e.g. ghcr.io/owner/repo-media:v1.10.50 or …@sha256:… (never :latest). */
  mediaImageRef: string;
  /** Read-only (read:packages) GHCR token, used once for the pull and then removed. */
  ghcrPullToken: string;
  ghcrPullUser: string;
  publicUrl: string;
  nodeHostname: string;
}

/**
 * Builds the plain-bash user_data script DO runs on first boot. Bash (not
 * #cloud-config YAML) — simpler to reason about and debug via
 * /var/log/cloud-init-output.log than YAML module config.
 *
 * TLS (contract C4): certbot HTTP-01 standalone. The control plane creates the
 * A record (createDnsRecord below) right after the droplet gets its IP; the
 * script waits for that record to resolve to this droplet, then issues with a
 * bounded retry and — unlike before — fails loudly (exit 1, PROVISION_FAILED
 * marker, relay never started) if no certificate is issued (eval M2). The node
 * holds no DNS credential at all (eval C2).
 *
 * Everything in user_data stays readable from inside the droplet at
 * 169.254.169.254/metadata/v1/user-data, so it carries only node-scoped
 * secrets: the node's own NATS password and the read-only pull token.
 */
export function buildCloudInit(params: CloudInitParams): string {
  const { nodeId, region, natsUrl, natsPassword, mediaTicketPublicKey, mediaImageRef, ghcrPullToken, ghcrPullUser, publicUrl, nodeHostname } = params;

  if (!isValidNodeId(nodeId)) throw new Error(`Refusing to build cloud-init: invalid node_id "${nodeId}"`);
  if (!isValidRegion(region)) throw new Error('Refusing to build cloud-init: region is not allowlisted');
  assertSafe('NATS_URL', natsUrl, NATS_URL_PATTERN);
  assertSafe('NATS_PASSWORD', natsPassword);
  assertSafe('GHCR_PULL_TOKEN', ghcrPullToken);
  assertSafe('GHCR_PULL_USER', ghcrPullUser, /^[A-Za-z0-9-]{1,39}$/);
  if (!isPinnedImageRef(mediaImageRef)) {
    throw new Error('Refusing to build cloud-init: MEDIA_IMAGE_REF must be a ghcr.io image pinned to a tag other than latest, or a digest');
  }
  if (nodeHostname !== `${nodeId}.${DOMAIN}` || publicUrl !== `https://${nodeHostname}`) {
    throw new Error('Refusing to build cloud-init: hostname/public URL do not match the node id');
  }
  const publicKeyValue = publicKeyEnvValue(mediaTicketPublicKey);

  const composeYaml = `version: '3.8'
services:
  specter-media:
    image: \${MEDIA_IMAGE_REF:?MEDIA_IMAGE_REF must be set}
    cap_add:
      - NET_ADMIN
    network_mode: "host"
    environment:
      - MEDIA_TICKET_PUBLIC_KEY=\${MEDIA_TICKET_PUBLIC_KEY:?MEDIA_TICKET_PUBLIC_KEY must be set}
      - NATS_URL=\${NATS_URL:?NATS_URL must be set}
      - NATS_USER=\${NATS_USER:?NATS_USER must be set}
      - NATS_PASSWORD=\${NATS_PASSWORD:?NATS_PASSWORD must be set}
      - WEBTRANSPORT_PORT=443
      - NODE_ID=\${NODE_ID:?NODE_ID must be set}
      - REGION=\${REGION:?REGION must be set}
      - PUBLIC_URL=\${PUBLIC_URL:?PUBLIC_URL must be set}
      - TLS_CERT=/etc/letsencrypt/live/\${NODE_HOSTNAME:?NODE_HOSTNAME must be set}/fullchain.pem
      - TLS_KEY=/etc/letsencrypt/live/\${NODE_HOSTNAME:?NODE_HOSTNAME must be set}/privkey.pem
    volumes:
      - /etc/letsencrypt:/etc/letsencrypt:ro
    restart: always
`;

  const envFile = [
    `MEDIA_IMAGE_REF=${mediaImageRef}`,
    `MEDIA_TICKET_PUBLIC_KEY=${publicKeyValue}`,
    `NATS_URL=${natsUrl}`,
    `NATS_USER=${nodeId}`,
    `NATS_PASSWORD=${natsPassword}`,
    `NODE_ID=${nodeId}`,
    `REGION=${region}`,
    `PUBLIC_URL=${publicUrl}`,
    `NODE_HOSTNAME=${nodeHostname}`,
  ].join('\n');

  // Heredocs use quoted delimiters ('EOF') throughout so none of the embedded
  // values are shell-expanded a second time when cloud-init writes them. The
  // .env is read by docker compose itself (--env-file), never `source`d by bash.
  return `#!/bin/bash
set -euo pipefail
umask 077
mkdir -p /root/specter-node /root/.secrets
cd /root/specter-node

fail() {
  echo "SPECTER PROVISION FAILED: $*" >&2
  echo "$(date -u +%FT%TZ) $*" > /root/specter-node/PROVISION_FAILED
  exit 1
}

cat > docker-compose.media-node.yml <<'COMPOSE_EOF'
${composeYaml}COMPOSE_EOF

cat > .env <<'ENV_EOF'
${envFile}
ENV_EOF
chmod 600 .env

# Host firewall: the DO docker image ships ufw. 443/udp = WebTransport,
# 80/tcp = certbot HTTP-01 (standalone, only while issuing/renewing).
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 443/udp
  ufw allow 80/tcp
fi

apt-get update
apt-get install -y certbot

# Wait (bounded) for the A record the control plane creates after this droplet
# gets its IP, so the HTTP-01 validation reaches this host.
PUBLIC_IP=$(curl -fsS http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address || true)
for i in $(seq 1 60); do
  RESOLVED=$(getent ahostsv4 ${nodeHostname} | awk 'NR==1 {print $1}' || true)
  if [ -n "$PUBLIC_IP" ] && [ "$RESOLVED" = "$PUBLIC_IP" ]; then break; fi
  echo "waiting for ${nodeHostname} -> $PUBLIC_IP (now: \${RESOLVED:-none}), attempt $i/60"
  sleep 10
done

cert_ok=0
for attempt in $(seq 1 6); do
  if certbot certonly --standalone --preferred-challenges http \\
      -d ${nodeHostname} --non-interactive --agree-tos -m ops@${DOMAIN}; then
    cert_ok=1
    break
  fi
  echo "certbot attempt $attempt/6 failed, retrying in 30s"
  sleep 30
done
if [ "$cert_ok" != "1" ]; then
  fail "no TLS certificate for ${nodeHostname} after 6 attempts; relay not started"
fi

# Pull the pinned image with a read-only token, then remove the credential.
cat > /root/.secrets/ghcr-token <<'GHCR_EOF'
${ghcrPullToken}
GHCR_EOF
if ! docker login ghcr.io -u ${ghcrPullUser} --password-stdin < /root/.secrets/ghcr-token; then
  rm -f /root/.secrets/ghcr-token
  fail "docker login ghcr.io failed"
fi
rm -f /root/.secrets/ghcr-token
if ! docker compose --env-file /root/specter-node/.env -f docker-compose.media-node.yml pull; then
  docker logout ghcr.io || true
  fail "could not pull ${mediaImageRef}"
fi
docker logout ghcr.io || true

docker compose --env-file /root/specter-node/.env -f docker-compose.media-node.yml up -d

# Renewal: standalone HTTP-01 needs port 80 free, which it is on a media node.
# certbot writes straight to /etc/letsencrypt, which the container bind-mounts
# read-only, so a restart (to pick up the renewed files) is the only deploy-hook
# step needed.
cat > /etc/cron.d/certbot-renew <<'CRON_EOF'
0 */12 * * * root certbot renew --quiet --deploy-hook "docker compose --env-file /root/specter-node/.env -f /root/specter-node/docker-compose.media-node.yml restart"
CRON_EOF
`;
}

async function createDroplet(params: { name: string; region: string; userData: string; vpcUuid?: string }): Promise<{ id: number }> {
  const body: Record<string, unknown> = {
    name: params.name,
    region: params.region,
    size: DROPLET_SIZE,
    image: DROPLET_IMAGE,
    user_data: params.userData,
    tags: ['specter-node', MANAGED_TAG],
  };
  if (params.vpcUuid) body.vpc_uuid = params.vpcUuid;

  const result = await doApiRequest('/droplets', { method: 'POST', body: JSON.stringify(body) });
  return result.droplet;
}

/** Polls until the droplet has a public IPv4. Transient 5xx/429 responses are retried, not fatal. */
async function pollDropletPublicIp(dropletId: number, timeoutMs = 120_000): Promise<string> {
  const start = Date.now();
  let lastError: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await doApiRequest(`/droplets/${dropletId}`);
      const publicNet = result.droplet?.networks?.v4?.find((n: any) => n.type === 'public');
      if (publicNet?.ip_address) return publicNet.ip_address;
    } catch (e) {
      if (!isTransient(e)) throw e;
      lastError = e;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`Timed out waiting for droplet ${dropletId} to get a public IP${lastError ? ` (last error: ${(lastError as Error).message})` : ''}`);
}

async function createDnsRecord(nodeId: string, ip: string): Promise<number | null> {
  const result = await doApiRequest(`/domains/${DOMAIN}/records`, {
    method: 'POST',
    body: JSON.stringify({ type: 'A', name: nodeId, data: ip, ttl: 300 }),
  });
  return result?.domain_record?.id ?? null;
}

export interface ProvisionNodeParams {
  region: string;
  nodeId?: string;
  natsUrl: string;
  natsPassword: string;
  mediaTicketPublicKey: string;
  mediaImageRef: string;
  ghcrPullToken: string;
  ghcrPullUser: string;
  vpcUuid?: string;
}

export interface ProvisionNodeResult {
  nodeId: string;
  dropletId: number;
  dnsRecordId: number | null;
  publicUrl: string;
}

/**
 * Thrown when provisioning fails AFTER the droplet was created. The droplet
 * (and A record) have already been deleted, best effort; `cleanedUp` says
 * whether that worked. `dropletId` is always set so the caller can record it.
 */
export class ProvisionError extends Error {
  constructor(message: string, readonly dropletId: number, readonly cleanedUp: boolean, readonly original?: unknown) {
    super(message);
    this.name = 'ProvisionError';
  }
}

export function nodeAddresses(nodeId: string) {
  const nodeHostname = `${nodeId}.${DOMAIN}`;
  return { nodeHostname, publicUrl: `https://${nodeHostname}` };
}

export async function provisionNode(params: ProvisionNodeParams): Promise<ProvisionNodeResult> {
  const nodeId = params.nodeId || generateNodeId();
  // Enforced here too (not just at the admin controller boundary) since this
  // value gets interpolated into a bash heredoc in buildCloudInit().
  if (!isValidNodeId(nodeId)) {
    throw new Error(`Invalid node_id "${nodeId}" — must match ${NODE_ID_PATTERN}`);
  }
  const { nodeHostname, publicUrl } = nodeAddresses(nodeId);

  // Built (and so validated) before any API call: a bad value costs nothing.
  const userData = buildCloudInit({
    nodeId,
    region: params.region,
    natsUrl: params.natsUrl,
    natsPassword: params.natsPassword,
    mediaTicketPublicKey: params.mediaTicketPublicKey,
    mediaImageRef: params.mediaImageRef,
    ghcrPullToken: params.ghcrPullToken,
    ghcrPullUser: params.ghcrPullUser,
    publicUrl,
    nodeHostname,
  });

  const droplet = await createDroplet({
    name: nodeId,
    region: params.region,
    userData,
    vpcUuid: params.vpcUuid,
  });

  // From here on the droplet costs money: any failure deletes it (and the A
  // record, if one was made) before rethrowing, with the droplet id in the error.
  let dnsRecordId: number | null = null;
  try {
    const ip = await pollDropletPublicIp(droplet.id);
    dnsRecordId = await createDnsRecord(nodeId, ip);
  } catch (e) {
    const cleanup = await destroyNodeInfrastructure({ nodeId, dropletId: droplet.id, dnsRecordId });
    const cleanedUp = cleanup.dropletDeleted && cleanup.dnsDeleted !== false;
    const msg = `Provisioning ${nodeId} failed after droplet ${droplet.id} was created: ${(e as Error).message}. `
      + (cleanedUp ? `Droplet ${droplet.id} was deleted.` : `CLEANUP INCOMPLETE — check droplet ${droplet.id} and the ${nodeHostname} A record in the DO console. ${cleanup.errors.join('; ')}`);
    console.error(`[provision] ${msg}`);
    throw new ProvisionError(msg, droplet.id, cleanedUp, e);
  }

  return { nodeId, dropletId: droplet.id, dnsRecordId, publicUrl };
}

export interface DestroyResult {
  dropletDeleted: boolean;
  /** null when there was no record to delete. */
  dnsDeleted: boolean | null;
  errors: string[];
}

/**
 * Deletes a node's DNS A record and droplet, best effort, logging each failure.
 * Ids that aren't known are looked up (the A record by name, the droplet by
 * name among `specter-managed` droplets). A 404 counts as already deleted.
 */
export async function destroyNodeInfrastructure(opts: {
  nodeId: string;
  dropletId?: number | null;
  dnsRecordId?: number | null;
  /** Look up ids that aren't given (teardown). */
  lookup?: boolean;
  /** Refuse to delete a droplet that doesn't carry the specter-managed tag (teardown). */
  verifyTag?: boolean;
}): Promise<DestroyResult> {
  const errors: string[] = [];
  const gone = (e: any) => e?.status === 404;
  let dnsRecordIds: number[] = opts.dnsRecordId ? [opts.dnsRecordId] : [];
  let dropletId = opts.dropletId ?? null;

  if (dropletId !== null && opts.verifyTag) {
    try {
      const r = await doApiRequest(`/droplets/${dropletId}`);
      const tags: string[] = r.droplet?.tags ?? [];
      if (!tags.includes(MANAGED_TAG) || r.droplet?.name !== opts.nodeId) {
        errors.push(`droplet ${dropletId} is not a ${MANAGED_TAG} droplet named ${opts.nodeId}; refusing to delete it`);
        for (const m of errors) console.error(`[provision] cleanup for ${opts.nodeId}: ${m}`);
        return { dropletDeleted: false, dnsDeleted: null, errors };
      }
    } catch (e) {
      if ((e as any)?.status === 404) dropletId = null; // already gone
      else {
        errors.push(`droplet ${dropletId} lookup: ${(e as Error).message}`);
        for (const m of errors) console.error(`[provision] cleanup for ${opts.nodeId}: ${m}`);
        return { dropletDeleted: false, dnsDeleted: null, errors };
      }
    }
  }

  if (opts.lookup) {
    try {
      if (!dnsRecordIds.length) {
        const r = await doApiRequest(`/domains/${DOMAIN}/records?type=A&name=${encodeURIComponent(`${opts.nodeId}.${DOMAIN}`)}`);
        dnsRecordIds = (r.domain_records ?? []).filter((d: any) => d.name === opts.nodeId && d.type === 'A').map((d: any) => d.id);
      }
    } catch (e) { errors.push(`A record lookup: ${(e as Error).message}`); }
    try {
      if (!dropletId) {
        const r = await doApiRequest(`/droplets?tag_name=${MANAGED_TAG}&per_page=200`);
        dropletId = (r.droplets ?? []).find((d: any) => d.name === opts.nodeId)?.id ?? null;
      }
    } catch (e) { errors.push(`droplet lookup: ${(e as Error).message}`); }
  }

  let dnsDeleted: boolean | null = dnsRecordIds.length ? true : null;
  for (const id of dnsRecordIds) {
    try {
      await doApiRequest(`/domains/${DOMAIN}/records/${id}`, { method: 'DELETE' });
    } catch (e) {
      if (!gone(e)) { dnsDeleted = false; errors.push(`DELETE A record ${id}: ${(e as Error).message}`); }
    }
  }

  let dropletDeleted = dropletId === null && !errors.some((m) => m.startsWith('droplet lookup'));
  if (dropletId !== null) {
    try {
      await doApiRequest(`/droplets/${dropletId}`, { method: 'DELETE' });
      dropletDeleted = true;
    } catch (e) {
      if (gone(e)) dropletDeleted = true;
      else errors.push(`DELETE droplet ${dropletId}: ${(e as Error).message}`);
    }
  }
  for (const m of errors) console.error(`[provision] cleanup for ${opts.nodeId}: ${m}`);
  return { dropletDeleted, dnsDeleted, errors };
}

/**
 * Reconciler input: every droplet tagged specter-managed. The caller compares
 * the names against media_nodes / node_provision_requests (nodeLifecycle.ts).
 */
export async function listManagedDroplets(): Promise<Array<{ id: number; name: string; created_at?: string }>> {
  const r = await doApiRequest(`/droplets?tag_name=${MANAGED_TAG}&per_page=200`);
  return (r.droplets ?? []).map((d: any) => ({ id: d.id, name: d.name, created_at: d.created_at }));
}
