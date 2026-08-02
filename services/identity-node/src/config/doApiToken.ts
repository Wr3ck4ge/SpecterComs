/**
 * DigitalOcean API token used only by node provisioning (services/identity-node/
 * src/utils/doProvisioning.ts). Unlike getJwtSecret() (config/jwtSecret.ts),
 * this is checked lazily — only when an admin actually triggers provisioning —
 * not at server startup, since it's a rare admin action rather than an
 * every-request path. A server that never provisions nodes should boot fine
 * without this set.
 */
export function getDoApiToken(): string {
  const token = process.env.DO_API_TOKEN;
  if (!token) {
    throw new Error('DO_API_TOKEN must be set — refusing to provision infrastructure without a DigitalOcean API token.');
  }
  return token;
}

/**
 * Narrower, DNS-only token embedded in a new node's cloud-init for certbot's
 * DNS-01 challenge — deliberately separate from getDoApiToken() so a
 * compromised media node's disk only ever exposes a token that can write DNS
 * TXT records, never one that can create/destroy droplets or read billing.
 */
export function getDoDnsScopedToken(): string {
  const token = process.env.DO_DNS_SCOPED_TOKEN;
  if (!token) {
    throw new Error('DO_DNS_SCOPED_TOKEN must be set — refusing to provision a node without a DNS-scoped token for TLS issuance.');
  }
  return token;
}
