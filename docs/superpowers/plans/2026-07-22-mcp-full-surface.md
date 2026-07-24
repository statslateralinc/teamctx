# Plan — MCP full-surface (init + manager tools)

**Goal:** expose every teamctx CLI command through MCP so a manager can run the
whole workflow from an AI client (Claude Desktop / Code / Cursor) without ever
touching a terminal. The only manual step should be dropping the API key into
the MCP config once.

**Non-goal:** replace the CLI. The CLI stays canonical; MCP tools are thin
wrappers around the same core functions.

## Motivation

Managers are the target audience for teamctx and often the least
terminal-comfortable. Today the MCP surface is scoped to daily use (read + write
contributions) — everything that changes structure (init, workstream split, role
add, review approve, snapshot) is CLI-only. That means a manager cannot run the
tool without a developer at their shoulder. This plan closes that gap while
keeping the safety story intact.

## Approach

Two-layer refactor:

1. **Extract pure core functions from each CLI command.** Every command file
   today mixes three things: interactive prompts (`ask()`), stdout logging
   (`console.log`), and the actual state mutation. Extract the mutation into a
   pure async function that takes explicit params and returns a result object.
   The CLI action becomes a thin shim that gathers input, calls the core, and
   prints the result. The MCP tool becomes a second thin shim that takes the
   MCP arguments, calls the same core, and returns a structured result.

2. **Wire new MCP tools onto those cores.** No business logic in `mcp/server.js`
   itself.

