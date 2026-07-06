# Implementation Plan: MCP Server (`teamctx mcp`)

**Branch:** `feat/mcp-server` · **Proposal:** [external-api-and-mcp.md](../proposals/external-api-and-mcp.md) · **Status:** In progress

## Goal

Add a `teamctx mcp` subcommand that starts a Model Context Protocol server over stdio, exposing four tools (`get_context`, `get_role_context`, `ask`, `submit_contribution`) so any MCP-aware client (Claude Code, Claude Desktop, Cursor) can read and write the local `.teamctx/` state.

Scope is intentionally narrow — this is Part B of the proposal, done standalone. Part A (the versioned `/api/v1/*` HTTP surface) is deferred; the MCP server calls `src/*` modules directly, so there is one code path shared with the CLI.

## Non-goals (for this PR)

- HTTP transport for MCP (stdio only)
- Auth (local server, filesystem-scoped)
- Exposing `reflect`, `init`, or other management commands as tools
- Streaming responses
- The `/api/v1/*` refactor

## Steps

- [ ] **1. Add dependency**
      `npm i @modelcontextprotocol/sdk` — official SDK, gives `Server` + `StdioServerTransport`.

- [~] **2. Extend `source` union to include `'mcp'`** — *deferred*
      The `source` field is introduced by the open `feat/decisions-first-class` PR, not by `main`. To keep this branch independent, `submit_contribution` calls `contributeCommand` without a source arg. Follow-up commit (after both PRs land) wires `source: 'mcp'`.

- [ ] **3. Create `mcp/server.js`**
      Registers four tools, connects stdio transport. Each tool is a thin wrapper over existing modules:
      - `get_context` — no args, returns `readShared()` from `src/storage.js`
      - `get_role_context` — `{ role: string }`, returns `readRoleFile(slug)`
      - `ask` — `{ question: string, role?: string }`, wraps `answerQuestion()` from `src/context.js`
      - `submit_contribution` — `{ text: string, author?: string }`, calls `contributeCommand(text, { autoApprove: false, decision: false, source: 'mcp' })`

- [ ] **4. Create `cli/commands/mcp.js`**
      Thin entrypoint. Dynamic-imports `mcp/server.js` so the SDK isn't loaded on unrelated CLI invocations.

- [ ] **5. Wire subcommand in `cli/index.js`**
      Add `case 'mcp':` that awaits the command.

- [ ] **6. Tests: `mcp/server.test.js`**
      Vitest. Uses SDK's in-memory transport. Mock `src/ai.js` and `src/storage.js` as needed.
      - `tools/list` returns the four tools with correct names and schemas
      - `tools/call` for each tool returns the expected shape
      - `submit_contribution` writes with `source: 'mcp'`

- [ ] **7. Docs: `docs/mcp.md`**
      Paste-in config snippets for Claude Code / Claude Desktop, note that `cwd` must point at the teamctx repo, note that the provider API key must be present in the environment the client passes through.

- [ ] **8. Manual smoke test**
      `npm link` the branch, add the JSON to a real client's config, verify a live `get_context` and `submit_contribution` round-trip.

- [ ] **9. Changelog**
      One line under a new `## Unreleased` section in `CHANGELOG.md`.

- [ ] **10. Delete this plan file before opening the PR**
      Or move it to a PR-description draft — either way, don't ship the plan.

## Commit strategy

Small commits, single author (Satyagya), no Co-Authored-By trailers. Rough grouping:

1. `chore: add @modelcontextprotocol/sdk dependency`
2. `feat(contribute): accept 'mcp' as a contribution source`
3. `feat(mcp): add server exposing four tools over stdio`
4. `feat(cli): wire teamctx mcp subcommand`
5. `test(mcp): cover tools/list and each tools/call path`
6. `docs: add MCP server setup guide`
7. `docs: log MCP server in changelog`

## Open questions to resolve before PR

- Should `submit_contribution` return the applied summary/ops, or just an ack? (Leaning: return `{ id, summary }` so the client can echo back what it recorded.)
- Should `ask` accept a raw `role` slug, or default to the config's `me` role when omitted? (Leaning: raw slug, no default — keeps the tool deterministic.)
- Ship the MCP server as part of the `teamctx` package or a separate `@teamctx/mcp` bin? (Leaning: same package — simpler install for users.)
