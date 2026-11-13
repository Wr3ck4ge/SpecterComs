import { describe, it, expect } from 'vitest';
import {
  checkEligibility, checkDecider, validateAppealText, redactSecrets, addDays, APPEAL_WINDOW_DAYS, CSAM_MESSAGE,
} from '../../src/utils/banAppeals.js';

const T0 = new Date('2026-11-01T00:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * 86400000);

describe('checkEligibility', () => {
  it('allows an appeal inside the 30-day window and refuses after it', () => {
    expect(checkEligibility({ hasAction: true, actionAt: T0, now: at(29) }).ok).toBe(true);
    expect(checkEligibility({ hasAction: true, actionAt: T0, now: at(APPEAL_WINDOW_DAYS) }).ok).toBe(true);
    const late = checkEligibility({ hasAction: true, actionAt: T0, now: at(31) });
    expect(late).toMatchObject({ ok: false, code: 'WINDOW_CLOSED' });
  });
  it('allows only one appeal per action', () => {
    expect(checkEligibility({ hasAction: true, actionAt: T0, alreadyAppealed: true, now: at(1) }))
      .toMatchObject({ ok: false, code: 'ALREADY_APPEALED' });
  });
  it('refuses CSAM bans with a neutral message, even if also late or already appealed', () => {
    const r = checkEligibility({ hasAction: true, actionAt: T0, csam: true, alreadyAppealed: true, now: at(99) });
    expect(r).toEqual({ ok: false, code: 'CSAM', message: CSAM_MESSAGE });
    expect(CSAM_MESSAGE.toLowerCase()).not.toMatch(/csam|child|abuse/);
  });
  it('refuses when no ban action is on record', () => {
    expect(checkEligibility({ hasAction: false })).toMatchObject({ ok: false, code: 'NO_ACTION' });
  });
});

describe('checkDecider', () => {
  it('refuses the admin who took the action when others can decide', () => {
    expect(checkDecider({ actionAdminId: 'a', deciderId: 'a', deciderCount: 2 }).ok).toBe(false);
  });
  it('allows the acting admin only when they are the sole admin, and flags it', () => {
    expect(checkDecider({ actionAdminId: 'a', deciderId: 'a', deciderCount: 1 })).toEqual({ ok: true, soleAdmin: true });
  });
  it('allows a different admin', () => {
    expect(checkDecider({ actionAdminId: 'a', deciderId: 'b', deciderCount: 3 })).toEqual({ ok: true, soleAdmin: false });
  });
});

describe('validateAppealText / redactSecrets', () => {
  it('bounds the text to 10..2000 characters', () => {
    expect(validateAppealText('short').ok).toBe(false);
    expect(validateAppealText('x'.repeat(2001)).ok).toBe(false);
    expect(validateAppealText('I was not the one who did this.').ok).toBe(true);
    expect(validateAppealText(5).ok).toBe(false);
  });
  it('masks passwords and tokens but leaves ordinary words alone', () => {
    expect(redactSecrets('my password is hunter2 please help')).toBe('my password is [redacted] please help');
    expect(redactSecrets('token: abc.def')).toBe('token: [redacted]');
    expect(redactSecrets('I was hacked on Tuesday')).toBe('I was hacked on Tuesday');
  });
});

describe('addDays', () => {
  it('adds whole days', () => {
    expect(addDays(T0, 14)).toBe('2026-11-15T00:00:00.000Z');
  });
});
