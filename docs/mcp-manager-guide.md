# Run teamctx from Claude Desktop with zero terminal

This guide is for managers who want to use teamctx entirely from their AI tool
of choice. If you're a developer comfortable with the CLI, you can skip this
and read the [MCP technical reference](mcp.md) instead.

The one manual step you cannot avoid: **initial install and API key**. After
that, everything happens in Claude Desktop (or Cursor, or Claude Code — any
MCP-aware client works).

---

## One-time setup

Ask a teammate (or your own developer self, for five minutes) to do this once
on your laptop:

1. **Install Node.js 18+** — [nodejs.org](https://nodejs.org/) has an installer.
2. **Install teamctx globally:**
   ```
   npm install -g teamctx
   ```
3. **Create a folder for your project** and make it a git repo:
   ```
   mkdir ~/my-project && cd ~/my-project && git init
   ```
4. **Open Claude Desktop → Settings → Developer → Edit Config** and merge in:
   ```json
   {
     "mcpServers": {
       "teamctx": {
         "command": "teamctx",
         "args": ["mcp", "--project", "/absolute/path/to/my-project"],
         "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
       }
     }
   }
   ```
   Replace the path and API key.
5. **Fully quit and reopen Claude Desktop** (⌘Q on macOS, tray → Quit on
   Windows — closing the window isn't enough).

Verify: in a new chat, the tools icon in the composer should show ~25 teamctx
tools. If you only see `init`, that's expected — the project isn't initialized
yet. Move on to the next step.

---

## Bootstrap the project (via Claude)

Open a new chat and say:

> Initialize teamctx for my project. The project name is "Acme", I'm "Priya",
> we'll use Anthropic as the provider. Auto-push should be on.

Claude will call the `init` tool. It should report back something like:
*"teamctx initialized at ~/my-project for project Acme. Committed."*

If it says the `ANTHROPIC_API_KEY` isn't set, you either forgot the `env` block
in the config or the key is invalid. Fix and restart Claude Desktop.

---

## Common workflows

Every phrase below is a real prompt you can paste into Claude Desktop after
setup. Claude will pick the right tool.

### Add a role

> Add a role for "Head of Growth" — they own paid acquisition and lifecycle
> emails, and they don't worry about engineering roadmap.

Claude calls `role_add`. You'll get a `reportBack` confirming the slug and the
workstream it was placed on.

### Ask Claude to suggest roles

> Suggest a few roles that would benefit from their own context file.

Claude calls `suggest_roles` (dry-run), shows you the options, and only calls
`role_add` for the ones you approve.

### Contribute an update

> Add this to the growth workstream: we're pausing paid ads on Google in Q3
> and doubling down on LinkedIn.

Claude calls `contribute`. By default this **enqueues for your approval** —
you'll need to approve it (next step) before it lands. Add "apply immediately"
to skip the queue if you want.

### Log a decision

> Log this as a decision: we picked PostgreSQL over MongoDB because our
> workload is relational and we want joins to be trivial.

Claude calls `contribute` with `decision: true`. Decisions are marked as
first-class and won't be pruned by `reflect`.

### Review the approval queue

> What contributions are waiting for my review?

Claude calls `list_pending_reviews`. You'll see each item's author, workstream,
and summary. Then:

> Approve the growth one from Priya.

Claude calls `review_approve` with your identity as `author`. If a manager
identity is set on the project and you're not it, the call refuses — that's
the gate working. Set yourself as manager once with:

> Set me as the manager. My identity is "Priya".

which calls `config_set({key: "manager", value: "Priya"})`.

### Snapshot before a big change

> Create a snapshot called "pre-Q3 planning" and then approve it.

Claude calls `snapshot_create`, then `snapshot_approve`. You now have a
versioned checkpoint you can inspect later.

### Split a workstream

> Suggest how to split the main workstream, then walk me through the
> proposals.

Claude calls `suggest_workstream_splits` (dry-run), presents the proposed
splits, and only calls `workstream_split` for the ones you accept. You can
also tell it which roles to move to each new workstream.

### Restructure carefully

For anything structural — `role_add`, `role_assign`, `workstream_split`,
`reflect`, `config_set` — Claude sees a ⚠ RISKY warning in the tool
description and should confirm intent with you before calling. If it doesn't,
push back and tell it to confirm first. This is how the safety layer is
supposed to work.

---

## What Claude Desktop *can't* do via MCP

Deliberately terminal-only:

- **`teamctx setup`** — creates a GitHub private repo via the `gh` CLI. Needs
  external auth. Use `init` on a folder you've already made into a git repo.
- **`teamctx pull`** — processes web-form contributions from a Vercel-hosted
  `/contribute` page. Interactive per-item; not a good MCP fit.

Everything else is available.

---

## When things go wrong

**"Not in a teamctx project"** — the `--project` path in your MCP config
doesn't contain a `.teamctx/` folder. Either fix the path or ask Claude to run
`init` for you (the one tool that works before init'd state exists).

**"only the configured manager (X) may approve/reject"** — you're calling a
manager-gated tool but the `author` doesn't match. Either pass your identity
in the prompt ("approve as Priya") or update the config
(`config_set({key: "manager", value: "your-name"})`).

**Tools don't show up after editing the config** — you didn't fully quit
Claude Desktop. ⌘Q, don't just close the window.

**Tool call fails with an API error** — your `ANTHROPIC_API_KEY` (or provider
equivalent) is missing or invalid. Fix in the MCP config, restart Claude.

**Claude refuses to call a risky tool** — this is by design. Confirm what you
want in explicit terms and it will proceed.

---

## Related reading

- [MCP technical reference](mcp.md) — every tool's exact schema and semantics
- [README](../README.md) — general teamctx intro and CLI usage
