import { proposeDiff, callClaude, extractJson } from './ai.js';
import { applyOps } from './ops.js';

function decisionMarker(node, contributionsById) {
  const ids = node.sourceContributionIds || [];
  let latest = null;
  for (const id of ids) {
    const c = contributionsById.get(id);
    if (c && c.tagged === 'decision') {
      if (!latest || (c.ts || '') > (latest.ts || '')) latest = c;
    }
  }
  if (!latest) return '';
  const date = (latest.ts || '').split('T')[0] || 'unknown';
  const author = latest.author || 'unknown';
  const source = latest.source || 'cli';
  return `  *[decision — ${author}, ${date}, via ${source}]*`;
}

export function serializeToMd(workstream, projectName, lastUpdatedBy = '', contributions = []) {
  const now = new Date().toISOString().split('T')[0];
  const byLine = lastUpdatedBy ? ` · Source: ${lastUpdatedBy} contribution` : '';
  const header = `# Project Context — ${projectName}\n*Last updated: ${now}${byLine}*\n\n## Why / What / How\n\n`;

  if (!workstream.whys || workstream.whys.length === 0) {
    return header + '*No context yet. Run `teamctx contribute` to add the first contribution.*\n';
  }

  const contributionsById = new Map(contributions.map(c => [c.id, c]));

  const tree = workstream.whys.map(why => {
    let out = `- **Why:** ${why.text}${decisionMarker(why, contributionsById)}\n`;
    (why.whats || []).forEach(what => {
      out += `  - **What:** ${what.text}${decisionMarker(what, contributionsById)}\n`;
      (what.hows || []).forEach(how => {
        out += `    - **How:** ${how.text}${decisionMarker(how, contributionsById)}\n`;
      });
    });
    return out;
  }).join('');

  return header + tree;
}

export async function updateShared(workstream, contribution, config) {
  const { summary, operations } = await proposeDiff({
    workstream,
    contribution: contribution.text,
    source: contribution.author,
    model: config.model,
    config,
  });
  const updated = applyOps(workstream, operations, contribution.id);
  return { workstream: updated, summary, operations };
}

export async function generateRoleFile(workstream, role, projectName, config, contributions = []) {
  const tree = serializeToMd(workstream, projectName, '', contributions);
  const now = new Date().toISOString().split('T')[0];

  const prompt = [
    `Generate a role-specific context file for a team member.`,
    `Project: ${projectName}  Date: ${now}`,
    ``,
    `Full project context (Why/What/How tree):`,
    tree,
    ``,
    `Role: ${role.name}`,
    `Responsibilities: ${role.responsibilities}`,
    role.excludes ? `Does NOT need to know about: ${role.excludes}` : '',
    ``,
    `Generate a markdown file with EXACTLY these four sections:`,
    ``,
    `# ${role.name} Context — ${projectName}`,
    `*Last updated: ${now}*`,
    ``,
    `## Your Role`,
    `[who you are, what you own, what to ignore]`,
    ``,
    `## Your Why / What / How`,
    `[filter and reframe the project tree for this role — same facts, different perspective]`,
    `[IMPORTANT: preserve any inline "*[decision — author, date, via source]*" markers verbatim on the same line as the statement they annotate. They mark human decisions and must survive the rewrite.]`,
    ``,
    `## Open Decisions (Yours to Make)`,
    `[items where this role is the decision owner — write "None currently." if none]`,
    ``,
    `## How to Use This File`,
    `Paste into your CLAUDE.md, or use as system context in ChatGPT / Gemini.`,
    `Starter prompt: "Based on my context, help me [describe what you're working on]."`,
    ``,
    `Return ONLY the markdown content.`,
  ].filter(Boolean).join('\n');

  return callClaude({ prompt, model: config.model, config });
}

export async function generateReflection(workstream, contributions, config) {
  const tree = serializeToMd(workstream, workstream.name, '', contributions);
  const recent = contributions.slice(-20).map(c => `- ${c.author}: "${c.text}"`).join('\n') || '(none yet)';
  const system = 'You are improving a team context record. Output STRICT JSON only — no markdown fences.';

  const prompt = [
    `Review this project Why/What/How context and recent contributions. Return an improved version.`,
    ``,
    `Current context:`,
    tree,
    ``,
    `Recent contributions (${Math.min(20, contributions.length)} most recent):`,
    recent,
    ``,
    `Return updated workstream JSON with this exact shape:`,
    JSON.stringify({ name: workstream.name, whys: workstream.whys }, null, 2),
    ``,
    `Improvements: remove stale items, sharpen vague Whys (3-8 words), consolidate near-duplicates.`,
    `Preserve ALL existing ids on nodes you keep. JSON only.`,
  ].join('\n');

  return callClaude({ prompt, model: config.model, system, max_tokens: 8192, config });
}

