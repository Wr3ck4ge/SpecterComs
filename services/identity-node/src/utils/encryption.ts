import crypto from 'crypto';

/**
 * AES-256-GCM symmetric encryption for storing recoverable email addresses.
 * Requires EMAIL_ENCRYPTION_KEY env var: a 64-character hex string (32 bytes).
 *
 * Format stored in DB: "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 */

function getKey(): Buffer {
  const hex = process.env.EMAIL_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('EMAIL_ENCRYPTION_KEY must be set to a 64-char hex string (32 bytes). Generate with: openssl rand -hex 32');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptEmail(email: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(email.toLowerCase().trim(), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptEmail(stored: string): string {
  const key = getKey();
  const parts = stored.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted email format');
  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const ciphertext = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
}
