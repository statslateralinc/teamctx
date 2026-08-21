import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// A fake connector, so the shared login machinery is tested without depending
// on whichever real ones happen to be registered. That is also the honest
// boundary: nothing here should know what Dropbox or Drive need.
const fake = {
  name: 'fakebox',
  describe: 'a connector that exists only in this file',
  auth: () => ({ ok: false, help: 'set FAKE_TOKEN' }),
  list: async () => ({ items: [], skipped: [] }),
  fetch: async () => ({ id: 'x', text: '' }),
  authorize: async ({ ask, askSecret, loopback, log }) => {
    log?.('setup instructions');
    const values = { FAKE_KEY: await ask('Key'), FAKE_SECRET: await askSecret('Secret') };
    // Providers that dropped the paste-a-code flow need a listener; the
    // connector never builds one itself.
    if (loopback) values.FAKE_CODE = (await loopback({ buildUrl: uri => uri })).code;
    return values;
  },
};

vi.mock('../../src/connectors/index.js', async importOriginal => {
  const real = await importOriginal();
  const registry = { fakebox: fake, folder: { name: 'folder', describe: 'local files' } };
  return {
    ...real,
    getConnector: name => {
      const c = registry[String(name || '').toLowerCase()];
      if (!c) throw new real.UnknownConnectorError(name);
      return c;
    },
    listConnectors: () => Object.values(registry).map(c => ({ name: c.name, describe: c.describe })),
  };
});

const {
  upsertEnv, authorizeConnector, connectorsWithAuthorize, NoAuthorizeError,
} = await import('./auth.core.js');
const { UnknownConnectorError } = await import('../../src/connectors/index.js');

describe('upsertEnv', () => {
  it('adds values to an empty file', () => {
    expect(upsertEnv('', { A: '1', B: '2' })).toBe('A=1\nB=2\n');
  });

  it('replaces a key in place, keeping its position', () => {
    expect(upsertEnv('A=old\nB=keep\n', { A: 'new' })).toBe('A=new\nB=keep\n');
  });

  it('keeps everything it was not asked to change', () => {
    // The normal case is a provider key already living in this file, so
    // rewriting it from the new values alone would be a data-loss bug on first
    // use of the command.
    const before = '# my keys\nANTHROPIC_API_KEY=sk-ant-123\n\nOTHER=x\n';
    const after = upsertEnv(before, { FAKE_SECRET: 'r1' });
    expect(after).toContain('ANTHROPIC_API_KEY=sk-ant-123');
    expect(after).toContain('# my keys');
    expect(after).toContain('OTHER=x');
    expect(after).toContain('FAKE_SECRET=r1');
  });

  it('understands the export prefix people write', () => {
    expect(upsertEnv('export A=old\n', { A: 'new' })).toBe('A=new\n');
  });

  it('does not match a key that merely shares a prefix', () => {
    const after = upsertEnv('FAKE_KEY_OLD=x\n', { FAKE_KEY: 'new' });
    expect(after).toContain('FAKE_KEY_OLD=x');
    expect(after).toContain('FAKE_KEY=new');
  });

  it('separates appended values from existing content', () => {
    expect(upsertEnv('A=1\n', { B: '2' })).toBe('A=1\n\nB=2\n');
  });

  it('always ends with a newline', () => {
    expect(upsertEnv('A=1', { B: '2' })).toMatch(/\n$/);
  });

  it('handles a file with CRLF line endings', () => {
    expect(upsertEnv('A=old\r\nB=keep\r\n', { A: 'new' })).toContain('A=new');
  });
});

