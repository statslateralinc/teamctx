import { jsonrepair } from 'jsonrepair';
import { getProvider } from './providers/index.js';

export const MODELS_BY_PROVIDER = {
  anthropic: [
    { id: 'claude-opus-4-7', label: 'Opus 4.7 — sharpest' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — balanced' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — fast' },
  ],
  openai: [
    { id: 'gpt-4.1', label: 'GPT-4.1 — sharpest' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini — balanced' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini — fast' },
  ],
};

export const DEFAULT_MODEL_BY_PROVIDER = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4.1-mini',
};

export function getModelsFor(providerId) {
  return MODELS_BY_PROVIDER[providerId] || [];
}

export function getDefaultModelFor(providerId) {
  return DEFAULT_MODEL_BY_PROVIDER[providerId];
}

export const MODELS = MODELS_BY_PROVIDER.anthropic;
export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.anthropic;

export async function callClaude({ prompt, model = DEFAULT_MODEL, system = '', max_tokens = 4096, config }) {
  const provider = getProvider(config);
  return provider.complete({ prompt, model, system, max_tokens });
}

export function extractJson(text) {
  if (!text) throw new Error('Empty response from model');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No JSON object found in response');
  const slice = candidate.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return JSON.parse(jsonrepair(slice));
  }
}

function stripWorkstreamForPrompt(workstream) {
  return {
    name: workstream.name,
    whys: (workstream.whys || []).map(why => ({
      id: why.id,
      text: why.text,
      whats: (why.whats || []).map(what => ({
        id: what.id,
        text: what.text,
        hows: (what.hows || []).map(how => ({ id: how.id, text: how.text })),
      })),
    })),
  };
}

export async function proposeDiff({ workstream, contribution, source, model, config }) {
  const system =
    'You distill a single team contribution into typed edits to a hierarchical ' +
    'Why / What / How record. Output STRICT JSON only — no markdown fences, no commentary.';

  const prompt = [
    `Workstream: "${workstream.name}"`,
    '',
    'Current record (id + text only):',
    JSON.stringify(stripWorkstreamForPrompt(workstream), null, 2),
    '',
    `Contribution (source: ${source}):`,
    `"""${contribution}"""`,
    '',
    'Propose how the record should change. Output STRICT JSON:',
    `{
  "summary": "1-2 sentence description of the change",
  "operations": [
    { "type": "addWhy", "text": "...", "summary": "...",
      "whats": [ { "text": "...", "summary": "...", "hows": [ { "text": "...", "summary": "..." } ] } ] },
    { "type": "addWhat", "parentWhyId": "<existing why id>", "text": "...", "summary": "...",
      "hows": [ { "text": "...", "summary": "..." } ] },
    { "type": "addHow", "parentWhatId": "<existing what id>", "text": "...", "summary": "..." },
    { "type": "editStatement", "id": "<existing id>", "text": "new text", "summary": "..." },
    { "type": "deleteStatement", "id": "<existing id>", "summary": "..." }
  ]
}`,
    '',
    'Rules: Why = 3-8 words action-leaning. What = short phrase. How = specific task.',
    'Use smallest set of ops. Prefer editing over near-duplicate adds.',
    'parentWhyId and parentWhatId MUST exist in the current record. JSON only.',
  ].join('\n');

  const raw = await callClaude({ prompt, model, system, config });
  const parsed = extractJson(raw);
  return {
    summary: String(parsed.summary ?? '(no summary)'),
    operations: Array.isArray(parsed.operations) ? parsed.operations : [],
  };
}
