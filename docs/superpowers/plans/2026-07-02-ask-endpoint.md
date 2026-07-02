# Ask Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up a working `/ask` web endpoint (HTML form + API) and a `teamctx ask` CLI command, both answering questions from the team's shared context (and optionally a role's context), replacing the uncommitted, inconsistent `api/ask.js` draft.

**Architecture:** One shared AI-calling function (`answerQuestion` in `src/context.js`) and one new storage reader (`readSharedMd` in `src/storage.js`) are consumed by two thin callers — the Vercel handler `api/ask.js` (GET renders a form, POST answers and re-renders) and the new CLI command `cli/commands/ask.js`. No new dependencies; reuses `callClaude` from `src/ai.js` exactly like every other AI call site in the project.

**Tech Stack:** Node.js (ESM), Vercel serverless functions (Node runtime, no framework), Commander.js CLI, Vitest.

## Global Constraints

- Node >=18 (per `package.json` `engines`).
- ESM only (`"type": "module"` in `package.json`) — use `import`/`export`, no `require`.
- No new npm dependencies — everything needed already exists in `src/ai.js`, `src/storage.js`, `commander`.
- `api/ask.js` and `cli/commands/ask.js` do not get automated tests — matches the existing project convention where only `src/*` has unit tests (no other `api/*.js` handler or `cli/commands/*.js` file has a test file today). Verify them with the throwaway scripts specified in their tasks instead.
- Commits go directly to the local `main` branch, one commit per task (matches this session's convention so far). Do not push or open a PR unless separately asked.
- Follow existing code style exactly: 2-space indent, no semicolons omitted (semicolons used throughout), single quotes, arrow functions, `try { } catch { /* comment */ }` for swallowed errors — copy the style already visible in `api/contribute.js`, `src/storage.js`, `src/context.js`.

---

### Task 1: `readSharedMd` in `src/storage.js`

**Files:**
- Modify: `src/storage.js` (insert after `readRoleFile`, i.e. after line 64, before the blank line at 65)
- Test: `src/storage.test.js` (extend the existing `describe('shared.md', ...)` block, currently at lines 70-77)

**Interfaces:**
- Produces: `readSharedMd(dir)` — reads `.teamctx/context/shared.md`; returns `''` if the file doesn't exist. Same `dir`-optional convention as every other function in this file (`dir || getTeamctxDir()` via the internal `resolve` helper).
- Consumes: nothing new — reuses the file's existing `resolve` helper and the `readFileSync`/`existsSync` imports already at the top of `src/storage.js`.

- [ ] **Step 1: Write the failing tests**

Open `src/storage.test.js`. Add `readSharedMd` to the import list at the top:

```javascript
import {
  readConfig, writeConfig,
  readShared, writeShared,
  appendContribution, readContributions,
  writeRoleFile, readRoleFile,
  writeSharedMd, readSharedMd,
} from './storage.js';
```

Replace the existing `describe('shared.md', ...)` block (lines 70-77) with:

```javascript
describe('shared.md', () => {
  it('writes shared.md into context/', async () => {
    writeSharedMd('# Project\n\n*No context.*', dir);
    const { readFileSync } = await import('fs');
    const content = readFileSync(join(dir, 'context', 'shared.md'), 'utf-8');
    expect(content).toBe('# Project\n\n*No context.*');
  });

  it('reads shared.md written previously', () => {
    writeSharedMd('# Project\n\nHello', dir);
    expect(readSharedMd(dir)).toBe('# Project\n\nHello');
  });

  it('returns empty string when shared.md does not exist', () => {
    expect(readSharedMd(dir)).toBe('');
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run src/storage.test.js`
Expected: FAIL — `readSharedMd is not a function` (or similar `SyntaxError`/`TypeError` from the missing export), other existing tests still pass.

- [ ] **Step 3: Implement `readSharedMd`**

In `src/storage.js`, insert this function right after `readRoleFile` (which ends at line 64) and before `writeSharedMd`:

```javascript
export function readSharedMd(dir) {
  const p = resolve(dir, 'context', 'shared.md');
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf-8');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/storage.test.js`
Expected: PASS — all tests in the file green, including the 3 in `describe('shared.md', ...)`.

- [ ] **Step 5: Commit**

```bash
git add src/storage.js src/storage.test.js
git commit -m "feat: add readSharedMd to src/storage.js"
```

---

### Task 2: `answerQuestion` in `src/context.js`

**Files:**
- Modify: `src/context.js` (append after `generateReflection`, which ends at line 97)
- Test: `src/context.test.js` (add a new `describe('answerQuestion', ...)` block after the existing `describe('generateRoleFile', ...)` block)

**Interfaces:**
- Consumes: `callClaude({ prompt, model, system })` from `src/ai.js` — already imported at the top of `src/context.js` (`import { proposeDiff, callClaude } from './ai.js';`).
- Produces: `answerQuestion({ sharedMd, roleMd, question, config })` — returns a `Promise<string>` (the answer text, already trimmed by `callClaude`). `roleMd` may be `''`/falsy, in which case the role-context section is omitted from the prompt.

- [ ] **Step 1: Write the failing tests**

Open `src/context.test.js`. Add `answerQuestion` to the import list at the top:

```javascript
import { serializeToMd, updateShared, generateRoleFile, answerQuestion } from './context.js';
```

Add this block after the existing `describe('generateRoleFile', ...)` block (after line 69):

```javascript
describe('answerQuestion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls callClaude with shared and role context, returns the answer', async () => {
    callClaude.mockResolvedValue('The launch date is Q3.');
    const result = await answerQuestion({
      sharedMd: '# Shared\n\nWe are launching in Q3.',
      roleMd: '# CPO Context\n\nYou own product strategy.',
      question: 'When do we launch?',
      config: { model: 'claude-sonnet-4-6' },
    });
    expect(callClaude).toHaveBeenCalledOnce();
    const call = callClaude.mock.calls[0][0];
    expect(call.model).toBe('claude-sonnet-4-6');
    expect(call.prompt).toContain('We are launching in Q3.');
    expect(call.prompt).toContain('You own product strategy.');
    expect(call.prompt).toContain('When do we launch?');
    expect(result).toBe('The launch date is Q3.');
  });

  it('omits the role context section when roleMd is empty', async () => {
    callClaude.mockResolvedValue('answer');
    await answerQuestion({
      sharedMd: '# Shared\n\ncontext',
      roleMd: '',
      question: 'q?',
      config: { model: 'claude-sonnet-4-6' },
    });
    const call = callClaude.mock.calls[0][0];
    expect(call.prompt).not.toContain('Your Role Context');
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run src/context.test.js`
Expected: FAIL — `answerQuestion is not a function` (or import error), other existing tests in the file still pass.

- [ ] **Step 3: Implement `answerQuestion`**

Append this to the end of `src/context.js` (after `generateReflection`'s closing `}` at line 97):

```javascript

export async function answerQuestion({ sharedMd, roleMd, question, config }) {
  const context = [
    roleMd ? `## Your Role Context\n\n${roleMd}` : '',
    sharedMd ? `## Shared Project Context\n\n${sharedMd}` : '',
  ].filter(Boolean).join('\n\n---\n\n');

  const system = 'You are a helpful assistant with access to the team\'s project context. Answer questions based on the context provided. Be concise and specific.';
  const prompt = `Context:\n\n${context}\n\n---\n\nQuestion: ${question}`;

  return callClaude({ prompt, model: config.model, system });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/context.test.js`
Expected: PASS — all tests in the file green, including the 2 new ones in `describe('answerQuestion', ...)`.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS — all test files green (no regressions in `ops.test.js`, `roles.test.js`, `ai.test.js`, `git.js` has no test file).

- [ ] **Step 6: Commit**

```bash
git add src/context.js src/context.test.js
git commit -m "feat: add answerQuestion to src/context.js"
```

---

### Task 3: `/ask` web endpoint (`api/ask.js`, `vercel.json`)

**Files:**
- Modify (full rewrite): `api/ask.js` — currently an untracked draft; this task replaces its contents entirely and is the first commit of this file.
- Modify: `vercel.json`

**Interfaces:**
- Consumes: `readConfig(dir)`, `readSharedMd(dir)`, `readRoleFile(slug, dir)` from `src/storage.js` (Task 1); `answerQuestion({ sharedMd, roleMd, question, config })` from `src/context.js` (Task 2).
- Produces: a Vercel Node handler `export default async function handler(req, res)` at `api/ask.js`, reachable at `POST/GET /api/ask` and, after the `vercel.json` rewrite, at `/ask`.

- [ ] **Step 1: Replace the contents of `api/ask.js`**

```javascript
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
```

- [ ] **Step 2: Add the `/ask` rewrite to `vercel.json`**

Replace the full contents of `vercel.json` with:

```json
{
  "rewrites": [
    { "source": "/context/:role", "destination": "/api/context/[role]" },
    { "source": "/contribute", "destination": "/api/contribute" },
    { "source": "/ask", "destination": "/api/ask" }
  ]
}
```

- [ ] **Step 3: Set up a fixture project for verification**

Run:
```bash
mkdir -p /tmp/teamctx-ask-fixture/.teamctx/context/roles
cat > /tmp/teamctx-ask-fixture/.teamctx/config.json <<'EOF'
{"project":"Demo","model":"claude-sonnet-4-6","me":"alice","autoPush":false,"roles":[{"slug":"cpo","name":"CPO","responsibilities":"Product","excludes":""}]}
EOF
printf '# Shared\n\nWe are launching in Q3.\n' > /tmp/teamctx-ask-fixture/.teamctx/context/shared.md
printf '# CPO Context\n\nYou own product.\n' > /tmp/teamctx-ask-fixture/.teamctx/context/roles/cpo.md
```
Expected: no output; `ls /tmp/teamctx-ask-fixture/.teamctx` shows `config.json` and `context`.

- [ ] **Step 4: Write the throwaway verification script**

Run (from the repo root, `/Users/shikhin-macair/StatsLateral/teamctx`):
```bash
cat > /tmp/teamctx-ask-verify.mjs <<'EOF'
import path from 'path';

const repoRoot = process.cwd();
const { default: handler } = await import(path.join(repoRoot, 'api', 'ask.js'));

process.chdir('/tmp/teamctx-ask-fixture');

function mockRes() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.json = (b) => { res.body = JSON.stringify(b); return res; };
  return res;
}