describe('authorizeConnector', () => {
  let cwd;
  const envPath = () => join(cwd, '.env.local');
  const answers = list => { const q = [...list]; return async () => q.shift() ?? ''; };

  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'teamctx-auth-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('writes what the connector returns', async () => {
    const r = await authorizeConnector({
      from: 'fakebox', cwd, env: {}, ask: answers(['k1', 's1']),
    });
    expect(r.keys).toEqual(['FAKE_KEY', 'FAKE_SECRET']);
    expect(readFileSync(envPath(), 'utf-8')).toContain('FAKE_KEY=k1');
  });

  it('preserves an existing env file', async () => {
    writeFileSync(envPath(), 'ANTHROPIC_API_KEY=sk-ant-keepme\n');
    await authorizeConnector({ from: 'fakebox', cwd, env: {}, ask: answers(['k', 's']) });
    expect(readFileSync(envPath(), 'utf-8')).toContain('ANTHROPIC_API_KEY=sk-ant-keepme');
  });

  it('reports which values it replaced, so re-running is not silent', async () => {
    writeFileSync(envPath(), 'FAKE_SECRET=old\n');
    const r = await authorizeConnector({ from: 'fakebox', cwd, env: {}, ask: answers(['k', 'new']) });
    expect(r.replaced).toEqual(['FAKE_SECRET']);
  });

  it('returns names and never values, since the caller prints them', async () => {
    // A credential that reaches a terminal is in scrollback and shell history,
    // which would undo writing it to a 0600 file.
    const r = await authorizeConnector({
      from: 'fakebox', cwd, env: {}, ask: answers(['k', 'super-secret']),
    });
    expect(JSON.stringify(r)).not.toContain('super-secret');
  });

  it('passes a separate masking prompt through to the connector', async () => {
    const plain = [];
    const masked = [];
    await authorizeConnector({
      from: 'fakebox', cwd, env: {},
      ask: async q => { plain.push(q); return 'k'; },
      askSecret: async q => { masked.push(q); return 's'; },
    });
    expect(plain).toEqual(['Key']);
    expect(masked).toEqual(['Secret']);
  });

  it('falls back to the plain prompt when no masking one is given', async () => {
    const r = await authorizeConnector({ from: 'fakebox', cwd, env: {}, ask: answers(['k', 's']) });
    expect(r.keys).toContain('FAKE_SECRET');
  });

  it('hands the loopback listener to connectors that need one', async () => {
    // Google removed the paste-a-code flow, so Drive cannot do what Dropbox
    // does. The listener is shared rather than built inside a connector.
    const r = await authorizeConnector({
      from: 'fakebox', cwd, env: {}, ask: answers(['k', 's']),
      loopback: async ({ buildUrl }) => ({ code: `code-for-${buildUrl('http://127.0.0.1:1')}` }),
    });
    expect(readFileSync(envPath(), 'utf-8')).toContain('FAKE_CODE=code-for-http://127.0.0.1:1');
  });

  it('writes nothing when the flow fails', async () => {
    const boom = { ...fake, authorize: async () => { throw new Error('code rejected'); } };
    const mod = await import('../../src/connectors/index.js');
    vi.spyOn(mod, 'getConnector').mockReturnValue(boom);

    await expect(authorizeConnector({ from: 'fakebox', cwd, ask: answers([]) }))
      .rejects.toThrow(/code rejected/);
    expect(existsSync(envPath()), 'a failed login must not leave a file behind').toBe(false);
  });

  it('refuses a flow that returns nothing rather than writing an empty file', async () => {
    const empty = { ...fake, authorize: async () => ({}) };
    const mod = await import('../../src/connectors/index.js');
    vi.spyOn(mod, 'getConnector').mockReturnValue(empty);

    await expect(authorizeConnector({ from: 'fakebox', cwd, ask: answers([]) }))
      .rejects.toThrow(/returned no credentials/);
  });

  it('says so when a connector has no login flow', async () => {
    await expect(authorizeConnector({ from: 'folder', cwd, ask: answers([]) }))
      .rejects.toThrow(NoAuthorizeError);
    // and points at the ones that do
    await expect(authorizeConnector({ from: 'folder', cwd, ask: answers([]) }))
      .rejects.toThrow(/fakebox/);
  });

  it('rejects an unknown connector', async () => {
    await expect(authorizeConnector({ from: 'nope', cwd, ask: answers([]) }))
      .rejects.toThrow(UnknownConnectorError);
  });

  it('can be pointed at a different file', async () => {
    await authorizeConnector({
      from: 'fakebox', cwd, env: {}, envFile: '.env.test', ask: answers(['k', 's']),
    });
    expect(existsSync(join(cwd, '.env.test'))).toBe(true);
  });
});

describe('connectorsWithAuthorize', () => {
  it('lists only the connectors that can log in', () => {
    const names = connectorsWithAuthorize();
    expect(names).toContain('fakebox');
    // The filesystem is already there; there is nothing to log in to.
    expect(names).not.toContain('folder');
  });
});
