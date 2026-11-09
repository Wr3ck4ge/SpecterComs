import { describe, it, expect } from 'vitest';
import { decideVideoRecovery, recoverBackoffMs } from '../src/engine/videoRecovery.js';

const base = { lastPacketTs: 9990, now: 10000 };

describe('decideVideoRecovery', () => {
  it('does nothing for a healthy decoder', () => {
    expect(decideVideoRecovery({ ...base, lastDecodedTs: 9900 }).action).toBe('none');
  });
  it('does nothing when nothing is pending (idle sharer)', () => {
    expect(decideVideoRecovery({ ...base, lastDecodedTs: null }).action).toBe('none');
  });
  it('does nothing when no packets are arriving', () => {
    expect(decideVideoRecovery({ now: 10000, lastPacketTs: 5000, lastDecodedTs: 1000 }).action).toBe('none');
  });
  it('resets on error and on closed', () => {
    expect(decideVideoRecovery({ ...base, broken: true }).action).toBe('reset');
    expect(decideVideoRecovery({ ...base, state: 'closed' })).toMatchObject({ action: 'reset', reason: 'decoder closed' });
  });
  it('resets on a 2 s output stall', () => {
    expect(decideVideoRecovery({ ...base, lastDecodedTs: 7900 }).action).toBe('reset');
    expect(decideVideoRecovery({ ...base, lastDecodedTs: 8100 }).action).toBe('none');
  });
  it('resets earlier when the queue is backed up', () => {
    expect(decideVideoRecovery({ ...base, lastDecodedTs: 8900, queueSize: 40 }).action).toBe('reset');
    expect(decideVideoRecovery({ ...base, lastDecodedTs: 8900, queueSize: 5 }).action).toBe('none');
  });
  it('backs off between recoveries', () => {
    const args = { ...base, broken: true, attempts: 2 };
    expect(decideVideoRecovery({ ...args, lastRecoverTs: 9000 }).action).toBe('none');
    expect(decideVideoRecovery({ ...args, lastRecoverTs: 7900 }).action).toBe('reset');
    expect([0, 1, 2, 3, 6].map(recoverBackoffMs)).toEqual([0, 1000, 2000, 4000, 8000]);
  });
  it('falls back to a full resubscribe once the budget is spent', () => {
    expect(decideVideoRecovery({ ...base, broken: true, attempts: 3, lastRecoverTs: 9999 }).action).toBe('resubscribe');
  });
});
