import crypto from 'crypto';
import { getDoApiToken, getDoDnsScopedToken } from '../config/doApiToken.js';

/**
 * Phase B of multi-tenant infra (docs/MULTI_TENANT_INFRASTRUCTURE_PLAN_2026_07_04.md):
 * provisions a new DigitalOcean droplet running only media-rust, joins it to
 * the shared VPC and central NATS, and lets it self-register with the control
 * plane the same way node-1 already does (media_nodes upsert on heartbeat —
 * see utils/discovery.ts). No SSH from this server to the new droplet at any
 * point — DO's own infrastructure runs the cloud-init user_data script on
 * first boot, so this process never needs to hold an SSH private key.
 *
 * Plain fetch against the DO REST API (Node 20 has this built in) rather than
 * a client library, matching this codebase's generally dependency-light style
 * — there is no existing DO tooling anywhere in the repo to build on.
 */

const DO_API_BASE = 'https://api.digitalocean.com/v2';
const DOMAIN = 'spectercoms.net';
// Fixed for v1 — not admin-configurable, keeps the provisioning surface small
// while this automation is new/unproven.
const DROPLET_SIZE = 's-2vcpu-4gb';
const DROPLET_IMAGE = 'docker-20-04';

const REGION_ALLOWLIST = ['nyc3', 'sfo3', 'ams3', 'fra1', 'sgp1'];

export function isValidRegion(region: string): boolean {
  return REGION_ALLOWLIST.includes(region);
}

// node_id flows into a DNS record name, a droplet name, and — critically —
// gets string-interpolated directly into a bash heredoc in buildCloudInit()
// below (NODE_HOSTNAME=${nodeId}.spectercoms.net inside a quoted <<'ENV_EOF'
// block). A value containing an embedded newline plus the literal text
// "ENV_EOF" would terminate that heredoc early and let arbitrary text after
// it execute as root on the new droplet at first boot. Restricting to a short
// DNS-label-safe charset closes that off entirely, not just the one known
// heredoc delimiter — same reasoning applies to any other literal we might
// interpolate into the script later.
const NODE_ID_PATTERN = /^[a-z0-9-]{3,20}$/;

export function isValidNodeId(nodeId: string): boolean {
  return NODE_ID_PATTERN.test(nodeId);
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
    throw new Error(`DigitalOcean API ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  // DELETE-style calls can return an empty body.
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export function generateNodeId(): string {
  return `node-${crypto.randomUUID().slice(0, 8)}`;
}

interface CloudInitParams {
  nodeId: string;
  region: string;
  jwtSecret: string;
  natsUrl: string;
  natsAuthToken: string;
  publicUrl: string;
  nodeHostname: string;
  dnsScopedToken: string;
}

/**
 * Builds the plain-bash user_data script DO runs on first boot. Bash (not
 * #cloud-config YAML) — simpler to reason about and debug via
 * /var/log/cloud-init-output.log than YAML module config.
 *
 * TLS via DNS-01 (certbot-dns-digitalocean), not HTTP-01: since DNS is already
 * on DigitalOcean, this avoids waiting for the just-created A record to
 * propagate before issuance can succeed, and means this node never needs port
 * 80/443-tcp open at all — only 443/udp for WebTransport. Uses a narrowly
 * DNS-scoped token (getDoDnsScopedToken), not the full-access DO_API_TOKEN —
 * the full-access token never touches a droplet's disk.
 */
export function buildCloudInit(params: CloudInitParams): string {
  const { nodeId, region, jwtSecret, natsUrl, natsAuthToken, publicUrl, nodeHostname, dnsScopedToken } = params;

  const composeYaml = `version: '3.8'
services:
  specter-media:
    image: ghcr.io/wr3ck4ge/projectechelonlink-media:latest
    cap_add:
      - NET_ADMIN
    network_mode: "host"
    environment:
      - JWT_SECRET=\${JWT_SECRET}
      - NATS_URL=\${NATS_URL}
      - NATS_AUTH_TOKEN=\${NATS_AUTH_TOKEN}
      - WEBTRANSPORT_PORT=443
      - NODE_ID=\${NODE_ID}
      - REGION=\${REGION}
      - PUBLIC_URL=\${PUBLIC_URL}
      - TLS_CERT=/etc/letsencrypt/live/\${NODE_HOSTNAME}/fullchain.pem
      - TLS_KEY=/etc/letsencrypt/live/\${NODE_HOSTNAME}/privkey.pem
    volumes:
      - /etc/letsencrypt:/etc/letsencrypt:ro
    restart: always
`;

  const envFile = [
    `JWT_SECRET=${jwtSecret}`,
    `NATS_URL=${natsUrl}`,
    `NATS_AUTH_TOKEN=${natsAuthToken}`,
    `NODE_ID=${nodeId}`,
    `REGION=${region}`,
    `PUBLIC_URL=${publicUrl}`,
    `NODE_HOSTNAME=${nodeHostname}`,
  ].join('\n');

  // Heredocs use quoted delimiters ('EOF') throughout so none of the embedded
  // values are shell-expanded a second time when cloud-init writes them.
  return `#!/bin/bash
set -e
mkdir -p /root/specter-node
cd /root/specter-node

cat > docker-compose.media-node.yml <<'COMPOSE_EOF'
${composeYaml}COMPOSE_EOF

cat > .env <<'ENV_EOF'
${envFile}
ENV_EOF

apt-get update
apt-get install -y certbot python3-certbot-dns-digitalocean

mkdir -p /root/.secrets
cat > /root/.secrets/do-dns.ini <<'DNS_EOF'
dns_digitalocean_token = ${dnsScopedToken}
DNS_EOF
chmod 600 /root/.secrets/do-dns.ini

# Retry loop: DO API rate limits / transient network issues, not DNS propagation
# (DNS-01 doesn't need the A record to resolve first — certbot creates its own
# TXT challenge record via the API).
for attempt in $(seq 1 6); do
  if certbot certonly --dns-digitalocean \\
      --dns-digitalocean-credentials /root/.secrets/do-dns.ini \\
      -d ${nodeHostname} --non-interactive --agree-tos -m ops@${DOMAIN}; then
    break
  fi
  echo "certbot attempt $attempt failed, retrying in 20s"
  sleep 20
done

set -a
source /root/specter-node/.env
set +a
docker compose -f docker-compose.media-node.yml up -d

# Renewal — DNS-01 needs no port-80 pre/post hooks and no downtime, unlike
# node-1's HTTP-01 setup (see docker-compose.prod.yml's certbot service).
# certbot writes straight to /etc/letsencrypt, which the container bind-mounts
# read-only, so a restart (to pick up the renewed files) is the only deploy-hook
# step needed — no copying between paths.
cat > /etc/cron.d/certbot-renew <<'CRON_EOF'
0 */12 * * * root certbot renew --quiet --deploy-hook "docker compose -f /root/specter-node/docker-compose.media-node.yml restart"
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
    tags: ['specter-node', 'specter-managed'],
  };
  if (params.vpcUuid) body.vpc_uuid = params.vpcUuid;

  const result = await doApiRequest('/droplets', { method: 'POST', body: JSON.stringify(body) });
  return result.droplet;
}

