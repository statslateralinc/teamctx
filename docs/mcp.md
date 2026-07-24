# MCP Server

teamctx ships an [MCP](https://modelcontextprotocol.io) server so any MCP-aware
client (Claude Code, Claude Desktop, Cursor, Cline, Antigravity, and others) can
read, write, and manage your team context as tools.

For end-user setup, see the "Use teamctx from your AI tool (MCP)" section in the
[README](../README.md), or the manager-focused walkthrough in
[docs/mcp-manager-guide.md](mcp-manager-guide.md). This file is the technical
reference for every tool exposed.

## Design principle

Tools are organized into three tiers by blast radius. Every tool that mutates
state carries a `⚠ RISKY:` preamble in its description so the client model
surfaces the intent to the user before calling, and returns a `reportBack`
string the client is expected to relay after the call.

Anything that reshapes the project (`init`, `workstream_split`, `role_add`,
`role_assign`) or gates approval (`review_approve`, `snapshot_approve`) is
either manager-gated or explicitly flagged as structural.

## Tools

### Tier 0 — read-only

| Tool | Purpose |
| --- | --- |
| `get_context` | Return every workstream's tree as `{workstreams: [{id, tree}, ...]}`. |
| `list_workstreams` | Enumerate workstreams with `{id, name, isActive, whyCount, roles}`. |
| `get_workstream({id})` | Fetch a single workstream tree by id. |
| `get_role_context({role})` | Return a role's compiled context markdown by slug. |
| `list_roles` | List all defined roles (slug, name, workstream). |
| `list_snapshots` | List all snapshots plus the current-approved id. |
| `get_snapshot({id})` | Fetch a snapshot by id or unique prefix. |
| `get_current_snapshot` | Fetch the current-approved snapshot pointer. |
| `list_pending_reviews` | List queued contributions awaiting manager review. |
| `get_status` | Full project status payload as structured JSON. |
| `get_config` | Public config (never returns API keys). |
| `ask({question, role?})` | Answer a question grounded in shared context. |
| `suggest_roles({workstream?})` | AI-suggest 3-5 roles (dry-run; does not create them). |
| `suggest_workstream_splits` | AI-propose sub-workstream splits (dry-run). |

### Tier 1 — additive writes

| Tool | Purpose |
| --- | --- |
| `contribute({text, workstream?, decision?, apply?, author?})` | Add a contribution. Defaults to enqueueing for manager approval; set `apply: true` to write immediately (subject to manager gate). |
| `submit_contribution` | **Deprecated** alias for `contribute` with `apply: true`. Kept for one release; prefer `contribute`. |

### Tier 2 — structural / gated (⚠ RISKY)

Every tool below carries the `⚠ RISKY:` preamble in its description. Tools
marked *(manager-gated)* require the caller to pass `author` matching
`config.manager` when a manager identity is set on the project.

| Tool | Purpose |
| --- | --- |
| `init({project, me, provider?, model?, ...})` | Bootstrap a new teamctx project. Refuses if already initialized. Requires a git repo. |
| `role_add({name, responsibilities, ...})` | Create a role, generate its context file, commit. |
| `role_assign({slug, workstream})` | Move a role to a different workstream and regenerate. |
| `workstream_split({accepted: [...]})` | Apply accepted splits from `suggest_workstream_splits`. |
| `workstream_use({id})` | Change the active workstream. |
| `review_approve({id, author})` | *(manager-gated)* Apply a queued contribution. |
| `review_reject({id, reason?, author})` | *(manager-gated)* Archive a queued contribution. |
| `snapshot_create({message?})` | Freeze the workspace as a pending snapshot. |
| `snapshot_approve({id, author})` | *(manager-gated)* Approve and set current pointer. |
| `snapshot_reject({id, reason?, author})` | *(manager-gated)* Reject a pending snapshot. |
| `reflect({workstream?})` | AI-rewrite a workstream's tree. Can meaningfully change how context reads. |
| `config_set({key, value})` | Write a single config key. Whitelisted keys only: `provider`, `model`, `githubRawBase`, `manager`, `managerEmail`, `deployUrl`, `autoPush`. |

## Manager gate

The gate is identity-based, not credential-based — the same design as the CLI.
When `config.manager` is set on a project, Tier 2 tools marked *(manager-gated)*
compare the incoming `author` param to it and refuse if they don't match. In
solo mode (no `config.manager`), all Tier 2 tools are un-gated.

Because MCP has no authentication of its own, any caller with access to the
client can claim any identity. This is fine for local single-user projects —
the same is true of the CLI — but should not be relied on as a security
boundary. Track this in your threat model as a pre-1.0 limitation.

## reportBack

Every mutating tool's response includes a `reportBack` string like:

```
"Tell the user: approved contribution q-abc by alice on workstream 'tech' (2 ops, regenerated roles: engineer, pushed)."
```

The client is expected to relay this to the user after each mutating call, so
the user always knows what happened without having to inspect the raw response.

## Breaking change — `get_context` response shape

Since the workstream-integration release, `get_context` returns
`{workstreams: [{id, tree}, ...]}` instead of a single tree. For projects that
have never been split into sub-workstreams, this is an array of one
(`workstreams[0].tree` holds what used to be the top-level object). Callers
that used to read `response.whys` should now read
`response.workstreams[0].tree.whys`, or call `get_workstream({id: 'main'})`.

## Project-dir resolution

The server needs to know which `.teamctx/` project to operate on. It resolves
this in strict priority order:

1. `--project <path>` (or `-p <path>`, or `--project=<path>`) on the command
2. `TEAMCTX_PROJECT_DIR` environment variable
3. The process's working directory at spawn time

The `cwd` field in MCP client configs is unreliable on Windows because of how
npm-installed `.cmd` shims interact with client spawn semantics. **Prefer
`--project` or the env var**; do not rely on `cwd`.

Dir resolution is lazy — the server always starts cleanly. If the resolved
path has no `.teamctx/`, the error surfaces only when a tool is called
(`Not in a teamctx project`), which lets the client at least list tools.

The `init` tool is the one exception: it *creates* `.teamctx/` at the resolved
project dir, so it works even when the dir isn't yet a teamctx project. It
still requires the dir to be a git repository.

## Environment variables

- `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` / `GEMINI_API_KEY` depending on
  provider) — required for `ask`, `contribute`, `reflect`, `role_add`,
  `suggest_roles`, `suggest_workstream_splits`. Pass via the client's `env`
  block, export in your shell, or place in `.env.local` at the project root.
- `TEAMCTX_PROJECT_DIR` — optional override for the project path.

## Config example (any client)

```json
{
  "mcpServers": {
    "teamctx": {
      "command": "teamctx",
      "args": ["mcp", "--project", "/absolute/path/to/your/teamctx/project"],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

For multiple projects, use one entry per project with a distinct server name.

## Not exposed

Some CLI commands remain terminal-only:

- `teamctx setup` — creates a GitHub repo via the `gh` CLI. Requires external
  auth and interactive prompts. Use `init` from MCP instead once the repo
  exists.
- `teamctx pull` — processes pending web contributions interactively. Not
  meaningful as a single MCP call.

## Notes

- Contributions submitted via MCP are committed to git with `(via mcp)` in the
  commit message so they're easy to spot in `git log`.
- No auth — the server has full local filesystem access, same as the CLI.
- stdio transport only. Remote/HTTP transport is a follow-up once the
  `/api/v1/*` surface lands (see
  [external-api-and-mcp.md](proposals/external-api-and-mcp.md)).
