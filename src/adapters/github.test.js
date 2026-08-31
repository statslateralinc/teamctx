import { describe, it, expect, vi, afterEach } from 'vitest';
import { slugifyProjectName, listUserOrgs, createRepo } from './github.js';

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

describe('createRepo', () => {
  it('creates under the personal account when no org is given', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      expect(url).toBe('https://api.github.com/user/repos');
      const body = JSON.parse(opts.body);
      expect(body).toEqual({ name: 'q3-gtm-strategy', description: 'Q3 GTM Strategy', private: true, auto_init: true });
      return { ok: true, status: 201, json: async () => ({ owner: { login: 'alice' }, name: 'q3-gtm-strategy' }) };
    }));
    const result = await createRepo('gh-token', { name: 'q3-gtm-strategy', org: null, description: 'Q3 GTM Strategy' });
    expect(result).toEqual({ owner: 'alice', repo: 'q3-gtm-strategy' });
  });

  it('creates under an org when one is given', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      expect(url).toBe('https://api.github.com/orgs/acme-corp/repos');
      return { ok: true, status: 201, json: async () => ({ owner: { login: 'acme-corp' }, name: 'q3-gtm-strategy' }) };
    }));
    const result = await createRepo('gh-token', { name: 'q3-gtm-strategy', org: 'acme-corp' });
    expect(result).toEqual({ owner: 'acme-corp', repo: 'q3-gtm-strategy' });
  });

  it('throws REPO_EXISTS on a 422 name collision', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ message: 'name already exists on this account' }) })));
    const err = await createRepo('gh-token', { name: 'taken', org: null }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('REPO_EXISTS');
  });

  it('throws REPO_FORBIDDEN on a 403, using GitHub\'s message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ message: 'Must have admin rights to Repository.' }) })));
    const err = await createRepo('gh-token', { name: 'blocked', org: 'locked-org' }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('REPO_FORBIDDEN');
    expect(err.message).toBe('Must have admin rights to Repository.');
  });

  it('throws a plain error for anything else non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const err = await createRepo('gh-token', { name: 'x', org: null }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBeUndefined();
    expect(err.message).toMatch(/500/);
  });
});