let res = mockRes();
await handler({ method: 'GET' }, res);
console.log('GET status:', res.statusCode, '| has CPO option:', res.body.includes('>CPO<'));

res = mockRes();
await handler({ method: 'POST', body: {} }, res);
console.log('POST empty question status:', res.statusCode, '|', res.body);

res = mockRes();
await handler({ method: 'POST', body: { question: 'hi', role: 'not-real' } }, res);
console.log('POST unknown role status:', res.statusCode, '|', res.body);

delete process.env.ANTHROPIC_API_KEY;
res = mockRes();
await handler({ method: 'POST', body: { question: 'What is our plan?' } }, res);
console.log('POST no API key status:', res.statusCode, '|', res.body);
EOF
```
Expected: no output (file created).

- [ ] **Step 5: Run the verification script**

Run (from the repo root, `/Users/shikhin-macair/StatsLateral/teamctx`): `node /tmp/teamctx-ask-verify.mjs`

Expected output (order matters):
```
GET status: 200 | has CPO option: true
POST empty question status: 400 | Question is required.
POST unknown role status: 400 | Unknown role.
POST no API key status: 500 | AI not configured on this server.
```

- [ ] **Step 6: Clean up the fixture and script**

```bash
rm -rf /tmp/teamctx-ask-fixture /tmp/teamctx-ask-verify.mjs
```
Expected: no output.

- [ ] **Step 7: Run the full test suite (confirm no regressions)**

Run: `npm test`
Expected: PASS — all existing test files green (this task added no `.test.js` files, per the Global Constraints).

- [ ] **Step 8: Commit**

```bash
git add api/ask.js vercel.json
git commit -m "feat: wire up /ask web endpoint (GET form, POST answer)"
```

---

### Task 4: `teamctx ask` CLI command

**Files:**
- Create: `cli/commands/ask.js`
- Modify: `cli/index.js` (add import + command registration)

**Interfaces:**
- Consumes: `readConfig()`, `readSharedMd()`, `readRoleFile(slug)` from `../../src/storage.js`; `answerQuestion({ sharedMd, roleMd, question, config })` from `../../src/context.js`.
- Produces: `askCommand(question, opts)` where `opts.role` is an optional slug string — registered on the `program` as `teamctx ask <question> [--role <slug>]`.

- [ ] **Step 1: Create `cli/commands/ask.js`**

```javascript
import { readConfig, readSharedMd, readRoleFile } from '../../src/storage.js';
import { answerQuestion } from '../../src/context.js';

