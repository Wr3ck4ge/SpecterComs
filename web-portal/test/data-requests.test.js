import { describe, it, expect } from 'vitest';
import { DELETE_CONFIRM_WORD, isDeleteConfirmed } from '../src/components/strip/DataRequestsPanel.jsx';

describe('delete-account confirmation', () => {
  it('requires the exact word (surrounding spaces ignored)', () => {
    expect(isDeleteConfirmed(DELETE_CONFIRM_WORD)).toBe(true);
    expect(isDeleteConfirmed('  DELETE ')).toBe(true);
    expect(isDeleteConfirmed('delete')).toBe(false);
    expect(isDeleteConfirmed('')).toBe(false);
    expect(isDeleteConfirmed(undefined)).toBe(false);
  });
});
