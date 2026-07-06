# MCP Server

teamctx ships an [MCP](https://modelcontextprotocol.io) server so any MCP-aware
client (Claude Code, Claude Desktop, Cursor, and others) can read and write
your team context as tools.

## Tools exposed

| Tool | Purpose |
| --- | --- |
| `get_context` | Return the full Why/What/How tree as JSON. |
| `get_role_context` | Return a role's compiled markdown by slug. |
| `ask` | Answer a question using shared context (and optionally a role's perspective). |
| `submit_contribution` | Add a contribution; AI updates the tree, regenerates role files, commits. |

## Requirements

- `teamctx` installed on your PATH (`npm i -g teamctx`).
- A teamctx project on disk (the folder that contains `.teamctx/`).
- The AI provider key available in the environment the MCP client passes through
  (e.g. `ANTHROPIC_API_KEY`).

## Claude Code / Claude Desktop

Add the following to your client config (Claude Desktop:
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows; Claude Code: see
`claude mcp` docs):

```json
{
  "mcpServers": {
    "teamctx": {
      "command": "teamctx",
      "args": ["mcp"],
      "cwd": "/absolute/path/to/your/teamctx/project"
    }
  }
}
```

`cwd` is required — the server reads `.teamctx/` from there. If you work in
multiple teamctx projects, register one entry per project with a distinct name
(e.g. `teamctx-web`, `teamctx-mobile`).

## Cursor

Cursor uses the same MCP config shape. Add the block above under Cursor's MCP
settings.

## Manual test

```
teamctx mcp
```

Nothing prints — the server is waiting on stdio. Kill it with Ctrl+C. Confirm it
works end-to-end by registering it with a client and asking the model to call
`get_context`.

## Notes

- Contributions submitted via MCP are committed to git with `(via mcp)` in the
  commit message so they are easy to spot in `git log`.
- No auth — the server has full local filesystem access, same as the CLI.
- stdio transport only. HTTP transport is a follow-up once the `/api/v1/*`
  surface lands (see [external-api-and-mcp.md](proposals/external-api-and-mcp.md)).
