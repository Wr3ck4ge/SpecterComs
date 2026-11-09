import { describe, it, expect } from 'vitest';
import { fmtDateTime, fmtDate } from '../src/components/admin/ui.jsx';

// fmtDateTime once combined dateStyle/timeStyle with timeZoneName, which Intl
// rejects with a TypeError — every admin section with a timestamp row then
// crashed into its SectionBoundary ("This section failed to render").
describe('admin date formatting', () => {
  it('formats a timestamp without throwing', () => {
    const out = fmtDateTime('2026-10-29T21:30:00Z');
    expect(typeof out).toBe('string');
    expect(out).not.toBe('—');
    expect(out).toMatch(/2026/);
  });

  it('formats dates and handles empty or invalid input', () => {
    expect(fmtDate('2026-10-29T21:30:00Z')).toMatch(/2026/);
    expect(fmtDateTime(null)).toBe('—');
    expect(fmtDateTime('not a date')).toBe('—');
  });
});
