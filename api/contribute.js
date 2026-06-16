function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlForm(project) {
  project = esc(project);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Contribute — ${project}</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#1a1a1a}
    h1{font-size:1.4rem;margin-bottom:4px}p{color:#555;margin-bottom:24px}
    label{display:block;font-weight:500;margin-bottom:6px}
    input,textarea{width:100%;box-sizing:border-box;padding:10px 12px;font-size:1rem;border:1px solid #ccc;border-radius:6px;margin-bottom:16px}
    textarea{height:180px;resize:vertical;font-family:inherit}
    button{background:#1a1a1a;color:white;border:none;padding:10px 24px;font-size:1rem;border-radius:6px;cursor:pointer}
    button:hover{background:#333}
  </style>
</head>
<body>
  <h1>${project}</h1>
  <p>Share a decision, update, or piece of context. The manager will review and integrate it.</p>
  <form method="POST">
    <label for="author">Your name</label>
    <input type="text" id="author" name="author" placeholder="e.g. Sarah" required>
    <label for="text">What do you want to share?</label>
    <textarea id="text" name="text" placeholder="e.g. We confirmed the client meeting for Thursday. They want to see the dashboard first." required></textarea>
    <button type="submit">Submit</button>
  </form>
</body></html>`;
}

async function writeToGitHub(entry) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPO must be set as Vercel env vars');

  const path = `.teamctx/pending/${entry.id}.json`;
  const content = Buffer.from(JSON.stringify(entry, null, 2)).toString('base64');

  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      message: `contrib: web submission from ${entry.author}`,
      content,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub API returned ${res.status}`);
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    let project = 'Team';
    try {
      const { readFileSync } = await import('fs');
      const { join } = await import('path');
      const cfg = JSON.parse(readFileSync(join(process.cwd(), '.teamctx', 'config.json'), 'utf-8'));
      project = cfg.project || project;
    } catch { /* use default */ }

    res.setHeader('Content-Type', 'text/html');
    res.send(htmlForm(project));
    return;
  }

  if (req.method === 'POST') {
    const { author, text } = req.body || {};
    if (!text || !String(text).trim()) { res.status(400).send('Text is required.'); return; }

    const entry = {
      id: `web-${Date.now()}`,
      ts: new Date().toISOString(),
      author: String(author || 'anonymous').trim().slice(0, 100),
      text: String(text).trim().slice(0, 10000),
    };

    try {
      await writeToGitHub(entry);
    } catch (err) {
      console.error('GitHub error:', err.message);
      res.status(500).send('Failed to save. Please try again.');
      return;
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 20px}</style>
</head><body><h1>Submitted ✓</h1>
<p>Your contribution has been received. The manager will review and integrate it shortly.</p>
<p><a href="/contribute">Submit another</a></p></body></html>`);
    return;
  }

  res.status(405).send('Method not allowed.');
}
