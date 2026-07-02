# Design: Wire up the `ask` endpoint + minimal web UI

**Roadmap item:** "Now" — 🟢 Wire up the `ask` endpoint + a minimal web UI — *ask / support*
**Status:** Approved, ready for planning

## Problem

Team members without git access — or the project owner from a terminal — need a
way to ask a question and get an answer grounded in the team's shared context
(and optionally a specific role's context). Today there's an uncommitted draft
(`api/ask.js`) that does the core of this, but it:

- Duplicates Anthropic client setup instead of reusing `src/ai.js` (`callClaude`).
- Reads `.teamctx` files directly with `fs` instead of `src/storage.js`.
- Has no web form (`/contribute` has one; `/ask` doesn't).
- Has no `vercel.json` route.
- Has no CLI equivalent, unlike every other capability in the project.

## What exists today (relevant prior art)

- `src/ai.js` — `callClaude({ prompt, model, system, max_tokens })`, `DEFAULT_MODEL`.
- `src/context.js` — prompt-building functions that call `callClaude`:
  `proposeDiff`, `generateRoleFile`, `generateReflection`.
- `src/storage.js` — file I/O for `.teamctx/`: `readConfig`, `readShared`,
  `readRoleFile`, `writeSharedMd` (no `readSharedMd` yet).
- `api/contribute.js` — the closest precedent for a public, unauthenticated
  Vercel handler with a GET-renders-form / POST-processes-and-responds shape,
  no client-side JS.
- `vercel.json` — rewrites `/contribute` → `/api/contribute` and
  `/context/:role` → `/api/context/[role]`.
- `cli/index.js` + `cli/commands/*.js` — every capability (`contribute`, `role`,
  `context`, `status`, `pull`, `reflect`) has a CLI command; `ask` currently
  doesn't.
- `.teamctx/config.json` shape: `{ project, me, model, autoPush, deployUrl,
  githubRawBase, managerEmail, roles: [{ slug, name, responsibilities,
  excludes, email? }] }`.

## Design

### 1. Shared logic (`src/storage.js`, `src/context.js`)

- `src/storage.js`: add `readSharedMd(dir)`, mirroring the existing
  `writeSharedMd(content, dir)`. Reads `.teamctx/context/shared.md`; returns
  `''` if the file doesn't exist yet (matches how `readShared` degrades
  gracefully for a brand-new project).
- `src/context.js`: add
  `answerQuestion({ sharedMd, roleMd, question, config })`:
  - Builds a context block from `roleMd` (if provided) and `sharedMd`, same
    shape the current draft already uses.
  - System prompt: "You are a helpful assistant with access to the team's
    project context. Answer questions based on the context provided. Be
    concise and specific."
  - Calls `callClaude({ prompt, model: config.model, system })` — uses the
    project's configured model, not a separate hardcoded default. This is a
    deliberate behavior change from the draft (which defaulted to
    `claude-haiku-4-5` independent of `config.model`); consistency with every
    other AI call in the app wins over a cheaper default.
  - Returns the trimmed answer text.
- Both the CLI command and the API handler call this same function — no
  AI/file logic is duplicated between them.

### 2. Web layer (`api/ask.js`, `vercel.json`)

- `vercel.json`: add `{ "source": "/ask", "destination": "/api/ask" }`.
- `api/ask.js` rewritten to use `src/storage.js` + `src/context.js`:
  - **GET**: renders a minimal HTML form (no JS), styled like
    `contribute.js`'s form — project name (from config), a question
    `<textarea>`, and a role `<select>` populated from `config.roles`
    (slug + name), plus a "General" option that omits the role filter.
  - **POST**: validates `question` (required, non-empty) and `role` (optional;
    must match `^[a-z0-9-]+$` and exist in `config.roles` — 400 if not).
    Calls `answerQuestion(...)`, then responds with a full HTML page showing
    the question, the rendered answer, and the empty form again below it so
    another question can be asked immediately. No redirect, no client JS —
    matches the "full-page POST + reload" pattern already used by
    `/contribute`.
  - Error handling, matching the current draft's conventions:
    - Missing `ANTHROPIC_API_KEY` → 500, "AI not configured on this server."
    - `.teamctx` not found (project not initialized) → 500, friendly message.
    - Invalid/unknown role slug → 400.
- Access model: public, unauthenticated — same as `/contribute` and
  `/context/<role>` today. README's "Security model" section gets a line
  added for `/ask`.

### 3. CLI (`cli/commands/ask.js`, `cli/index.js`)

- New `cli/commands/ask.js`: `askCommand(question, opts)`:
  - `readConfig()`, `readSharedMd()`.
  - If `opts.role` is given: validate it exists in `config.roles` (clear
    error if not), `readRoleFile(slug)`.
  - Calls `answerQuestion(...)`, prints the answer to stdout.
  - Read-only — no `commitContext`/`pushContext`, unlike `contribute`/`role add`.
- `cli/index.js`: register
  `program.command('ask <question>').description('Ask a question using your team context').option('--role <slug>', "Answer from a specific role's perspective").action(askCommand);`

### 4. Tests

- `src/context.test.js`: add cases for `answerQuestion` (mock `callClaude`,
  same mocking pattern already used for `proposeDiff`/`generateRoleFile`).
- `src/storage.test.js`: add cases for `readSharedMd` (exists / missing).
- No new tests for `api/ask.js` or `cli/commands/ask.js` directly — consistent
  with the existing project convention where only `src/*` has unit tests; no
  Vercel-handler or CLI-command tests exist today for any other feature.

### 5. Docs housekeeping

- `README.md`: add `teamctx ask "<question>" [--role <slug>]` to the Commands
  table; mention `/ask` in the Self-hosting routes list and the Security model
  section.
- `CHANGELOG.md`: add an `[Unreleased] → Added` line for the `/ask` endpoint,
  web UI, and CLI command.
- `ROADMAP.md`: remove the now-shipped "Wire up the `ask` endpoint + a minimal
  web UI" bullet from "Now" (leaving the provider-agnostic AI layer as the
  sole remaining "Now" item).

## Out of scope

- Rate limiting / abuse protection on the public `/ask` endpoint (none of the
  other public endpoints have it either; a follow-up if it becomes a problem).
- Streaming responses.
- Provider-agnostic routing (tracked separately in
  `docs/proposals/provider-agnostic-ai.md`; this design keeps `answerQuestion`
  going through `callClaude` like every other call site, so it's a drop-in
  caller once that proposal lands).

## Testing / verification plan

- `npm test` (vitest) covering the new `answerQuestion` and `readSharedMd` cases.
- Manual verification: `teamctx ask "..."` from the CLI against a locally
  initialized `.teamctx/` project, and `vercel dev` (or equivalent) hitting
  `GET /ask` and `POST /ask` in a browser.
