import { describe, it, expect, vi, afterEach } from 'vitest';
import { slugifyProjectName, listUserOrgs } from './github.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe('listUserOrgs', () => {
  it('returns the logins of orgs the token can see', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      expect(url).toBe('https://api.github.com/user/orgs');
      return { ok: true, status: 200, json: async () => ([{ login: 'acme-corp', id: 1 }, { login: 'side-project', id: 2 }]) };
    }));
    const orgs = await listUserOrgs('gh-token');
    expect(orgs).toEqual([{ login: 'acme-corp' }, { login: 'side-project' }]);
  });

  it('throws when GitHub returns a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(listUserOrgs('gh-token')).rejects.toThrow(/500/);
  });
});
