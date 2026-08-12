# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **`init` over the hosted MCP server crashed instead of bootstrapping a
  project.** `initProject` was the one write path with no hosted branch: it ran
  `join(projectDir, '.teamctx')` first, and in hosted mode `projectDir` is the
  `{__backend:'github'}` context object, so it threw `The "path" argument must
  be of type string` before touching anything. It now branches on
  `getCurrentSession()` the way every other write path already does, writing
  through the GitHub adapter rather than `mkdirSync`/`writeFileSync`. You could
  not start a new project through the hosted surface at all before this.
  Fixes #32.
- Ten mutating MCP handlers passed `projectDir: projectRoot` rather than the
  hosted-safe `gitCwd`. Harmless in practice — everything they reach checks for
  an ambient session before using `cwd` — but that guard was the only thing
  keeping the context object away from git, which is the wrong place to rely on.
- The init commit made over MCP now reads `chore: initialize teamctx for "…"
  (via mcp)`, matching the `(via mcp)` note `contribute` already appends. A repo
  bootstrapped from a chat client has no local checkout and no shell, so the
  history was the only record of where the commit came from — and it did not say.

### Added
- **Per-user settings.** Identity and the active workstream are now resolved
  per person instead of being read from the committed `.teamctx/config.json`.
  A new actor context (`src/actor.js`) resolves who is calling — the GitHub
  account that completed OAuth on the hosted server, `git config user.name`
  on the CLI and stdio MCP, falling back to `config.me` — and a preference
  store (`src/prefs.js`) keeps their choices out of the repo: KV when hosted,
  a gitignored `.teamctx/.local/prefs.json` locally.
- `teamctx config manager --me` pins the approval gate to your own identity
  (`managerKey`), which no one else can claim. `@login` and a raw actor key
  also work. A project still holding a display name in `config.manager` keeps
  working, with a warning on every gated action — that form is advisory only,
  since anyone can set that name as their own.
- `config_set name` / `teamctx config name` sets the display name used on your
  own contributions. Personal: it is stored against you and never written to
  the repo. `teamctx config name --clear` drops the override so the name is
  derived from your identity again — and keeps following it if that identity
  changes. (A flag rather than an empty string: PowerShell discards `""`
  before the process sees it.)
- Contributions now carry an `authorKey` alongside `author`, so one person is
  counted once in the `## Contributors` roll-up even when their display name
  differs between the CLI (git name) and the hosted server (GitHub name).
- **`teamctx import <paths…>`** — turn a team's existing `.md` / `.txt` files
  into proposed contributions, so a new project does not start from a blank
  context tree. Each document becomes one contribution, distilled by the
  existing pipeline and left in the manager's review queue — import is not a
  second way into shared context, and nothing is ever applied directly. The
  contribution records which file it came from (`source: import:docs/plan.md`),
  so the audit trail points back at the artifact.
  `--dry-run` lists what would be imported without spending an AI call;
  `--workstream <id>` targets a specific workstream.
  Files that cannot be used (too large, empty, unsupported type) are reported
  with a reason before any distilling starts; a path that does not exist is an
  error rather than a silent no-op.
  Imported files are distilled as *documents* — asked for the whys, decisions
  and constraints that outlive the file, and told to ignore its structure — so
  headings and meeting dates do not become Why nodes. A document carrying no
  durable context adds nothing rather than being padded into a contribution.
  Within one run, each document is told what earlier ones already proposed, so
  three files describing the same decision produce one contribution rather than
  three near-duplicates for the manager to reject. Closes #20.

### Changed
- `workstream_use` / `teamctx workstream use` now records a personal
  preference. It no longer writes `activeWorkstream` to the shared config, and
  no longer creates a commit — switching workstream stopped moving everyone
  else's default. `config.activeWorkstream` remains the project default for
  anyone who has not switched, so existing projects behave as before.
- `get_status` and `get_config` return `me` and `activeWorkstream` resolved
  for the calling user, with the repo's values under `projectDefaults`.
  `get_status.meSource` reports where the *name* came from (`override` when the
  user set their own), and `actorSource` where the caller was authenticated.
- `teamctx init` pre-fills the name prompt from the git identity and records
  the chosen handle as the initializer's own preference.

