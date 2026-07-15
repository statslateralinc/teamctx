# Claude Code — recipe guide

[Claude Code](https://docs.claude.com/en/docs/claude-code/overview) is
Anthropic's terminal-based coding agent. It reads files with `@`-references
and can execute your teamctx CLI directly, so recipes flow end-to-end without
copy-paste.

## Recommended flow

Run Claude Code from your teamctx project directory (the one with `.teamctx/`).
Then, in the Claude Code prompt:

**For `author-contribution.md`:**

```
Use @recipes/author-contribution.md with this rough note:

<your rough note here>

And this current shared context: @.teamctx/context/shared.md

When you're done, run `teamctx contribute "..."` with the result. Add
--decision if the recipe says it's a decision.
```

Claude Code will read both files, produce the shaped contribution, and offer
to run the `teamctx contribute` command for you.

**For `cleanup-context.md`:**

```
Use @recipes/cleanup-context.md on @.teamctx/context/shared.md.
Focus: <optional — leave blank for whole tree>

Show me the diff, and if I approve, offer to write the changes to
.teamctx/context/shared.md.
```

Review the proposed diff carefully before letting Claude Code apply it —
`.teamctx/context/shared.md` is the human-readable projection of `shared.json`
and hand-edits are fine, but the file is committed to your team's repo, so
mistakes are visible.

## Tips

- If you use Claude Code in this repo often, consider adding a project-level
  `.claude/commands/` slash command that wraps either recipe. See the [slash
  commands docs](https://docs.claude.com/en/docs/claude-code/slash-commands).
- Claude Code respects your `CLAUDE.md` files. If your team has conventions
  about how contributions should be worded (tone, level of detail), put them
  in `CLAUDE.md` and the recipes will pick them up automatically.
- For a full agentic flow, ask Claude Code to run `teamctx status` first, so
  it sees what workstreams and roles exist before shaping the contribution.
