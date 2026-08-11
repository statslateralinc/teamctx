# Proposals

These are **contributor-facing write-ups** for the larger items on the
[roadmap](../../ROADMAP.md). Each one explains the problem, what exists today, a
*suggested* approach (one way to do it — not the only way), and where to start.

**They are suggestions, not specifications set in stone.** If you want to build one:

1. Comment on (or open) the matching issue so we don't duplicate work.
2. Feel free to propose a different approach in a [Discussion][d] — these write-ups
   are starting points, and a better idea is always welcome.
3. See [`CONTRIBUTING.md`](../../CONTRIBUTING.md) for setup, tests, and the DCO sign-off.

[d]: https://github.com/StatsLateral/teamctx/discussions

## Current proposals

| Proposal | Serves | Rough size |
|----------|--------|-----------|
| [Context import (cold-start onboarding)](context-import.md) | Bring your own tools · Managers in control | Medium–Large (splittable) |
| [Import connector contract](import-connectors.md) | Bring your own tools | Medium (one PR per connector after) |
| [Slack import connector](import-slack.md) | Bring your own tools | Medium (first connector on the contract) |
| [Local team-productivity metrics](local-metrics.md) | Prove team productivity | Medium (splittable) |

## Shipped proposals 🎉

Kept for reference — these were built (see [CHANGELOG](../../CHANGELOG.md)):

| Proposal | Landed as |
|----------|-----------|
| [Provider-agnostic AI layer](provider-agnostic-ai.md) | `src/providers/` — Claude, OpenAI, Gemini behind one interface |
| [Public API + MCP server](external-api-and-mcp.md) | `teamctx mcp` full tool surface (#14); hosted variant in review (#17) |
| [Manager approval queue](manager-approval-queue.md) | `teamctx review list/approve/reject` + manager identity gate |
