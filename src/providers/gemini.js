import { GoogleGenAI } from '@google/genai';

export const id = 'gemini';

export async function complete({ system = '', prompt, model, max_tokens = 4096 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not set. Add it to your .env file or shell environment.');
  }
  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model,
    contents: prompt,
    config: {
      ...(system ? { systemInstruction: system } : {}),
      maxOutputTokens: max_tokens,
    },
  });
  return (response.text || '').trim();
}
