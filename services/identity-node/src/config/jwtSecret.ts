/**
 * Shared JWT signing/verification secret. Previously each controller/middleware
 * independently did `process.env.JWT_SECRET || 'dev_secret'` — if JWT_SECRET was
 * ever unset in a production environment, tokens silently became forgeable with
 * a publicly-known default (and media-rust's own default didn't even match this
 * one, so a misconfiguration would present as "auth is broken" rather than
 * "auth is insecure"). Fails closed instead: throws rather than falling back.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET must be set — refusing to sign or verify tokens with an insecure default.');
  }
  return secret;
}
