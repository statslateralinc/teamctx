import { describe, it, expect } from 'vitest';
import { sourceNote } from './init.core.js';

describe('sourceNote', () => {
  it('flags an MCP-originated init', () => {
    expect(sourceNote('mcp')).toBe(' (via mcp)');
  });

  it('flags a web-onboarding-originated init', () => {
    expect(sourceNote('web')).toBe(' (via web onboarding)');
  });

  it('adds no note for the default CLI source', () => {
    expect(sourceNote('cli')).toBe('');
    expect(sourceNote(undefined)).toBe('');
  });
});
