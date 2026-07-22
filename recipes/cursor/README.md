# Cursor — recipe guide

[Cursor](https://cursor.com) is an AI-first code editor. Its chat and
agent/composer panels can reference files in your workspace with `@`, which
makes teamctx recipes easy to run without copy-paste.

## Recommended flow

Open the teamctx project in Cursor. Open the AI panel (Chat, or
Composer/Agent for an editing session).

**For `author-contribution.md`:**

In the AI panel, type:

```
Follow the recipe in @recipes/author-contribution.md.

My rough note: <your rough note here>
Current shared context: @.teamctx/context/shared.md
```

Cursor will pull both files into the conversation. Read the output; if it
looks right, run the resulting `teamctx contribute "..."` in Cursor's
integrated terminal (add `--decision` if the recipe flagged it).

**For `cleanup-context.md`:**

Use Composer/Agent mode so it can propose edits to files directly:

```
Follow the recipe in @recipes/cleanup-context.md against
@.teamctx/context/shared.md. Focus: <optional — leave blank for whole tree>.

Propose the rewrite as edits to .teamctx/context/shared.md so I can review
the diff in the editor before accepting.
```

Review the diff in Cursor's editor before accepting the changes. Reject
anything that drops a decision or changes intent.

## Tips

- If your team wants consistent contribution style, add a rule under
  `.cursor/rules/` (or `.cursorrules`) that describes the tone and detail
  level. The recipes will inherit it automatically.
- Reference `.teamctx/config.json` too if you want the AI to know the
  project name and role list — this helps it place contributions correctly.
- For quick one-off contributions, the chat panel with `@`-references is
  faster than opening Composer. Use Composer only when you want the AI to
  apply changes to files directly.
