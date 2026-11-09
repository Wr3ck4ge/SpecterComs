import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { isHardwareId, hardwareIdOrNull } from '../../src/utils/hwid.js';

describe('hardware id policy', () => {
  const real = crypto.createHash('sha256').update('some machine').digest('hex');

  it('accepts the desktop client shape (64 lowercase hex)', () => {
    expect(isHardwareId(real)).toBe(true);
    expect(hardwareIdOrNull(real)).toBe(real);
  });

  it('never treats the shared browser fallback literal as a hardware id', () => {
    expect(isHardwareId('browser-fallback-hwid')).toBe(false);
    expect(hardwareIdOrNull('browser-fallback-hwid')).toBeNull();
  });

  it('rejects missing, non-string and malformed values', () => {
    for (const v of [undefined, null, '', 42, {}, real.toUpperCase(), real.slice(1), `${real}0`, crypto.randomUUID()]) {
      expect(hardwareIdOrNull(v)).toBeNull();
    }
  });
});
