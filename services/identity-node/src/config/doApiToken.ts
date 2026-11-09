/**
 * DigitalOcean API token used only by node provisioning/teardown (services/
 * identity-node/src/utils/doProvisioning.ts). Unlike getJwtSecret()
 * (config/jwtSecret.ts), this is checked lazily — only when an admin actually
 * triggers provisioning — not at server startup, since it's a rare admin action
 * rather than an every-request path. A server that never provisions nodes
 * should boot fine without this set.
 *
 * It never leaves the control plane. Use a DO custom-scoped token, not a
 * full-access one (eval H6): droplet create/read/delete, tag create/read,
 * domain read/create/delete (A records only are written), vpc read. See
 * docs/MULTI_NODE_HARDENING_ROLLOUT_2026_10_29.md.
 *
 * (DO_DNS_SCOPED_TOKEN is gone: nodes no longer get any DNS credential — they
 * issue their certificate by HTTP-01, and the control plane writes the A record.)
 */
export function getDoApiToken(): string {
  const token = process.env.DO_API_TOKEN;
  if (!token) {
    throw new Error('DO_API_TOKEN must be set — refusing to provision infrastructure without a DigitalOcean API token.');
  }
  return token;
}