export async function askCommand(question, opts) {
  const config = readConfig();

  let roleMd = '';
  if (opts.role) {
    const role = config.roles.find(r => r.slug === opts.role);
    if (!role) {
      console.error(`Error: no role "${opts.role}". Run \`teamctx role list\` to see available roles.`);
      process.exit(1);
    }
    roleMd = readRoleFile(opts.role);
  }

  const sharedMd = readSharedMd();
  const answer = await answerQuestion({ sharedMd, roleMd, question, config });
  console.log(`\n${answer}\n`);
}
```

- [ ] **Step 2: Register the command in `cli/index.js`**

Add the import next to the other command imports (after `import { contributeCommand } from './commands/contribute.js';`):

```javascript
import { askCommand } from './commands/ask.js';
```

Add the command registration after the `program.command('contribute <text>')...action(contributeCommand);` block and before `program.command('pull')...`:

```javascript
program.command('ask <question>').description("Ask a question, answered from your team's context")
  .option('--role <slug>', "Answer from a specific role's perspective")
  .action(askCommand);
```

- [ ] **Step 3: Set up a fixture project for verification**

Run:
```bash
mkdir -p /tmp/teamctx-ask-fixture/.teamctx/context/roles
cat > /tmp/teamctx-ask-fixture/.teamctx/config.json <<'EOF'
{"project":"Demo","model":"claude-sonnet-4-6","me":"alice","autoPush":false,"roles":[{"slug":"cpo","name":"CPO","responsibilities":"Product","excludes":""}]}
EOF
printf '# Shared\n\nWe are launching in Q3.\n' > /tmp/teamctx-ask-fixture/.teamctx/context/shared.md
printf '# CPO Context\n\nYou own product.\n' > /tmp/teamctx-ask-fixture/.teamctx/context/roles/cpo.md
```
Expected: no output.

- [ ] **Step 4: Verify the unknown-role error path**

Run:
```bash
cd /tmp/teamctx-ask-fixture && node /Users/shikhin-macair/StatsLateral/teamctx/cli/index.js ask "What is our plan?" --role bogus; echo "exit: $?"; cd -
```
Expected output includes:
```
Error: no role "bogus". Run `teamctx role list` to see available roles.
exit: 1
```

- [ ] **Step 5: Verify the missing-API-key error path**

Run:
```bash
cd /tmp/teamctx-ask-fixture && env -u ANTHROPIC_API_KEY node /Users/shikhin-macair/StatsLateral/teamctx/cli/index.js ask "What is our plan?"; echo "exit: $?"; cd -
```
Expected output includes the string `ANTHROPIC_API_KEY` (from `callClaude`'s error in `src/ai.js`) and a nonzero exit code — this is an unhandled rejection printed by Node, matching how every other AI-calling CLI command (e.g. `contribute`, `role add`) behaves today with no try/catch around the AI call.

- [ ] **Step 6: Clean up the fixture**

```bash
rm -rf /tmp/teamctx-ask-fixture
```
Expected: no output.

- [ ] **Step 7: Run the full test suite (confirm no regressions)**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add cli/commands/ask.js cli/index.js
git commit -m "feat: add teamctx ask CLI command"
```