### Fixed
- `reflect` now rejects unknown workstream ids instead of creating empty
  workstream stubs.
- `teamctx pull` threw a `ReferenceError` when applying a contribution from
  another author — it compared against an undefined `me`.
- A saved AI provider key was applied against the provider named in the
  project's shared config rather than the one it belongs to — an OpenAI key
  was handed to the Anthropic client. The stored provider now travels with
  the key, and the model follows it.
- **The approval gate is now bound to an identity, not a display name.**
  `canApprove` compared `config.me` against `config.manager` — two strings from
  the same shared file — so on a multi-user deployment it let everyone through
  or nobody, depending on who ran `init`. It now compares the authenticated
  caller's actor key against `config.managerKey`.
- **`review_approve` / `review_reject` / `snapshot_approve` / `snapshot_reject`
  no longer accept an `author` argument.** It was a caller-supplied claim used
  as the identity for the gate check, so any hosted caller could pass
  `author: "<manager's name>"` and through. The gate now reads the
  authenticated actor and nothing else; `author` remains on `contribute` for
  attribution only, where it grants no authority.

## [0.3.0] - 2026-08-07

### Added
- **Hosted, multi-tenant MCP server.** Deploy once to Vercel and any number
  of users connect over `https://<deployment>/api/mcp/<owner>/<repo>` with
  zero local install — no tokens, no PATs, no files on their machine. Full
  OAuth 2.1 authorization server (`api/oauth-server.js`) proxying GitHub as
  identity provider, with dynamic client registration, PKCE, one-shot
  authorization codes, and rotating refresh tokens. A GitHub-backed storage
  adapter (`src/adapters/github.js`) reads and writes `.teamctx/` via the
  Git Data API for atomic, attributed commits — no server-side git clone.
  Per-request `AsyncLocalStorage` isolation for both the caller's GitHub
  session and their saved AI provider key, safe under Vercel Fluid Compute's
  instance reuse. Setup guide: [docs/mcp-hosted-setup.md](docs/mcp-hosted-setup.md).
  Self-hosting single-tenant (one deployment, one repo, env-var credentials)
  remains supported with no OAuth required.
- **Per-answer contribution attribution on `ask`.** Every
  `teamctx ask "..."` answer ends with a one-line summary of the
  contributors whose material the AI actually cited for this specific
  answer (capped at top 5). The tree passed to the AI is annotated with
  inline `[sources: c-x]` tags, and the AI is asked to end its answer with
  a `## Citations: c-x, c-y` block that teamctx parses and strips. No
  second API call.
- **`ask --audit`** expands the footer into the full source list for the
  contributions the AI cited — author, date, source system, decision tag,
  and text snippet, uncapped. Same one-call flow, richer rendering.
- **Compiled workstream markdown** gains a `## Contributors` section at
  the bottom, listing distinct authors with counts. Same source of truth
  as the `ask` footer.
- **MCP `ask` tool** gains an optional `audit: boolean` argument that
  mirrors the CLI flag.
- **Web `/ask` endpoint** accepts an `audit` field on the POST body
  (`true`/`1`/`on`/`yes` all count).
- **`teamctx reflect` preserves provenance.** When the AI-rewritten tree
  keeps a node id, the original `sourceContributionIds` are merged into
  the new node — reflection no longer loses the trail.
- **Docs**: `docs/audit.md` — end-user explainer with examples.
- **MCP full-surface**: the MCP server now exposes every mutating CLI command
  as a tool, so managers can drive teamctx from Claude Desktop / Code / Cursor
  with no terminal after the initial install + API key. New tools include
  `init`, `role_add`, `role_assign`, `workstream_split`, `workstream_use`,
  `review_approve`, `review_reject`, `snapshot_create`, `snapshot_approve`,
  `snapshot_reject`, `reflect`, `config_set`, plus read-only helpers
  `list_roles`, `list_snapshots`, `get_snapshot`, `get_current_snapshot`,
  `list_pending_reviews`, `get_status`, `get_config`, `suggest_roles`,
  `suggest_workstream_splits`.
