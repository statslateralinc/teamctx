# Plan: Bring-your-own-agent recipes

**Branch:** `feat/agent-recipes` (off `main`, no code dependencies)
**Roadmap:** "Later" — 🟢 *bring your own tools*
**PR shape:** Single docs-only PR delivering the MVP recipe pack.

---

## Goal

Give team members ready-made prompts they can paste into their AI tool of choice
(Claude Code, Cursor, ChatGPT) to help them do the two things teamctx users do
most often:

1. **Author a good contribution** — shape a rough thought into a well-structured
   Why/What/How update before running `teamctx contribute`.
2. **Clean up shared context** — rewrite/prune the existing tree for clarity,
   similar to what `teamctx reflect` does, but human-in-the-loop in the user's
   own AI tool.

Closes the "bring your own tools & agents" vision bet with the smallest useful
surface: a set of copy-paste prompts, no new code paths.

## In scope (this PR)

- New top-level `recipes/` directory, organised by AI tool:
  ```
  recipes/
    README.md                    # index + how to use
    author-contribution.md       # tool-agnostic prompt template
    cleanup-context.md           # tool-agnostic prompt template
    claude-code/
      README.md                  # Claude Code-specific tips (slash commands, etc.)
    cursor/
      README.md                  # Cursor-specific tips (composer mode, @-refs)
    chatgpt/
      README.md                  # ChatGPT-specific tips (paste + iterate)
  ```
- Two core recipe prompts (tool-agnostic markdown, with placeholders):
  - **author-contribution.md** — takes rough input + current `shared.md`, outputs
    a well-shaped contribution the user can pass to `teamctx contribute`.
  - **cleanup-context.md** — takes current `shared.md`, outputs a rewritten tree
    the user can review before running `teamctx reflect` or hand-editing.
- Per-tool README files explaining *how* to use each recipe in that tool
  (drag-and-drop the file, `@` reference, paste, etc.). Keep short — one screen.
- `recipes/README.md` as the index: what each recipe does, when to use it, and
  the tool-specific pointers.
- Main `README.md` gets a new "Recipes" section linking to `recipes/README.md`.
- `CHANGELOG.md` entry under `[Unreleased] Added`.

## Out of scope (follow-ups)

- **Recipes for specific workflows** (e.g. "extract decisions from Slack",
  "generate role suggestions from a job description"). Land the two core ones
  first; more can be added as separate PRs once the pattern is settled.
- **`teamctx recipe list` CLI command** — nice for discoverability but adds a
  code surface. Docs-only for MVP; add a command later if users ask.
- **Recipes for local models / other tools** (Ollama, Windsurf, Zed). Start with
  the three most-used; expand later.
- **Interactive/agentic recipes** that call teamctx CLI themselves. Requires the
  MCP server work to be released and stable.
- **Recipe versioning / update-notifications.**

## Recipe design constraints

- **Tool-agnostic core prompts.** The recipe prompt itself must not assume any
  specific tool; each tool folder just documents *how to feed the prompt in*.
  Keeps maintenance low and lets us add more tools without rewriting content.
- **Placeholders, not filled examples.** Use `<PASTE YOUR ROUGH NOTE HERE>` and
  `<PASTE .teamctx/context/shared.md HERE>`. Users substitute inline.
- **Output must be pasteable back into teamctx.** The `author-contribution`
  recipe's output should be usable directly as the argument to
  `teamctx contribute "..."`. The `cleanup-context` recipe's output should be
  reviewable as a diff against current `shared.md`.
- **No secrets, no repo-specific paths in examples.** Recipes ship in the OSS
  repo and are read by every user.

## File-by-file plan

1. `recipes/README.md` — index. Lists both recipes with a one-line "when to use",
   then a "How to use with your tool" section pointing at the three subfolders.
2. `recipes/author-contribution.md` — prompt template. Sections:
   - Role framing ("You are helping shape a team-context contribution…")
   - Inputs (rough note, current shared.md)
   - Output format (Why/What/How, one paragraph max per section, mark decisions)
   - Guardrails (don't invent facts; ask if unclear).
3. `recipes/cleanup-context.md` — prompt template. Sections:
   - Role framing ("You are helping clean up the shared team-context tree…")
   - Inputs (current shared.md, optional focus area)
   - Output format (rewritten tree, list of pruned items with reasons)
   - Guardrails (never drop items marked `--decision`; preserve intent).
4. `recipes/claude-code/README.md` — how to use in Claude Code: drop file with
   `@recipes/author-contribution.md`, or paste into a session. One-screen.
5. `recipes/cursor/README.md` — how to use in Cursor: composer mode, `@`-ref the
   recipe file and `.teamctx/context/shared.md`. One-screen.
6. `recipes/chatgpt/README.md` — how to use in ChatGPT: paste recipe, then paste
   inputs when prompted. Screenshots optional (not in MVP). One-screen.
7. `README.md` — add short "Recipes" section after "Commands", linking to
   `recipes/README.md`.
8. `CHANGELOG.md` — one entry under `[Unreleased] Added`.

## Commit-by-commit breakdown

Small, reviewable commits. All DCO signed-off, single author.

1. `docs(recipes): add author-contribution and cleanup-context prompts`
2. `docs(recipes): add per-tool guides (claude-code, cursor, chatgpt)`
3. `docs(recipes): index README linking recipes + tool guides`
4. `docs: link recipes from top-level README + CHANGELOG entry`

## Testing plan

Docs-only PR — no automated tests to add. Manual verification:

- Open each recipe in raw markdown; confirm no broken placeholders.
- Paste `author-contribution.md` into Claude Code with a real rough note +
  current `.teamctx/context/shared.md`; confirm output is usable directly with
  `teamctx contribute "..."`.
- Paste `cleanup-context.md` into ChatGPT with current `shared.md`; confirm
  output is a coherent rewritten tree, not hallucinated content.
- Follow the Claude Code, Cursor, and ChatGPT per-tool READMEs step-by-step to
  make sure the instructions actually work end-to-end.
- Full test suite still green (no code changes, so this is just a sanity check).

## Success criteria

- A newcomer can find `recipes/`, pick a recipe, follow their tool's guide, and
  produce something they can feed straight back into teamctx — in under 5
  minutes, without asking questions.
- The two recipes cover the two most common teamctx-adjacent tasks (authoring
  and cleaning up context).
- Adding a fourth tool later is a single new subfolder + one README — no changes
  to the recipe prompts themselves.