This keeps the CLI's UX unchanged and gives MCP full parity for free. Where the
CLI is interactive (workstream split's per-proposal accept/rename), MCP
callers pass the full decision set as an array.

## Tools to add

Grouped by risk tier. Every mutating tool description includes an explicit
warning banner so the client surfaces it to the user before calling.

### Tier 0 — read-only (safe, no gating)

Already exist: `get_context`, `list_workstreams`, `get_workstream`,
`get_role_context`, `ask`. Add:

- `list_roles` — return `config.roles` (slug, name, workstream)
- `list_snapshots` — id, message, status, timestamps
- `get_snapshot({id})` — full snapshot payload (with prefix-match like CLI)
- `list_pending_reviews` — queue items with id, author, summary, workstream
- `get_status` — the `teamctx status` payload as structured JSON
- `get_config` — public config (project, provider, model, manager,
  workstreams, roles) — never returns API keys

### Tier 1 — additive writes (low risk, no gating)

- `contribute` — supersedes `submit_contribution`, adds `decision` and `apply`
  flags. `apply: false` (default) → enqueue; `apply: true` → immediate write
  (respects manager gate: if `config.manager` is set and `author` doesn't match,
  refuse and hint at `review_approve`)
- `role_add({name, slug?, workstream?, from?})` — non-interactive role add. If
  `from: "suggest"`, use the AI role-suggestion path
- `list_role_suggestions` — separate read-only tool that returns the AI's
  suggested roles without creating them (so a client can present them and then
  call `role_add` for the chosen ones)
- `pull` — process pending web contributions (no gating; already opt-in)

### Tier 2 — structural / gated (HIGH RISK; require manager identity)

Every tool in this tier:
- Checks `checkManagerGate(config)` — if a manager identity is set on the
  project, the caller must pass `author` matching it; otherwise refuse
- Description contains a bold warning
- Response includes a `review` field summarizing what changed and asking the
  client to report the outcome back to the user

Tools:
- `init({project, me, provider, model, autoPush?, deployUrl?, githubRawBase?, managerEmail?})`
  — bootstraps `.teamctx/` at the project dir. Refuses if already initialized.
  This is the special case: it runs before there's a config, so no manager gate
  (the caller becomes the manager if they later set one).
- `workstream_suggest` — dry run, actually read-only. Move to Tier 0? No — leave
  in Tier 2 so the client understands it's part of the restructuring flow.
- `workstream_split({accept: [{name, whyIds, rename?, moveRoles?}], acceptAll?})`
  — apply a set of splits. `accept` is the decision array; `acceptAll` is a
  shortcut equivalent to accepting every suggestion by AI-proposed name
- `workstream_use({id})` — set active workstream
- `role_assign({slug, workstream})` — move role to a workstream
- `review_approve({id, author})` — approve a queue item (manager-gated)
- `review_reject({id, reason?, author})` — reject a queue item (manager-gated)
- `snapshot_create({message?})` — freeze workspace as pending snapshot
- `snapshot_approve({id, author})` — set current-approved (manager-gated)
- `snapshot_reject({id, reason?, author})` — reject snapshot (manager-gated)
- `reflect({workstream?})` — AI rewrite; not gated but flagged as destructive-ish
- `config_set({key, value})` — set provider/model/manager/managerEmail/deployUrl/
  githubRawBase/autoPush. Whitelist keys; refuse unknown

### Not exposed

- `setup` — creates a GitHub repo via `gh`; requires external auth and
  interactive prompts. Out of scope; keep CLI-only. Doc note points users at
  `init` as the MCP-friendly alternative.
- `context <role>` — trivially replaced by `get_role_context`. Skip.

## Risk model + guardrails

Three layers:

1. **Description warnings** — every Tier 2 tool's `description` starts with a
   compact "⚠ RISKY:" preamble that names the specific downside. This is what
   the client model sees when it decides whether to call. Sample:

   > `⚠ RISKY: applies a queued contribution to shared context and commits.
   > Irreversible without a git revert. Confirm with the user first; report
   > the queue item's author + summary before calling; report the resulting
   > operations after.`

2. **Manager gate at the MCP boundary** — `checkManagerGate` runs before any
   Tier 2 handler. If `config.manager` is set, the caller must pass
   `author === config.manager`. Otherwise the call errors out with a message
   the client can relay to the user. No `author` = falls back to `config.me`.

3. **Structured "reportBack" hint in responses** — every mutating tool returns
   `{status, summary, operations, reportBack}` where `reportBack` is a short
   sentence like `"Tell the user: approved item c-… by <author>. Changes:
   3 Why nodes added on workstream 'growth'."`. The client will surface it.

## Data / on-disk changes

None. This is pure API surface work; every existing on-disk format stays.

## Refactor structure

New file per command: `cli/commands/<name>.core.js` exports the pure function.
`cli/commands/<name>.js` continues to export the CLI action but delegates.
`mcp/server.js` imports the core.

Example, for `init`:

- `cli/commands/init.core.js`:
  ```js
  export async function initProject({
    projectDir, project, me, provider, model,
    autoPush = true, deployUrl = '', githubRawBase = '', managerEmail = ''
  }) { /* pure — no console, no ask */ }
  ```
- `cli/commands/init.js` collects prompts, calls `initProject({projectDir: cwd, ...})`, prints
- `mcp/server.js` exposes `init` tool that calls `initProject({projectDir: projectRoot, ...})`

Same shape for every command in scope.

`commitContext` / `pushContext` today implicitly use cwd; already have `{cwd}`
overload used in `submit_contribution`. Confirm all mutating cores plumb `cwd`
through.

## Testing

- Every new core function gets a vitest test file with mocked storage — same
  shape as `review.test.js` from the workstream-integration branch.
- Every new MCP tool gets a case in `mcp/server.test.js` verifying handler
  wiring + error paths (manager gate refusal, missing project, unknown key).
- One integration test that spins the built server, calls `init`, then
  `contribute --apply`, then `snapshot_create`, then `snapshot_approve` —
  end-to-end write path through the MCP boundary.

Target: keep the 147/147 baseline green, add ~30–40 new tests.

## Docs

- `docs/mcp.md` — full tool table rewritten by tier with warning callouts
- `docs/mcp-manager-guide.md` — new short guide "run teamctx from Claude
  Desktop with zero terminal": setup + copy-paste prompts for the common
  flows (init, add a role, contribute, review, snapshot)
- `README.md` — a one-liner pointer to the manager guide
- `CHANGELOG.md` — Added section listing the new tools, Changed section for
  the `submit_contribution` → `contribute` rename (with a deprecation note; old
  name still works for a release)

## Phased delivery

Do it in three commits so review stays reviewable:

1. **Refactor pass** — extract cores for every command in scope, delete no CLI
   behavior, add core unit tests. No new MCP tools yet. Green tests.
2. **MCP tools** — add the new tools, gate/warnings, tool tests, integration
   test. Docs.
3. **Manager guide + changelog polish**.

## Open questions

- **Author identity for Tier 2 calls.** Right now MCP has no auth — anyone
  running the client can claim to be the manager. That's already true of the
  CLI (identity is name-based, not credential-based). Fine for OSS pre-1.0;
  flag in docs as a known limitation.
- **`workstream_split` with roles.** CLI's interactive per-split "move any
  roles?" prompt becomes `moveRoles: [slug]` on each accepted split. Callers
  who don't specify get zero role moves. Non-blocking; documented.
- **Reflect + gate.** Not manager-gated today. Leave un-gated but keep the
  ⚠ description because it can meaningfully rewrite context.

## Out of scope for this branch

- Remote/HTTP MCP transport
- Setup (GitHub repo creation)
- Multi-user auth on MCP
- Web-app parity for the same surface (that's a different PR)
