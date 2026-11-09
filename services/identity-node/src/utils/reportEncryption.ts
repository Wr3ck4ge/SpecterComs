import crypto from 'crypto';

/**
 * AES-256-GCM encryption for sensitive report evidence at rest (currently:
 * voice misconduct report audio clips). A distinct key from
 * EMAIL_ENCRYPTION_KEY (encryption.ts) — compromising one shouldn't expose
 * the other. Requires REPORT_ENCRYPTION_KEY: a 64-char hex string (32 bytes).
 *
 * Unlike encryptEmail/decryptEmail this operates on raw Buffers, not utf8
 * strings — report audio is binary (framed Opus frames), not text.
 */

function getKey(): Buffer {
  const hex = process.env.REPORT_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('REPORT_ENCRYPTION_KEY must be set to a 64-char hex string (32 bytes). Generate with: openssl rand -hex 32');
  }
  return Buffer.from(hex, 'hex');
}

/** Returns `<iv><authTag><ciphertext>` concatenated as a single Buffer (12 + 16 + N bytes). */
export function encryptReportBuffer(plaintext: Buffer): Buffer {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

export function decryptReportBuffer(stored: Buffer): Buffer {
  const key = getKey();
  if (stored.length < 12 + 16) throw new Error('Encrypted report buffer too short');
  const iv = stored.subarray(0, 12);
  const tag = stored.subarray(12, 28);
  const ciphertext = stored.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
