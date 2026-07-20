# MCP Server

teamctx ships an [MCP](https://modelcontextprotocol.io) server so any MCP-aware
client (Claude Code, Claude Desktop, Cursor, Cline, Antigravity, and others) can
read and write your team context as tools.

For end-user setup, see the "Use teamctx from your AI tool (MCP)" section in the
[README](../README.md). This file is the technical reference.

## Tools exposed

| Tool | Purpose |
| --- | --- |
| `get_context` | Return the full Why/What/How tree as JSON. |
| `get_role_context` | Return a role's compiled markdown by slug. |
| `ask` | Answer a question using shared context (and optionally a role's perspective). |
| `submit_contribution` | Add a contribution; AI updates the tree, regenerates role files, commits. |

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

## Environment variables

- `ANTHROPIC_API_KEY` — required for `ask` and `submit_contribution`. Pass it
  via the client's `env` block, export it in your shell, or place it in
  `.env.local` at the project root (the server loads that automatically).
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

## Notes

- Contributions submitted via MCP are committed to git with `(via mcp)` in the
  commit message so they're easy to spot in `git log`.
- No auth — the server has full local filesystem access, same as the CLI.
- stdio transport only. Remote/HTTP transport is a follow-up once the
  `/api/v1/*` surface lands (see
  [external-api-and-mcp.md](proposals/external-api-and-mcp.md)).