- **Safety model** for MCP mutations: `⚠ RISKY:` preamble on every Tier 2
  tool description (so the client model warns the user before calling),
  manager-identity gate at the MCP boundary (`author` param must match
  `config.manager` when set), and a `reportBack` string on every mutating
  response the client is expected to relay to the user after the call.
- **Refactor**: every mutating CLI command extracted into a `.core.js` pure
  function that MCP and the CLI both call — same behavior, one code path.
- **Manager guide** `docs/mcp-manager-guide.md` — zero-terminal walkthrough
  with copy-paste prompts for the common flows (init, add role, contribute,
  review, snapshot, split).
- Bring-your-own-agent recipes: new `recipes/` folder with two tool-agnostic
  prompt templates (`author-contribution.md`, `cleanup-context.md`) and per-tool
  guides for Claude Code, Cursor, and ChatGPT. Copy-paste prompts that shape
  rough notes into well-formed contributions and clean up the shared tree
  before running `teamctx reflect`.
- **Tasks as first-class objects**: track units of work alongside Whys, Roles,
  and Decisions. `teamctx task add / list / show / done / reopen / assign / rm`
  are all cheap local file ops (no AI). Tasks live inline on their workstream
  file at `.teamctx/workstreams/<ws>.json` under a `tasks` array. A
  workstream without the field is treated as empty — no migration required.
- **On-demand task prompt compile**: `teamctx task compile <id> [--role <slug>]
  [--force]` generates an AI-ready markdown prompt file at
  `.teamctx/context/tasks/<task-id>.md`. Compile is the one command that
  costs an AI call. Skips re-compile if the workstream is unchanged since
  the last `compiledAt`; `--force` overrides.
- **`teamctx status`** now shows a `Tasks: N open, M done (K compiled)`
  line so the count is visible without opening any file.
- **`teamctx ask`** grounds against open tasks in the target workstream, so
  answers can reference in-flight work.
- **Docs**: `docs/tasks.md` — end-to-end explainer with the compiled file
  shape and command reference.

### Not shipping (deliberate)
- No MCP surface for tasks in this release — the CLI shape should settle
  first. A follow-up PR will expose `list_tasks`, `task_add`, `task_done`,
  `task_compile`, etc.
- No auto-regeneration of compiled task files on tree changes.
- No due dates, priorities, dependencies, or cross-workstream tasks.
- Per-sentence citation ("this claim came from contribution X"). Attribution
  is at the node level.
- Backfill of provenance on nodes that predate this feature — they simply
  show no contributors and audit-flags them as "unknown."
- A diff view of what each contribution changed in the tree.

### Changed
- **MCP `contribute` supersedes `submit_contribution`**: the new `contribute`
  tool accepts `apply` (default false = enqueue, true = write immediately),
  `decision`, and `workstream`. `submit_contribution` is kept as a deprecated
  alias with `apply: true` (matching the old immediate-apply behavior) and
  will be removed in a future release.
