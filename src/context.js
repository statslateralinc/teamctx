import { proposeDiff, callClaude } from './ai.js';
import { applyOps } from './ops.js';

export function serializeToMd(workstream, projectName, lastUpdatedBy = '') {
  const now = new Date().toISOString().split('T')[0];
  const byLine = lastUpdatedBy ? ` · Source: ${lastUpdatedBy} contribution` : '';
  const header = `# Project Context — ${projectName}\n*Last updated: ${now}${byLine}*\n\n## Why / What / How\n\n`;

  if (!workstream.whys || workstream.whys.length === 0) {
    return header + '*No context yet. Run `teamctx contribute` to add the first contribution.*\n';
  }

  const tree = workstream.whys.map(why => {
    let out = `- **Why:** ${why.text}\n`;
    (why.whats || []).forEach(what => {
      out += `  - **What:** ${what.text}\n`;
      (what.hows || []).forEach(how => { out += `    - **How:** ${how.text}\n`; });
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
  });
  const updated = applyOps(workstream, operations, contribution.id);
  return { workstream: updated, summary, operations };
}

export async function generateRoleFile(workstream, role, projectName, config) {
  const tree = serializeToMd(workstream, projectName);
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

  return callClaude({ prompt, model: config.model });
}

export async function generateReflection(workstream, contributions, config) {
  const tree = serializeToMd(workstream, workstream.name);
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

  return callClaude({ prompt, model: config.model, system, max_tokens: 8192 });
}

export async function answerQuestion({ sharedMd, roleMd, question, config }) {
  const context = [
    roleMd ? `## Your Role Context\n\n${roleMd}` : '',
    sharedMd ? `## Shared Project Context\n\n${sharedMd}` : '',
  ].filter(Boolean).join('\n\n---\n\n');

  const system = 'You are a helpful assistant with access to the team\'s project context. Answer questions based on the context provided. Be concise and specific.';
  const prompt = `Context:\n\n${context}\n\n---\n\nQuestion: ${question}`;

  return callClaude({ prompt, model: config.model, system });
}
