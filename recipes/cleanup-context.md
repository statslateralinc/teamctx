# Recipe: Clean up shared context

Use this to review and reshape the existing shared context tree — prune stale
items, tighten wording, and reorganize — before running `teamctx reflect` or
hand-editing `.teamctx/context/shared.md`.

**When to use:** the shared tree has grown noisy or repetitive, several
contributions are saying similar things, or you want a human-in-the-loop pass
before letting `teamctx reflect` do it automatically.

**Inputs:** the current `shared.md`, and optionally a focus area (e.g. "just
the How section", "the auth workstream").

**Output:** a rewritten tree you can review as a diff against current
`shared.md`, plus a list of what was pruned or merged and why.

---

## The prompt

Copy everything below into your AI tool. Replace the two `<PASTE …>` blocks
with the current shared context and your optional focus.

````
You are helping me clean up the shared team-context tree in teamctx. The tree
is organized as Why / What / How, one workstream at a time. Cleanup means:
tighter wording, removing duplication, merging near-duplicates, and pruning
items that are stale or superseded. It does NOT mean adding new information
that isn't already in the tree.

Here is the current shared context:

<PASTE .teamctx/context/shared.md HERE>

Focus area (optional — if blank, review the whole tree):

<PASTE FOCUS AREA HERE, OR LEAVE BLANK>

Please produce:

1. A rewritten version of the tree in the same Why / What / How structure,
   with tighter wording and no duplication. Keep the same section headings so
   I can diff it against the current file.
2. A short list of what changed: items pruned, items merged, and items whose
   wording was tightened — each with a one-line reason.
3. Flag anything that looks like a contradiction between two nodes so I can
   resolve it manually.

Rules:

- **Never drop an item marked as a decision** (`[decision]`, `**Decision:**`,
  or similar). Decisions are protected. Tighten wording only.
- **Preserve intent.** If you're unsure whether two items are duplicates or
  are actually saying different things, keep them both and flag them for me.
- **Don't invent facts.** If a section is thin, leave it thin. Don't pad.
- **No new sections.** Only rework what's already in the tree.
````

---

## Tips

- Run this on one workstream at a time if your tree is large — smaller inputs
  produce more careful cleanups.
- Save the AI's output to a scratch file, diff it against
  `.teamctx/context/shared.md`, and apply the changes you like by hand. This
  keeps you in control of what actually lands.
- `teamctx reflect` does a similar cleanup pass automatically. Use this
  recipe when you want to steer the cleanup yourself, or when you want to
  preview what a reflect pass might do.

## See also

- [`recipes/author-contribution.md`](author-contribution.md) — for adding new
  content, not reshaping existing content.
- Per-tool guides: [Claude Code](claude-code/README.md) · [Cursor](cursor/README.md) · [ChatGPT](chatgpt/README.md)
