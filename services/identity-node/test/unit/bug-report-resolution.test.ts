import { describe, it, expect } from 'vitest';
import { cleanResolution, RESOLUTION_MAX } from '../../src/utils/bugReport.js';

// The owner's reply to a reporter: plain text, cleaned before it is stored.

describe('cleanResolution', () => {
  it('keeps plain text, newlines and tabs; trims', () => {
    expect(cleanResolution('  Fixed in 2.1.1.\r\nSync your clock.\tThanks  ')).toBe('Fixed in 2.1.1.\nSync your clock.\tThanks');
  });

  it('strips control, bidi and zero-width characters', () => {
    expect(cleanResolution('a\u0000b‮c​d﻿e\u0007')).toBe('abcde');
  });

  it('treats empty, whitespace and null as clearing the reply', () => {
    expect(cleanResolution(null)).toBeNull();
    expect(cleanResolution(undefined)).toBeNull();
    expect(cleanResolution('   \n ')).toBeNull();
  });

  it('rejects non-strings and over-long text', () => {
    expect(cleanResolution(42)).toBeUndefined();
    expect(cleanResolution({ text: 'x' })).toBeUndefined();
    expect(cleanResolution('x'.repeat(RESOLUTION_MAX))).toHaveLength(RESOLUTION_MAX);
    expect(cleanResolution('x'.repeat(RESOLUTION_MAX + 1))).toBeUndefined();
  });

  it('NFC-normalises', () => {
    expect(cleanResolution('é')).toBe('é');
  });
});
