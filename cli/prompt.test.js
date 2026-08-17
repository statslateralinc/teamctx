import { describe, it, expect } from 'vitest';
import { maskSecret } from './prompt.js';

describe('maskSecret', () => {
  it('keeps the ends so a value can be recognised', () => {
    expect(maskSecret('abcd1234567890wxyz')).toBe('abcd********wxyz');
  });

  it('never reveals the middle, however long the value', () => {
    const secret = 'sl.u.AF'.padEnd(140, 'x') + 'TAIL';
    const masked = maskSecret(secret);
    expect(masked).not.toContain(secret.slice(6, -6));
    expect(masked.length).toBeLessThan(20);
  });

  it('hides a short value outright', () => {
    // Head-plus-tail would reveal most of a twelve-character string, which is
    // worse than showing nothing at all.
    expect(maskSecret('short')).toBe('********');
    expect(maskSecret('abcdefghijkl')).toBe('********');
  });

  it('shows nothing when there is nothing set', () => {
    expect(maskSecret('')).toBe('');
    expect(maskSecret(undefined)).toBe('');
    expect(maskSecret(null)).toBe('');
  });

  it('reveals at most eight characters of any secret', () => {
    const revealed = maskSecret('0123456789abcdefghijklmnop').replace(/\*/g, '');
    expect(revealed).toHaveLength(8);
  });
});
