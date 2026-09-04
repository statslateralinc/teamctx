import { describe, it, expect } from 'vitest';
import { repairDecision, isBrokenGate } from './manager-repair.js';

const GH = { key: 'github:1001', name: 'Ada', login: 'ada' };
const NOBODY = { key: 'name:Ada', name: 'Ada', login: null };
const BOB = { key: 'git:bob@example.com', name: 'Bob', login: null };

describe('deciding whether a manager gate may be repaired', () => {
  it('repairs a display-name gate to the caller', () => {
    const r = repairDecision({ config: { managerKey: 'name:Ada Lovelace' }, actor: GH, displayName: 'Ada Lovelace' });
    expect(r).toMatchObject({ ok: true, from: 'name:Ada Lovelace', to: 'github:1001' });
  });

  it('refuses a gate that actually works', () => {
    // The whole difference between a repair and a backdoor. A real gate must
    // never be replaceable by whoever happens to be calling.
    const r = repairDecision({ config: { managerKey: 'git:someone@else.com' }, actor: GH, displayName: 'Ada' });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/real identity/i);
  });

  it('refuses a github: gate belonging to someone else', () => {
    expect(repairDecision({ config: { managerKey: 'github:9999' }, actor: GH, displayName: 'Ada' }).ok).toBe(false);
  });

  it('refuses when any one of several keys is real', () => {
    // A project that added a working identity alongside the broken one is no
    // longer locked out, so there is nothing to repair — and replacing the pair
    // would drop the key that works.
    const config = { managerKey: 'name:Ada', managerKeys: ['github:1001'] };
    expect(repairDecision({ config, actor: GH, displayName: 'Ada' }).ok).toBe(false);
  });

  it('refuses when there is no gate at all', () => {
    // No gate is the bootstrap case: anyone may approve and the first to pin it
    // wins. Repair would look like it had granted something.
    expect(repairDecision({ config: {}, actor: GH, displayName: 'Ada' }).ok).toBe(false);
  });

  it('refuses a caller who has no stable identity either', () => {
    // Writing a second name: gate would look like it worked and change nothing.
    const r = repairDecision({ config: { managerKey: 'name:Ada' }, actor: NOBODY, displayName: 'Ada' });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/user\.email|another gate/i);
  });

  it('says which gates are broken', () => {
    expect(isBrokenGate({ managerKey: 'name:Ada' })).toBe(true);
    expect(isBrokenGate({ managerKey: 'git:a@b.com' })).toBe(false);
    expect(isBrokenGate({})).toBe(false);
  });
});

describe('who may repair a broken gate', () => {
  const broken = { managerKey: 'name:Ada Lovelace' };

  it('lets the person the gate already names repair it', () => {
    const r = repairDecision({ config: broken, actor: GH, displayName: 'Ada Lovelace' });
    expect(r).toMatchObject({ ok: true, to: 'github:1001' });
  });

  it('refuses somebody else, even though the gate is open to them', () => {
    // The gate being unpassable is not the whole story. Repair converts "anyone
    // may approve" into "only this person may" — so without this, the first
    // person to run it takes the project and locks out the one it names, with
    // no way back through the tool.
    const r = repairDecision({ config: broken, actor: BOB, displayName: 'Bob' });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/belongs to "Ada Lovelace"/);
  });

  it('leaves the gate alone when it refuses', () => {
    // Nothing to assert on the config here — the decision returns no target at
    // all, which is what stops the caller writing one.
    expect(repairDecision({ config: broken, actor: BOB, displayName: 'Bob' }).to).toBeUndefined();
  });

  it('matches the name case-insensitively and ignores surrounding space', () => {
    // The gate holds whatever `config.me` was typed as; a caller should not be
    // refused over capitalisation.
    const r = repairDecision({ config: broken, actor: GH, displayName: '  ada lovelace ' });
    expect(r.ok).toBe(true);
  });

  it('refuses a caller with no name at all', () => {
    expect(repairDecision({ config: broken, actor: GH, displayName: '' }).ok).toBe(false);
  });

  it('says how to proceed if it really is them under another name', () => {
    const r = repairDecision({ config: broken, actor: BOB, displayName: 'Bob' });
    expect(r.why).toMatch(/config name/);
  });
});

describe('recognising the creator from the repository itself', () => {
  const broken = { managerKey: 'name:Ada Lovelace' };
  const ADA = { key: 'git:ada@example.com', name: 'Ada', login: null, email: 'ada@example.com' };
  const BOB = { key: 'git:bob@example.com', name: 'Bob', login: null, email: 'bob@example.com' };
  const HOSTED = { key: 'github:1001', name: 'Ada', login: 'ada', email: null };

  it('recognises the creator even when their name no longer matches the gate', () => {
    // The lockout a name check creates on its own: somebody whose git name is
    // "Ada" repairing a gate that reads "Ada Lovelace" is the same person.
    const r = repairDecision({
      config: broken, actor: ADA, displayName: 'Ada', creatorEmail: 'ada@example.com',
    });
    expect(r).toMatchObject({ ok: true, to: 'git:ada@example.com' });
  });

  it('refuses somebody who is not the creator', () => {
    const r = repairDecision({
      config: broken, actor: BOB, displayName: 'Bob', creatorEmail: 'ada@example.com',
    });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/ada@example\.com created this project/);
  });

  it('does not let a rename walk past the history', () => {
    // The reason history is consulted first. A display name is settable, so if
    // it could override the stronger signal the stronger signal is decorative.
    const r = repairDecision({
      config: broken, actor: BOB, displayName: 'Ada Lovelace', creatorEmail: 'ada@example.com',
    });
    expect(r.ok).toBe(false);
  });

  it("matches a web-created project's noreply author against a GitHub identity", () => {
    // The web flow commits as <id>+<login>@users.noreply.github.com, so the
    // creator returning as github:<id> has to be unpacked rather than compared
    // whole — otherwise they fail to match a commit they themselves authored.
    const r = repairDecision({
      config: broken, actor: HOSTED, displayName: 'Ada',
      creatorEmail: '1001+ada@users.noreply.github.com',
    });
    expect(r).toMatchObject({ ok: true, to: 'github:1001' });
  });

  it('falls back to the name when there is no history to read', () => {
    // A shallow clone, or a rewritten history. The weaker check is better than
    // refusing everybody.
    const r = repairDecision({
      config: broken, actor: ADA, displayName: 'Ada Lovelace', creatorEmail: null,
    });
    expect(r.ok).toBe(true);
  });

  it('says so when neither signal identifies anyone', () => {
    const r = repairDecision({
      config: broken, actor: BOB, displayName: 'Bob', creatorEmail: null,
    });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/history does not say/i);
  });
});