- **`get_context` response shape** stays as `{workstreams: [{id, tree}, ...]}`
  from the previous release; documented in
  [docs/mcp.md](docs/mcp.md#breaking-change--get_context-response-shape).

### Fixed
- **Citation anchoring**: `ask`'s citation parser now anchors on the last
  `## Citations:`-style block in the AI's response instead of the first,
  closing a truncation/forgery path where a cited contribution's own text
  quoting that heading could otherwise cut off the real answer or inject
  fake citations.
- **OAuth `redirect_uri` validation**: the token endpoint now checks the
  `redirect_uri` at code exchange against the one used at `/authorize`,
  rejecting mismatches. Defense-in-depth alongside the PKCE check that was
  already enforced end-to-end.
- **Atomic one-shot OAuth codes**: `kvTake` (used for authorization codes
  and pending-auth state) now does a single atomic `GETDEL` against the KV
  store instead of a get-then-delete, closing a narrow replay window under
  concurrent requests.

## [0.2.0] - 2026-07-21

### Added
- Open-source communication surface: roadmap, contributing guide, code of
  conduct, security policy, issue/PR templates, CI, and CODEOWNERS.
- `/ask` endpoint, minimal web UI, and `teamctx ask "<question>" [--role <slug>]`
  CLI command for asking questions grounded in team context.
- Manager approval queue: `teamctx contribute` now enqueues by default;
  `teamctx review list / approve / reject` CLI to gate contributions; rejected
  items archived under `.teamctx/rejected/` with an optional reason.
  `teamctx config manager <name>` sets an identity gate (unset = solo mode).
  New `--apply` flag on `contribute` preserves the old immediate-apply behaviour.
- Decisions as first-class objects: contributions now record a `source`
  (`cli` or `web`), and nodes backed by a `--decision` contribution render
  inline provenance markers (`*[decision — author, date, via source]*`) in
  `shared.md`, in every compiled role file, and in `teamctx ask` answers.
- `teamctx mcp` — an MCP server over stdio exposing `get_context`,
  `get_role_context`, `ask`, and `submit_contribution` for Claude Code, Claude
  Desktop, Cursor, and other MCP-aware clients. See [docs/mcp.md](docs/mcp.md).
- Context snapshots: `teamctx snapshot create / list / show / approve / reject /
  current` — freeze the whole shared context as a versioned checkpoint that the
  manager signs off on. Snapshots live under `.teamctx/snapshots/` with a
  `current.json` pointer to the last approved state. Git-style ID prefixes
  supported on all id-taking commands. Reuses the manager identity gate.
- Provider-agnostic AI layer — teamctx now runs on Anthropic (default),
  OpenAI, or Google Gemini via a shared `complete()` interface. Each
  provider reads its own API key from the environment.
- `teamctx config provider <anthropic|openai|gemini>` sets the active
  provider on an existing project; `teamctx init` also asks for it on new
  projects and shows that provider's model list.
- Per-provider curated model registry and lax model validation, so newly
  released models work without a package update.
- `teamctx workstream suggest | split | list | use` — AI clusters a project's
  Why/What/How tree into distinct sub-workstreams (e.g. product vs. tech);
  the manager accepts splits interactively and reassigns roles.
- `teamctx role assign <slug> --workstream <id>` and `--workstream <id>` on
  `contribute`, `ask`, `reflect`, and `role add`.
- Automatic one-time migration of `.teamctx/shared.json` →
  `.teamctx/workstreams/main.json` (and `context/shared.md` →
  `context/workstreams/main.md`) on first run against an existing project.

### Fixed
- **Queue + workstream:** `contribute --workstream <id>` now persists the target
  workstream on the queue item (and on the contribution audit log). Previously
  the target was silently lost between enqueue and approve.
- **Review approve + workstream:** `review approve <id>` now applies operations
  to the queue item's target workstream (defaulting to `main` for legacy queue
  items), regenerates only the role files bound to that workstream, and threads
  contributions into `serializeToMd` / `generateRoleFile` so decision markers
  render on approved contributions. Previously it always wrote to `main` and
  overwrote every role file — corrupting role files bound to other workstreams.
- **Snapshots + workstream:** `snapshot create` now captures every workstream
  in the project as an array on the snapshot object. Legacy snapshots with the
  old `shared` field still load and display as a single-workstream snapshot on
  `main`. Previously only `main` was captured — post-split projects produced
  empty snapshots.
- **MCP + workstream:** `submit_contribution` gained an optional `workstream`
  arg (defaulting to active workstream, then `main`); it now filters role-file
  regeneration to roles bound to the target and records `workstream` +
  `source: mcp` on the audit log. Two new read-only tools added for discovery:
  `list_workstreams` and `get_workstream({id})`. `teamctx status` now shows a
  per-workstream Why-node breakdown after migration and the active provider.

### Changed
- `teamctx contribute` no longer applies to shared context on submission by
  default — it enqueues under `.teamctx/queue/` and prints the review command.
  Pass `--apply` to keep the old behaviour.
- **MCP `get_context` response shape** is now `{workstreams: [{id, tree}, ...]}`
  (whole-workspace) instead of a single tree. This is an intentional breaking
  change for MCP callers — keeping the main-only response would silently
  mislead callers in workstream-migrated projects. Adapt: read
  `data.workstreams[0].tree.whys` instead of `data.whys`, or call
  `get_workstream({id: 'main'})` for the single-tree shape.

## [0.1.0] - 2026-06-14

### Added
- Initial release: `teamctx` CLI and Vercel API for AI-native team context.
