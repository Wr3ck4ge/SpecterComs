/**
 * Prints fresh values for the multi-node hardening secrets, as JSON ready to
 * merge into secrets/deploy-secrets.json (docs/MULTI_NODE_HARDENING_ROLLOUT_2026_10_29.md).
 * Nothing is written anywhere; run it locally, copy the output into the
 * secrets file, and don't paste it into chat/issues.
 *
 *   cd services/identity-node && npx tsc && node dist/scripts/generateNodeSecrets.js
 *   (or, on the droplet: docker compose -f docker-compose.prod.yml exec specter-auth node dist/scripts/generateNodeSecrets.js)
 *
 * Pass --only=<KEY,...> to print a subset (e.g. when rotating one value).
 */
import crypto from 'crypto';
import { nkeys } from 'nats';

const dec = new TextDecoder();
const issuer = nkeys.createAccount();
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const secret = () => crypto.randomBytes(32).toString('base64url');

const all: Record<string, string> = {
  // C1 — control plane only / every relay
  MEDIA_TICKET_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  MEDIA_TICKET_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  // C2 — NATS
  NATS_CONTROL_PASSWORD: secret(),
  NATS_CALLOUT_ISSUER_SEED: dec.decode(issuer.getSeed()),
  NATS_CALLOUT_ISSUER_PUBLIC: issuer.getPublicKey(),
  NATS_NODE1_PASSWORD: secret(),
  NATS_NODE1_GREEN_PASSWORD: secret(),
};

const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');
const out = only ? Object.fromEntries(Object.entries(all).filter(([k]) => only.includes(k))) : all;
// The issuer seed and its public key only make sense together.
if (only && ('NATS_CALLOUT_ISSUER_SEED' in out) !== ('NATS_CALLOUT_ISSUER_PUBLIC' in out)) {
  console.error('NATS_CALLOUT_ISSUER_SEED and NATS_CALLOUT_ISSUER_PUBLIC must be generated together');
  process.exit(1);
}
console.log(JSON.stringify(out, null, 2));
