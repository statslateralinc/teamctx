import { describe, it, expect, vi, beforeEach } from 'vitest';
import { serializeToMd, updateShared, generateRoleFile, answerQuestion } from './context.js';

vi.mock('./ai.js', () => ({
  proposeDiff: vi.fn(),
  callClaude: vi.fn(),
}));
vi.mock('./ops.js', () => ({
  applyOps: vi.fn((ws) => ({ ...ws, _applied: true })),
}));

import { proposeDiff, callClaude } from './ai.js';

const baseWs = {
  id: 'main', name: 'Q3 Launch',
  whys: [{
    id: 'w1', text: 'Ship product by Q3', sourceContributionIds: ['c0'], summary: '',
    whats: [{
      id: 'w1-wh1', text: 'Build onboarding', sourceContributionIds: ['c0'], summary: '',
      hows: [{ id: 'w1-wh1-h1', text: 'Wire sign-up form', sourceContributionIds: ['c0'], summary: '' }],
    }],
  }],
};

describe('serializeToMd', () => {
  it('renders the Why/What/How tree', () => {
    const md = serializeToMd(baseWs, 'Q3 Launch');
    expect(md).toContain('# Project Context — Q3 Launch');
    expect(md).toContain('**Why:** Ship product by Q3');
    expect(md).toContain('**What:** Build onboarding');
    expect(md).toContain('**How:** Wire sign-up form');
  });

  it('renders placeholder when whys is empty', () => {
    const md = serializeToMd({ ...baseWs, whys: [] }, 'Empty');
    expect(md).toContain('No context yet');
  });

  it('includes lastUpdatedBy in the header when provided', () => {
    const md = serializeToMd(baseWs, 'Q3 Launch', 'cto');
    expect(md).toContain('cto');
  });
});

describe('updateShared', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls proposeDiff with the contribution text and applies ops', async () => {
    proposeDiff.mockResolvedValue({ summary: 'added goal', operations: [{ type: 'addWhy', text: 'x', summary: '' }] });
    const contribution = { id: 'c1', author: 'alice', text: 'new idea' };
    const config = { model: 'claude-sonnet-4-6' };
    const { workstream, summary } = await updateShared(baseWs, contribution, config);
    expect(proposeDiff).toHaveBeenCalledWith(expect.objectContaining({ contribution: 'new idea' }));
    expect(summary).toBe('added goal');
    expect(workstream._applied).toBe(true);
  });
});

describe('generateRoleFile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls callClaude and returns the result', async () => {
    callClaude.mockResolvedValue('# CPO Context\n\n## Your Role\n...');
    const role = { name: 'CPO', responsibilities: 'Product decisions', excludes: 'Tech impl' };
    const result = await generateRoleFile(baseWs, role, 'Q3 Launch', { model: 'claude-sonnet-4-6' });
    expect(callClaude).toHaveBeenCalledOnce();
    expect(result).toContain('# CPO Context');
  });
});

describe('answerQuestion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls callClaude with shared and role context, returns the answer', async () => {
    callClaude.mockResolvedValue('The launch date is Q3.');
    const result = await answerQuestion({
      sharedMd: '# Shared\n\nWe are launching in Q3.',
      roleMd: '# CPO Context\n\nYou own product strategy.',
      question: 'When do we launch?',
      config: { model: 'claude-sonnet-4-6' },
    });
    expect(callClaude).toHaveBeenCalledOnce();
    const call = callClaude.mock.calls[0][0];
    expect(call.model).toBe('claude-sonnet-4-6');
    expect(call.prompt).toContain('We are launching in Q3.');
    expect(call.prompt).toContain('You own product strategy.');
    expect(call.prompt).toContain('When do we launch?');
    expect(result).toBe('The launch date is Q3.');
  });

  it('omits the role context section when roleMd is empty', async () => {
    callClaude.mockResolvedValue('answer');
    await answerQuestion({
      sharedMd: '# Shared\n\ncontext',
      roleMd: '',
      question: 'q?',
      config: { model: 'claude-sonnet-4-6' },
    });
    const call = callClaude.mock.calls[0][0];
    expect(call.prompt).not.toContain('Your Role Context');
  });
});
