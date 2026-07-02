# Roadmap

teamctx keeps your team's shared context in a simple, why / what / how format to suppport "bring your own ai tool" for small teams.
It compiles a role-specific file for each person to bring to their AI tool without losing context.

**The vision** (the bets that guide this roadmap):

1. **No platform lock-in** — use any AI provider (Claude, OpenAI, a local model). teamctx organizes context and answers `ask`, but you choose the engine.
2. **Bring your own tools & agents** — team members work in whatever AI tool they like, then feed distilled decisions back into the shared context.
3. **Managers stay in control** — they approve both the work and the shared context before it lands.
4. **Structured workstreams** — organize context into assignable, nestable workstreams that can sync out to your project-management tools.

> ⚠️ **This roadmap is a set of suggestions, not commitments.** "Now" is roughly
> committed; "Next" is likely; "Later" is directional. Want to build one? Comment on
> its issue or open a [Discussion][d]. **Newcomers:** look for 🟢 (good first issue).
> Bigger items have a write-up in [`docs/proposals/`](docs/proposals/).

[d]: https://github.com/StatsLateral/teamctx/discussions

## Now
- 🟢 Wire up the `ask` endpoint + a minimal web UI — *ask / support*
- **Provider-agnostic AI layer** — put the AI calls behind a small provider interface so teamctx can use Claude, OpenAI, or a local model — *no lock-in · the keystone item* · [proposal](docs/proposals/provider-agnostic-ai.md)

## Next
- **Public API + MCP server** — a stable, versioned API and an MCP server so any external AI tool or agent can read & write team context and call teamctx — *bring your own tools & agents* · [proposal](docs/proposals/external-api-and-mcp.md)
- **Manager approval queue** — a real gate where contributions wait for a manager to approve before they enter shared context; basic roles/permissions — *managers in control* · [proposal](docs/proposals/manager-approval-queue.md)
- 🟢 **Decisions as first-class objects** — capture source / author / date and surface them in context and `ask` — *bring your own tools & agents (distillation)*
- **Sub-workstreams within workstreams** — let a workstream contain nested workstreams, not just a flat why/what/how tree — *structured workstreams*
- 🟢 **Assign workstreams to team members** — give each workstream an owner — *structured workstreams*

## Later
- **Approve the context itself** — snapshot/version the shared context so a manager can sign off on a known-good state — *managers in control*
- **Export workstreams to project-management tools** — push workstreams out to Jira, Linear, Asana, or Trello — *structured workstreams*
- 🟢 **Bring-your-own-agent recipes** — ready-made prompts/templates for Claude Code, Cursor, or ChatGPT to author or clean up context — *bring your own tools*
- Self-host guide
- Non-git storage backends