export async function proposeSubworkstreams(workstream, config, roles = []) {
  const whys = workstream.whys || [];
  if (whys.length < 2) {
    return { splits: [], leftover: whys.map(w => w.id), rationale: 'Not enough Why nodes to cluster.' };
  }

  const tree = whys.map(w => {
    const whats = (w.whats || []).map(t => `    - What: ${t.text}`).join('\n');
    return `- id=${w.id} — Why: ${w.text}${whats ? '\n' + whats : ''}`;
  }).join('\n');

  const roleHints = roles.length
    ? roles.map(r => `- ${r.name}: ${r.responsibilities}`).join('\n')
    : '(no roles defined)';

  const system =
    'You cluster distinct threads in a shared team Why/What/How context tree. ' +
    'Two threads are "distinct" when the roles that care about them barely overlap ' +
    '(e.g. product-strategy vs. engineering-implementation). Output STRICT JSON only.';

  const prompt = [
    `Project: ${config.project || workstream.name || 'project'}`,
    '',
    'Current workstream Why nodes (id + text, optional Whats for context):',
    tree,
    '',
    'Roles on this team (their responsibilities are hints for what natural clusters look like):',
    roleHints,
    '',
    'Return STRICT JSON with this exact shape:',
    `{
  "splits": [
    { "name": "Short 2-4 word name", "rationale": "one-sentence why these belong together", "whyIds": ["<id>", "<id>"] }
  ],
  "leftover": ["<why id that fits neither cluster>"]
}`,
    '',
    'Rules:',
    '- Propose 0-4 splits. 0 is valid — output empty splits if no clean split exists.',
    '- whyIds MUST be disjoint across splits AND leftover; every Why id appears at most once.',
    '- Only use ids that exist in the tree above.',
    '- A single cluster with all whys is NOT a useful split — omit it.',
    '- Names are 2-4 words, capitalized (e.g. "Product Strategy", "Tech Migration").',
    'JSON only, no markdown fences.',
  ].join('\n');

  const raw = await callClaude({ prompt, model: config.model, system });
  const parsed = extractJson(raw);
  return normalizeSubworkstreamProposal(parsed, whys);
}

export function normalizeSubworkstreamProposal(parsed, whys) {
  const knownIds = new Set(whys.map(w => w.id));
  const seen = new Set();
  const splits = [];
  for (const raw of Array.isArray(parsed.splits) ? parsed.splits : []) {
    const name = String(raw.name || '').trim();
    const rationale = String(raw.rationale || '').trim();
    const whyIds = (Array.isArray(raw.whyIds) ? raw.whyIds : [])
      .filter(id => knownIds.has(id) && !seen.has(id));
    whyIds.forEach(id => seen.add(id));
    if (name && whyIds.length > 0) splits.push({ name, rationale, whyIds });
  }

  const claimed = new Set(splits.flatMap(s => s.whyIds));
  const leftover = whys.map(w => w.id).filter(id => !claimed.has(id));
  return { splits, leftover };
}

export async function answerQuestion({ sharedMd, roleMd, question, config }) {
  const context = [
    roleMd ? `## Your Role Context\n\n${roleMd}` : '',
    sharedMd ? `## Shared Project Context\n\n${sharedMd}` : '',
  ].filter(Boolean).join('\n\n---\n\n');

  const system = [
    'You are a helpful assistant with access to the team\'s project context.',
    'Answer questions based on the context provided. Be concise and specific.',
    'When the context shows an inline "*[decision — author, date, via source]*" marker on a statement, treat that statement as a canonical human decision. If your answer relies on it, cite it inline like "(decision — author, date)". If the context contains conflicting statements and one is a decision, prefer the decision.',
  ].join(' ');
  const prompt = `Context:\n\n${context}\n\n---\n\nQuestion: ${question}`;

  return callClaude({ prompt, model: config.model, system, config });
}
