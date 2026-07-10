import OpenAI from 'openai';

export const id = 'openai';

export async function complete({ system = '', prompt, model, max_tokens = 4096 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set. Add it to your .env file or shell environment.');
  }
  const client = new OpenAI({ apiKey });
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const response = await client.chat.completions.create({
    model,
    max_completion_tokens: max_tokens,
    messages,
  });
  return (response.choices[0]?.message?.content || '').trim();
}
