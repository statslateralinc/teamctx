# Recipe: Author a contribution

Use this to turn a rough thought into a well-shaped contribution you can pass
straight to `teamctx contribute "..."`.

**When to use:** you know something the team should know (a decision, a change
of direction, a new constraint) but you're not sure how to phrase it so it
slots cleanly into the shared Why/What/How tree.

**Inputs:** your rough note, plus the current shared context so the AI can
place the update in the right part of the tree.

**Output:** one short block of text you can paste as the argument to
`teamctx contribute`. If it's a decision, the recipe reminds you to add
`--decision` on the CLI.

---

## The prompt

Copy everything below into your AI tool. Replace the two `<PASTE …>` blocks
with your rough note and the contents of `.teamctx/context/shared.md`.

````
You are helping me shape a contribution to my team's shared context in teamctx.
teamctx organizes team context as a Why / What / How tree, one workstream at a
time. A good contribution is one short, self-contained update that a manager
can approve at a glance.

Here is my rough note:

<PASTE YOUR ROUGH NOTE HERE>

Here is the current shared context so you can place the update in the right
part of the tree (and avoid repeating or contradicting something that's
already there):

<PASTE .teamctx/context/shared.md HERE>

Please produce:

1. A single short contribution (2-4 sentences, plain prose — no bullet lists,
   no headings) that I can pass directly to `teamctx contribute "..."`. It
   should read as a natural update, not as a diff or a form.
2. Tell me whether this is a **decision** (something the team is now committed
   to and shouldn't be pruned later) or a regular update. If it's a decision,
   remind me to run `teamctx contribute "..." --decision`.
3. Say which part of the tree it most naturally belongs to (Why / What / How,
   and which existing node if any) — one line.
4. If any part of my rough note is ambiguous or contradicts the current
   context, ask me before writing the contribution. Don't invent facts.

Keep the tone factual and specific. Don't add motivational language,
buzzwords, or a summary of what teamctx is.
````

---

## Tips

- If your update is really two updates, ask the AI to split them into two
  separate contributions and run `teamctx contribute` twice.
- If the AI asks you a clarifying question, answer it before it writes the
  contribution — this is much better than editing a bad first draft.
- The `--decision` flag matters: decisions are protected from `teamctx
  reflect`'s cleanup pass, so they stick around as durable commitments.

## See also

- [`recipes/cleanup-context.md`](cleanup-context.md) — for reshaping existing
  context rather than adding to it.
- Per-tool guides: [Claude Code](claude-code/README.md) · [Cursor](cursor/README.md) · [ChatGPT](chatgpt/README.md)
