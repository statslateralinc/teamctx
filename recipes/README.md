# Recipes: bring your own agent

Copy-paste prompts you can feed into your AI tool of choice to do the two
things teamctx users do most often. Recipes are tool-agnostic; each tool has
a short guide for how to invoke them.

## Recipes

| Recipe | When to use |
|---|---|
| [`author-contribution.md`](author-contribution.md) | You know something the team should know, but you're not sure how to phrase it as a `teamctx contribute` argument. |
| [`cleanup-context.md`](cleanup-context.md) | The shared tree has grown noisy or repetitive and you want a human-in-the-loop pass before running `teamctx reflect`. |

## Use with your tool

| Tool | Guide |
|---|---|
| Claude Code | [`claude-code/`](claude-code/README.md) — `@`-reference the recipe + context files; Claude Code can run `teamctx contribute` for you. |
| Cursor | [`cursor/`](cursor/README.md) — `@`-reference in the AI panel; use Composer mode when you want the AI to edit files directly. |
| ChatGPT | [`chatgpt/`](chatgpt/README.md) — copy-paste the recipe and inputs, then paste output back into your terminal. |

Working with a different tool (Windsurf, Zed, a local model, an agent SDK)?
The two recipes are plain markdown with `<PASTE …>` placeholders — they
should work anywhere. PRs adding a new tool guide are welcome; see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Design notes

- **Prompts are tool-agnostic.** The recipe files themselves don't assume any
  specific AI tool. Per-tool folders only document *how to feed the prompt
  in*. This keeps maintenance low and lets you add more tools with a single
  new subfolder.
- **Output is pasteable back into teamctx.** `author-contribution.md`'s output
  goes straight into `teamctx contribute "..."`; `cleanup-context.md`'s output
  is reviewable as a diff against `.teamctx/context/shared.md`.
- **Guardrails matter.** Both recipes explicitly tell the AI not to invent
  facts, not to drop decisions, and to ask when things are unclear. Change
  them if your team wants different guardrails.
