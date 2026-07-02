import { readConfig, readSharedMd, readRoleFile } from '../src/storage.js';
import { answerQuestion } from '../src/context.js';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function roleOptions(roles, selected) {
  const opts = ['<option value="">General (no specific role)</option>']
    .concat(roles.map(r => `<option value="${esc(r.slug)}"${r.slug === selected ? ' selected' : ''}>${esc(r.name)}</option>`));
  return opts.join('\n    ');
}

function renderPage({ project, roles, selectedRole = '', question = '', answer = '' }) {
  project = esc(project);
  const qa = answer
    ? `<p><strong>Q: ${esc(question)}</strong></p><div class="answer">${esc(answer)}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Ask — ${project}</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#1a1a1a}
    h1{font-size:1.4rem;margin-bottom:4px}p{color:#555;margin-bottom:24px}
    label{display:block;font-weight:500;margin-bottom:6px}
    input,textarea,select{width:100%;box-sizing:border-box;padding:10px 12px;font-size:1rem;border:1px solid #ccc;border-radius:6px;margin-bottom:16px}
    textarea{height:120px;resize:vertical;font-family:inherit}
    button{background:#1a1a1a;color:white;border:none;padding:10px 24px;font-size:1rem;border-radius:6px;cursor:pointer}
    button:hover{background:#333}
    .answer{background:#f5f5f5;border-radius:6px;padding:16px;margin-bottom:24px;white-space:pre-wrap}
  </style>
</head>
<body>
  <h1>${project}</h1>
  <p>Ask a question grounded in the team's shared context.</p>
  ${qa}
  <form method="POST">
    <label for="question">Your question</label>
    <textarea id="question" name="question" placeholder="e.g. What's our plan for the Q3 launch?" required></textarea>
    <label for="role">Ask as (optional)</label>
    <select id="role" name="role">
    ${roleOptions(roles, selectedRole)}
    </select>
    <button type="submit">Ask</button>
  </form>
</body></html>`;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    let project = 'Team', roles = [];
    try {
      const config = readConfig();
      project = config.project || project;
      roles = config.roles || [];
    } catch { /* not initialized yet — render a minimal form */ }

    res.setHeader('Content-Type', 'text/html');
    res.send(renderPage({ project, roles }));
    return;
  }

  if (req.method === 'POST') {
    let config;
    try {
      config = readConfig();
    } catch {
      res.status(500).send('teamctx is not initialized on this server.');
      return;
    }

    const { question, role } = req.body || {};
    if (!question?.trim()) { res.status(400).send('Question is required.'); return; }

    let roleSlug = '', roleMd = '';
    if (role) {
      if (!/^[a-z0-9-]+$/.test(role) || !config.roles.some(r => r.slug === role)) {
        res.status(400).send('Unknown role.');
        return;
      }
      roleSlug = role;
      try { roleMd = readRoleFile(roleSlug); } catch { /* role file not generated yet */ }
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      res.status(500).send('AI not configured on this server.');
      return;
    }

    const sharedMd = readSharedMd();

    let answer;
    try {
      answer = await answerQuestion({ sharedMd, roleMd, question: question.trim(), config });
    } catch (err) {
      console.error('Ask error:', err.message);
      res.status(500).send('AI request failed. Please try again.');
      return;
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(renderPage({ project: config.project, roles: config.roles, selectedRole: roleSlug, question: question.trim(), answer }));
    return;
  }

  res.status(405).send('Method not allowed.');
}
