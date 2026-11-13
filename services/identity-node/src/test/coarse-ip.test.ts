import { describe, it, expect } from 'vitest';
import { coarseIp } from '../utils/coarseIp.js';

describe('coarseIp', () => {
  it('truncates IPv4 to /24', () => {
    expect(coarseIp('203.0.113.77')).toBe('203.0.113.0/24');
    expect(coarseIp('::ffff:203.0.113.77')).toBe('203.0.113.0/24');
  });
  it('truncates IPv6 to /48', () => {
    expect(coarseIp('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1::/48');
    expect(coarseIp('2001:db8::1')).toBe('2001:db8::/48');
  });
  it('returns null for empty or junk', () => {
    expect(coarseIp(null)).toBeNull();
    expect(coarseIp('nope')).toBeNull();
  });
});
