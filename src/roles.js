import { callClaude, extractJson } from './ai.js';

export function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
}

export function addRole(roleData, config) {
  const slug = slugify(roleData.name);
  if (config.roles.find(r => r.slug === slug)) {
    throw new Error(`Role "${slug}" already exists. Use a different name.`);
  }
  const role = {
    slug,
    name: roleData.name,
    responsibilities: roleData.responsibilities,
    excludes: roleData.excludes || '',
    email: roleData.email || '',
    createdAt: new Date().toISOString(),
  };
  return { slug, config: { ...config, roles: [...config.roles, role] } };
}

export async function suggestRoles(workstream, config) {
  const tree = workstream.whys.map(w => `- ${w.text}`).join('\n') || '(no context yet)';

  const prompt = [
    `Based on this project context, suggest 3-5 roles that would benefit from a tailored AI context file.`,
    `Project: ${config.project}`,
    `Context: ${tree}`,
    ``,
    `Return JSON: {"roles": [{"name": "...", "responsibilities": "...", "excludes": "..."}]}`,
    `Focus on roles that make decisions or coordinate across teams. JSON only.`,
  ].join('\n');

  const raw = await callClaude({ prompt, model: config.model });
  const parsed = extractJson(raw);
  return Array.isArray(parsed.roles) ? parsed.roles : [];
}