---

### Task 5: Docs housekeeping (README, CHANGELOG, ROADMAP)

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `ROADMAP.md`

**Interfaces:** None — documentation only, no code.

- [ ] **Step 1: Add the CLI command to the README's Commands table**

In `README.md`, find this line:
```
| `teamctx context <role>` | Print role MD to stdout |
```
Add this line immediately after it:
```
| `teamctx ask "<question>" [--role <slug>]` | Ask a question, answered from your team context |
```

- [ ] **Step 2: Document the `/ask` route in the Self-hosting section**

In `README.md`, find:
```
- **`/context/<role>`** — downloads their role context file
- **`/contribute`** — a plain HTML form to submit updates
```
Replace with:
```
- **`/context/<role>`** — downloads their role context file
- **`/contribute`** — a plain HTML form to submit updates
- **`/ask`** — a plain HTML form to ask a question, answered from the shared (and optional role) context
```

- [ ] **Step 3: Document `/ask` in the Security model section**

In `README.md`, find:
```
- The `/contribute` form is public (no login required) — manager reviews and approves all submissions via `teamctx pull` before anything is committed
```
Add this line immediately after it:
```
- The `/ask` form is public too (no login required) — it only reads context to answer questions, it never writes to your repo
```

- [ ] **Step 4: Add a CHANGELOG entry**

