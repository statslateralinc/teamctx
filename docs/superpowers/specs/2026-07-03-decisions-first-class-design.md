# Design: Decisions as first-class objects

**Roadmap item:** *Decisions as first-class objects — capture source / author / date and surface them in context and `ask`* — Next tier, 🟢 good first issue.

**Vision pillar served:** *Bring your own tools & agents (distillation).*

## Problem

Today, `teamctx contribute "<text>" --decision` tags a contribution as a human decision in the append-only log (`.teamctx/contributions.jsonl`), but that tag never surfaces anywhere a reader can see it:

- `src/context.js` `serializeToMd` renders the tree as a flat Why/What/How list — no marker for which nodes came from decisions, no author, no date.
- Role files (`generateRoleFile`) get the same flat tree; the LLM has no signal to distinguish "we tried Postgres for a week" from "we formally chose Postgres."
- `answerQuestion` (`/ask` + `teamctx ask`) sees only the shared MD, so it can't cite a decision's provenance ("per Sam on 2026-06-30, we chose Postgres because …").

The result: the `--decision` flag is essentially a no-op past the log. Team members using the compiled context files can't tell canonical decisions apart from working notes.

## What already exists

Verified against the code on 2026-07-03:

- **Contribution record** (`cli/commands/contribute.js:6-15`) —
  `{ id, ts, author, text, tagged: 'decision' | null, status: 'logged' }`.
  So *author* and *date* (via `ts`) already exist per contribution. **`source` does not** — CLI and web contributions look identical.
- **Tree nodes** (`src/ops.js:5-21`) — every Why/What/How carries `sourceContributionIds: string[]`, appended every time a contribution edits the node. So the join `node → contributions` is already possible.
- **Log storage** — `.teamctx/contributions.jsonl`, append-only.
- **Web contributions** — `api/contribute.js` and processed by `teamctx pull`. Need to confirm they go through the same `newContribution` shape (or an equivalent) so the new `source` field is populated for both paths.

## Design

### 1. Data model — minimal additions

**Contribution record — add one field:**

```js
{
  id, ts, author, text,
  tagged: 'decision' | null,
  source: 'cli' | 'web',        // NEW — default 'cli' for existing records
  status: 'logged',
}
```

Existing records without `source` are treated as `'cli'` (safe default — that's how everything worked before the web flow).

**Tree nodes — no schema change.** We derive "is this node decision-backed?" at render time by joining `node.sourceContributionIds` against the contributions log and asking: does any of those contributions have `tagged === 'decision'`?

This keeps the tree schema stable and avoids a migration. The join is O(N × avg-sources); the log is small enough (< a few thousand entries in realistic use) that this is fine.

**Optional convenience later:** cache a derived flag on the node during `applyOps`. Not needed for v1.

### 2. Surface in shared MD (`serializeToMd`)

Render decision-backed nodes with an inline provenance tag:

```
- **Why:** Ship Q3 launch on time
  - **What:** Adopt Postgres for user data  *[decision — Sam, 2026-06-30, via cli]*
    - **How:** Migrate from SQLite by 2026-07-15
```

Rendering rule: for each node, look up its most recent decision-tagged contribution (latest `ts` among `sourceContributionIds` where `tagged === 'decision'`). If one exists, append the inline `*[decision — <author>, <YYYY-MM-DD>, via <source>]*` marker. Non-decision nodes render unchanged.

This makes decisions visible in **`.teamctx/context/shared.md`** (which humans read in the repo) and in every LLM prompt that consumes the serialized tree.

### 3. Surface in role files (`generateRoleFile`)

Two changes:

1. The `tree` variable already goes through `serializeToMd`, so the decision markers land in the role-generation prompt automatically. No code change — free win from step 2.
2. Extend the prompt to tell the LLM to **preserve decision markers** when reframing content per role. Without this the LLM often drops them as noise.

The existing "Open Decisions (Yours to Make)" section is **untouched** — it's about ownership, not captured decisions. Different concern.

### 4. Surface in `ask` (`answerQuestion`)

The context passed to `answerQuestion` is already the serialized MD, so decision markers land in the prompt for free. Extend the system prompt to instruct the model to **cite decisions when they're load-bearing to the answer**:

> "When your answer relies on a decision, cite it inline like *(decision — Sam, 2026-06-30)*. If the context shows conflicting statements and one is a decision, prefer the decision."

### 5. Populate `source` in contributions

Two touch points:

- `cli/commands/contribute.js` `newContribution(...)` — add `source: 'cli'`.
- `api/contribute.js` (or wherever web contributions are constructed) — add `source: 'web'`. Verify `teamctx pull` preserves it through processing.

## Non-goals for this PR

- No new tree schema fields. Keeping the diff small.
- No approval-queue interaction (that's a separate roadmap item — [`docs/proposals/manager-approval-queue.md`](../../proposals/manager-approval-queue.md)).
- No `teamctx decisions list` command (nice-to-have; can follow up).
- No backfilling `source` on historical contributions — the reader defaults to `'cli'` when the field is absent.

## Test plan

- `src/ops.test.js` — `applyOps` on a decision-tagged contribution produces a node whose `sourceContributionIds` includes it (should already pass — it's an assertion of existing behavior).
- `src/context.test.js` —
  - `serializeToMd` renders the inline marker when a node is decision-backed.
  - `serializeToMd` picks the *latest* decision when a node has multiple.
  - `serializeToMd` renders normally when no decision is present.
- Manual walkthrough:
  1. `teamctx init` in a sandbox.
  2. `teamctx contribute "we're building X"` — no marker.
  3. `teamctx contribute "we chose Postgres because Y" --decision` — marker appears in `shared.md` and role files.
  4. `teamctx ask "what database are we using?"` — answer cites the decision.

## Rollout

One PR, small, on `feat/decisions-first-class`. No config flag needed — the change is additive: readers of the log without `source` get `'cli'`; readers of the tree without decision markers get the flat rendering, same as today.