describe('the manager coming back over a chat client', () => {
  // Everything about locking somebody out matters most here: over MCP there is
  // no clone to fall back on and no file to hand-edit.
  const broken = { managerKey: 'name:Satyagya Singh' };
  const NO_EMAIL = { key: 'github:123818561', name: 'Satyagya Singh', login: 'satyagyasingh', email: null };
  const WITH_EMAIL = { ...NO_EMAIL, email: 'satyagyasingh@gmail.com' };
  const BOB = { key: 'github:999', name: 'Bob', login: 'bob', email: 'bob@example.com' };

  it('recognises them from a web-created noreply commit without any email', () => {
    // The web flow commits as <id>+<login>@users.noreply.github.com, which
    // names the account outright — so a token with no email scope still matches.
    const r = repairDecision({
      config: broken, actor: NO_EMAIL, displayName: 'Satyagya Singh',
      creatorEmail: '123818561+satyagyasingh@users.noreply.github.com',
    });
    expect(r.ok).toBe(true);
  });

  it('does not refuse them when their token simply cannot say who they are', () => {
    // A plain address in the history and no address on the token is *unknown*,
    // not a mismatch. Treating it as one locked the creator out of their own
    // project over the one surface where they cannot edit the file instead.
    const r = repairDecision({
      config: broken, actor: NO_EMAIL, displayName: 'Satyagya Singh',
      creatorEmail: 'satyagyasingh@gmail.com',
    });
    expect(r.ok).toBe(true);
  });

  it('still refuses somebody the history positively rules out', () => {
    const r = repairDecision({
      config: broken, actor: BOB, displayName: 'Bob', creatorEmail: 'satyagyasingh@gmail.com',
    });
    expect(r.ok).toBe(false);
  });

  it('refuses a stranger even when the token cannot be compared, if the name differs', () => {
    // "Cannot tell" falls back to the name — it does not wave everybody through.
    const stranger = { key: 'github:999', name: 'Bob', login: 'bob', email: null };
    const r = repairDecision({
      config: broken, actor: stranger, displayName: 'Bob', creatorEmail: 'satyagyasingh@gmail.com',
    });
    expect(r.ok).toBe(false);
  });

  it('uses the token email when it has one', () => {
    const r = repairDecision({
      config: broken, actor: WITH_EMAIL, displayName: 'anything at all',
      creatorEmail: 'satyagyasingh@gmail.com',
    });
    expect(r.ok).toBe(true);
  });
});

describe('what the repaired gate is pinned to', () => {
  // The whole point of #71 was that a gate has to be presentable on every
  // surface. Repairing to `github:<id>` rebuilds the single-surface gate it
  // removed, and the same person signing in with Google is locked out again.
  const broken = { managerKey: 'name:Satyagya Singh' };
  const hosted = {
    key: 'github:123818561', name: 'Satyagya Singh',
    login: 'satyagyasingh', email: 'satyagyasingh@gmail.com',
  };

  it('pins the email, not the numeric id, when the caller has one', () => {
    const r = repairDecision({
      config: broken, actor: hosted, displayName: 'Satyagya Singh',
      creatorEmail: 'satyagyasingh@gmail.com',
    });
    expect(r.to).toBe('git:satyagyasingh@gmail.com');
    expect(r.to).not.toMatch(/^github:/);
  });

  it('falls back to the id only when no email is available', () => {
    const noEmail = { ...hosted, email: null };
    const r = repairDecision({
      config: broken, actor: noEmail, displayName: 'Satyagya Singh',
      creatorEmail: '123818561+satyagyasingh@users.noreply.github.com',
    });
    expect(r.to).toBe('github:123818561');
  });

  it('says so when it could only pin an id', () => {
    // Half a fix that looks like a whole one is worse than the error it
    // replaced — the gate works where it was set and nowhere else.
    const noEmail = { ...hosted, email: null };
    const r = repairDecision({
      config: broken, actor: noEmail, displayName: 'Satyagya Singh',
      creatorEmail: '123818561+satyagyasingh@users.noreply.github.com',
    });
    expect(r.warning).toMatch(/Google sign-in/);
  });

  it('says nothing extra when the email was pinned', () => {
    const r = repairDecision({
      config: broken, actor: hosted, displayName: 'Satyagya Singh',
      creatorEmail: 'satyagyasingh@gmail.com',
    });
    expect(r.warning).toBeUndefined();
  });
});