In `CHANGELOG.md`, find:
```
### Added
- Open-source communication surface: roadmap, contributing guide, code of
  conduct, security policy, issue/PR templates, CI, and CODEOWNERS.
```
Add this bullet immediately after it (still inside `### Added`):
```
- `/ask` endpoint, minimal web UI, and `teamctx ask "<question>" [--role <slug>]`
  CLI command for asking questions grounded in team context.
```

- [ ] **Step 5: Remove the shipped roadmap item**

In `ROADMAP.md`, find:
```
## Now
- 🟢 Wire up the `ask` endpoint + a minimal web UI — *ask / support*
- **Provider-agnostic AI layer** — put the AI calls behind a small provider interface so teamctx can use Claude, OpenAI, or a local model — *no lock-in · the keystone item* · [proposal](docs/proposals/provider-agnostic-ai.md)
```
Replace with:
```
## Now
- **Provider-agnostic AI layer** — put the AI calls behind a small provider interface so teamctx can use Claude, OpenAI, or a local model — *no lock-in · the keystone item* · [proposal](docs/proposals/provider-agnostic-ai.md)
```

- [ ] **Step 6: Verify the edits landed**

Run:
```bash
grep -c 'teamctx ask' README.md
grep -c '/ask' README.md
grep -c 'ask.*endpoint' CHANGELOG.md
grep -c 'Wire up the .ask. endpoint' ROADMAP.md
```
Expected:
```
1
3
1
0
```
(The `README.md` `/ask` count of 3 covers the Commands table row, the Self-hosting bullet, and the Security model bullet.)

- [ ] **Step 7: Commit**

```bash
git add README.md CHANGELOG.md ROADMAP.md
git commit -m "docs: document the ask endpoint and CLI command, remove shipped roadmap item"
```

---

### Task 6: Manual smoke test (human-verified, requires a real `ANTHROPIC_API_KEY`)

This task cannot be scripted deterministically — it exercises the real Anthropic API and, for the web UI, a real browser. Run it yourself (or hand it to a human) before considering the feature done; the automated tasks above already prove the plumbing is correct without spending API credits.

**Files:** None — verification only.

- [ ] **Step 1: CLI smoke test**

In a real, `teamctx init`-ed project with `ANTHROPIC_API_KEY` set (e.g. in `.env.local`), run:
```bash
teamctx ask "What are we building?"
```
Expected: a real, on-topic answer printed to the terminal (not an error).

- [ ] **Step 2: Web UI smoke test**

From the repo root, run `vercel dev` (requires `vercel link` to a project with `ANTHROPIC_API_KEY` set, or run it against the same local `.teamctx/` project used in Step 1). Open `http://localhost:3000/ask` in a browser:
- Confirm the form renders with the project name, a question textarea, and a role dropdown listing any configured roles.
- Submit a question with "General" selected — confirm a real answer renders above the form.
- Submit a question with a specific role selected — confirm the answer reads as if written for that role.
- Submit the form with an empty question — confirm the browser's `required` validation blocks submission (no request is sent).

No further commit — this task only confirms Tasks 3 and 4 work end-to-end with real credentials.