async function pollDropletPublicIp(dropletId: number, timeoutMs = 120_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await doApiRequest(`/droplets/${dropletId}`);
    const publicNet = result.droplet?.networks?.v4?.find((n: any) => n.type === 'public');
    if (publicNet?.ip_address) return publicNet.ip_address;
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`Timed out waiting for droplet ${dropletId} to get a public IP`);
}

async function createDnsRecord(nodeId: string, ip: string): Promise<void> {
  await doApiRequest(`/domains/${DOMAIN}/records`, {
    method: 'POST',
    body: JSON.stringify({ type: 'A', name: nodeId, data: ip, ttl: 300 }),
  });
}

export interface ProvisionNodeParams {
  region: string;
  nodeId?: string;
  jwtSecret: string;
  natsUrl: string;
  natsAuthToken: string;
  vpcUuid?: string;
}

export interface ProvisionNodeResult {
  nodeId: string;
  dropletId: number;
}

export async function provisionNode(params: ProvisionNodeParams): Promise<ProvisionNodeResult> {
  const nodeId = params.nodeId || generateNodeId();
  // Enforced here too (not just at the admin controller boundary) since this
  // value gets interpolated into a bash heredoc in buildCloudInit() — any
  // caller of this module gets the same protection, not just the current one.
  if (!isValidNodeId(nodeId)) {
    throw new Error(`Invalid node_id "${nodeId}" — must match ${NODE_ID_PATTERN}`);
  }
  const nodeHostname = `${nodeId}.${DOMAIN}`;
  const publicUrl = `https://${nodeHostname}`;

  const userData = buildCloudInit({
    nodeId,
    region: params.region,
    jwtSecret: params.jwtSecret,
    natsUrl: params.natsUrl,
    natsAuthToken: params.natsAuthToken,
    publicUrl,
    nodeHostname,
    dnsScopedToken: getDoDnsScopedToken(),
  });

  const droplet = await createDroplet({
    name: nodeId,
    region: params.region,
    userData,
    vpcUuid: params.vpcUuid,
  });

  const ip = await pollDropletPublicIp(droplet.id);
  await createDnsRecord(nodeId, ip);

  return { nodeId, dropletId: droplet.id };
}
