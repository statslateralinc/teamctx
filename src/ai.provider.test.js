import { describe, expect, it, vi, beforeEach } from 'vitest';

const complete = vi.fn(async () => 'ok');
vi.mock('./providers/index.js', () => ({
  getProvider: vi.fn((config) => ({ id: config?.provider || 'anthropic', complete })),
  knownProviderIds: () => ['anthropic', 'openai', 'gemini'],
}));

import { callClaude } from './ai.js';
import { runWithAiKey } from './ai-context.js';

/**
 * A per-user API key (hosted mode) belongs to a specific provider, which need
 * not be the one named in the project's shared config. The key has to win, and
 * the model has to follow it.
 */
describe('callClaude — per-user provider', () => {
  beforeEach(() => complete.mockClear());

  it("uses the project's provider and model when the request carries none", async () => {
    await callClaude({ prompt: 'p', model: 'claude-sonnet-4-6', config: { provider: 'anthropic' } });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-4-6' }));
  });

  it("swaps the model when the caller's key belongs to a different provider", async () => {
    // An OpenAI key must not be sent a Claude model id.
    await runWithAiKey('sk-openai', () => callClaude({
      prompt: 'p', model: 'claude-sonnet-4-6', config: { provider: 'anthropic' },
    }), 'openai');
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4.1-mini' }));
  });

  it("keeps the requested model when it is valid for the caller's provider", async () => {
    await runWithAiKey('sk-openai', () => callClaude({
      prompt: 'p', model: 'gpt-4.1', config: { provider: 'anthropic' },
    }), 'openai');
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4.1' }));
  });

  it('leaves the model alone when request and project providers agree', async () => {
    await runWithAiKey('sk-ant', () => callClaude({
      prompt: 'p', model: 'claude-opus-4-7', config: { provider: 'anthropic' },
    }), 'anthropic');
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-4-7' }));
  });
});
