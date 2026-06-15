import { describe, it, expect, vi } from 'vitest';
import { addRole, slugify } from './roles.js';

vi.mock('./ai.js', () => ({ callClaude: vi.fn(), extractJson: vi.fn() }));

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('Chief Product Officer')).toBe('chief-product-officer');
  });
  it('removes special characters', () => {
    expect(slugify('VP of Eng!')).toBe('vp-of-eng');
  });
  it('collapses multiple spaces', () => {
    expect(slugify('EA  to  CEO')).toBe('ea-to-ceo');
  });
});

describe('addRole', () => {
  const config = { project: 'Demo', model: 'claude-sonnet-4-6', autoPush: false, me: 'alice', roles: [] };

  it('adds a role and returns the slug and updated config', () => {
    const role = { name: 'CPO', responsibilities: 'Product decisions', excludes: 'Tech impl' };
    const { slug, config: updated } = addRole(role, config);
    expect(slug).toBe('cpo');
    expect(updated.roles).toHaveLength(1);
    expect(updated.roles[0].slug).toBe('cpo');
    expect(updated.roles[0].name).toBe('CPO');
    expect(updated.roles[0].createdAt).toBeDefined();
  });

  it('throws when slug already exists', () => {
    const existing = { ...config, roles: [{ slug: 'cpo', name: 'CPO', responsibilities: '', excludes: '', createdAt: '' }] };
    expect(() => addRole({ name: 'CPO', responsibilities: 'dup' }, existing)).toThrow(/already exists/i);
  });
});
