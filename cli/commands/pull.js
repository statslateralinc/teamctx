import { ask } from '../prompt.js';
import { readConfig } from '../../src/storage.js';
import { contributeCommand } from './contribute.js';

function getGitHubEnv() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    throw new Error(
      'GITHUB_TOKEN and GITHUB_REPO must be set in .env.local\n' +
      'Copy them from your Vercel project env vars.'
    );
  }
  return { token, repo };
}

async function ghRequest(path, method = 'GET', body = null, token) {
  const res = await fetch(`https://api.github.com/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res;
}

export async function pullCommand() {
  let token, repo;
  try { ({ token, repo } = getGitHubEnv()); } catch (err) { console.error(`Error: ${err.message}`); process.exit(1); }

  const listRes = await ghRequest(`repos/${repo}/contents/.teamctx/pending`, 'GET', null, token);

  if (listRes.status === 404) { console.log('No pending web contributions.'); return; }

  if (!listRes.ok) {
    const err = await listRes.json().catch(() => ({}));
    console.error(`GitHub API error: ${err.message || listRes.status}`);
    process.exit(1);
  }

  const files = (await listRes.json()).filter(f => f.name.endsWith('.json'));

  if (files.length === 0) { console.log('No pending web contributions.'); return; }

  console.log(`\n${files.length} pending web contribution${files.length !== 1 ? 's' : ''}:\n`);

  let processed = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileRes = await ghRequest(`repos/${repo}/contents/${file.path}`, 'GET', null, token);
    const fileData = await fileRes.json();
    const item = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf-8'));

    console.log(`[${i + 1}/${files.length}] Author: ${item.author || 'anonymous'}`);
    console.log(`  "${item.text}"\n`);

    const answer = await ask('Apply? (y/n/skip-all)', 'y');

    if (answer.toLowerCase() === 'skip-all') { console.log('Skipping remaining.'); break; }

    if (answer.toLowerCase() === 'y') {
      const config = readConfig();
      const text = item.author && item.author !== config.me
        ? `[From ${item.author}] ${item.text}`
        : item.text;
      try {
        await contributeCommand(text, { autoApprove: false, decision: false });
        await ghRequest(`repos/${repo}/contents/${file.path}`, 'DELETE', {
          message: `contrib: processed web submission from ${item.author}`,
          sha: fileData.sha,
        }, token);
        processed++;
      } catch (err) {
        console.error(`  Error processing contribution: ${err.message}`);
        console.log('  Skipping — file left in pending for next pull.\n');
      }
    }
  }

  if (processed > 0) console.log(`\n✓ Processed ${processed} contribution${processed !== 1 ? 's' : ''}.`);
}
