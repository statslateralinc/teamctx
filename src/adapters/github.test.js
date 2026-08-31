import { describe, it, expect } from 'vitest';
import { slugifyProjectName } from './github.js';

describe('slugifyProjectName', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugifyProjectName('Q3 GTM Strategy')).toBe('q3-gtm-strategy');
  });

  it('collapses repeated separators', () => {
    expect(slugifyProjectName('  Multiple   Spaces  ')).toBe('multiple-spaces');
  });

  it('strips punctuation instead of keeping it', () => {
    expect(slugifyProjectName('Special!!Chars??')).toBe('special-chars');
  });

  it('falls back to "project" for empty or all-punctuation input', () => {
    expect(slugifyProjectName('')).toBe('project');
    expect(slugifyProjectName('!!!')).toBe('project');
    expect(slugifyProjectName(undefined)).toBe('project');
  });

  it('leaves an already-valid slug alone', () => {
    expect(slugifyProjectName('already-slugged')).toBe('already-slugged');
  });
});
