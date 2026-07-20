import Anthropic from '@anthropic-ai/sdk';

export const id = 'anthropic';

export async function complete({ system = '', prompt, model, max_tokens = 4096 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set. Add it to your .env file or shell environment.');
  }
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model,
    max_tokens,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}
