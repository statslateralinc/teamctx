# Plan: workstream integration fixes across queue, review, snapshot, and MCP

**Branch:** `feat/workstream-integration-fixes` (off `feat/suggest-subworkstreams`)
**PR base:** `main` — will show a slightly larger diff until `feat/suggest-subworkstreams` merges upstream; after that it collapses to just the new fixes.
**PR shape:** Single PR, 4 blocking bugs + 1 non-blocking follow-up.

---

## Motivation

Full end-to-end testing on `feat/suggest-subworkstreams` (all 6 features
stacked) surfaced 4 blocking bugs where three pre-workstream features (queue,
snapshot, MCP) were never taught about the workstream concept when
`feat/suggest-subworkstreams` migrated the source-of-truth from
`shared.json` to `workstreams/*.json`. The result today: any user who splits
their project into sub-workstreams and then uses `review approve`, `snapshot
create`, or `mcp submit_contribution` loses data or corrupts role files.

None of these bugs was caught by the unit tests because there is no
integration test exercising queue + workstream, snapshot + workstream, or MCP
+ workstream together.

## Blocking bugs to fix

### BUG 1 — `contribute --workstream <id>` (queue path) drops workstream target

**File:** `cli/commands/contribute.js`

**Symptom:** the `writeQueueItem({...})` block for the non-`--apply` path does
not persist `workstream`. When `review approve` later reads the queue item,
it has no way to know which workstream the operations were meant for.

**Fix:** add `workstream: targetId` to the queue item payload. Also add
`workstream` to the `contribution` object appended to `contributions.jsonl`
in both the queue and `--apply` paths, so the audit log records the target.

**Test:**
- Unit test in `src/storage.test.js` — round-trip a queue item with a
  `workstream` field, verify it's preserved.
- Integration test (see below) — enqueue with `--workstream growth`, read
  the queue file, assert `workstream === 'growth'`.

### BUG 2 — `review approve` is workstream-blind, corrupts role files

**File:** `cli/commands/review.js`

**Symptom:** `readShared() → applyQueueItem() → writeShared() → writeSharedMd(...)`
always operates on `main`. Then a loop over **every** role regenerates the
role's md file using `main` (empty in a migrated project) — actively
overwriting role files bound to real workstreams with "context is empty"
text. Also: `generateRoleFile` is called without the `contributions` param,
so decision markers are dropped from every regenerated role file.

**Fix:**
1. Read the queue item's `workstream` field (needs BUG 1); default to
   `'main'` for legacy queue items missing the field so nothing crashes on
   in-flight queues.
2. Replace `readShared / writeShared / writeSharedMd` with
   `readWorkstream(targetId) / writeWorkstream(targetId, ...) /
   writeWorkstreamMd(targetId, ...)`.
3. Filter roles to those bound to `targetId`:
   `config.roles.filter(r => (r.workstream || 'main') === targetId)`.
4. Read contributions once and pass to both `serializeToMd` and
   `generateRoleFile` (this closes the last gap the reviewer flagged on
   `feat/suggest-subworkstreams`).
5. Commit message should include the workstream tag (like `contribute`
   already does: `context: <author> contribution (approved by <me>) [tech]`).

**Test:**
- Integration test: create a 2-workstream project, enqueue a contribution
  targeting `tech`, approve, assert that (a) `workstreams/tech.json` grew,
  (b) `workstreams/main.json` unchanged, (c) role bound to `main` unchanged,
  (d) role bound to `tech` regenerated.

### BUG 3 — `snapshot create` captures only `main`

**File:** `cli/commands/snapshot.js`, `src/snapshots.js`, `src/storage.js`

**Symptom:** `snapshotCreateCommand` calls `readShared()` — captures only
`workstreams/main.json`. In a post-split project, `main` is empty, so
`snapshot show` prints nothing and `snapshot approve` marks an empty snapshot
as "current".

**Fix (chosen approach: A — whole-workspace snapshots):**

Snapshot is a milestone event — "sign off on the state of the team's context
at this moment." That's inherently whole-workspace after a split. Per-workstream
snapshots would feel like tagging git branches instead of tagging a release.

- `snapshot create` captures the state of **every** workstream in the project,
  not one. No `--workstream` option on create.
- Snapshot object shape changes from `{shared: {...}}` to
  `{workstreams: [{id, tree}, ...]}`. For a fresh single-workstream project
  this is an array of one — output shape stays the same in that case.
- Legacy-read fallback: if a snapshot on disk has the old `shared: {...}`
  field, treat it as `{workstreams: [{id: 'main', tree: shared}]}` at read
  time. No on-disk migration needed; the field is filled in the next time
  someone creates a fresh snapshot.
- `snapshot show <id>` prints one section per workstream (with a header for
  each). Single-workstream projects see identical output to today.
- `snapshot list` unchanged. `snapshot current` unchanged (still one pointer
  per project, since a snapshot IS the whole project's state).
- `snapshot approve/reject` unchanged — still atomic on the snapshot as a
  whole. The manager signs off on the whole team's state, not per-thread.

**Why A over B (per-workstream snapshot):**
- Matches original design intent — the roadmap item was called "approve the
  context itself," singular.
- Matches the manager gate — one identity, one signoff, one atomic moment.
- Real-world use is milestone-shaped: pre-launch freeze, board-meeting
  baseline, end-of-quarter reference. All inherently whole-team.
- Zero visible difference for single-workstream users (no regression, no
  new flags to learn).
- Only visible cost: ~50 more lines of code than B, one extra test fixture.

**Test:**
- Fresh single-workstream project: `snapshot create` → snapshot has
  `workstreams` array of length 1 with `id: 'main'`. `snapshot show` prints
  one section. Behaviour identical to pre-fix.
- Post-split project (main + growth + tech): `snapshot create` → snapshot has
  3 entries. `snapshot show` prints 3 sections in workstream-sorted order.
- Legacy-read: a snapshot fixture with `{shared: {...}}` (no `workstreams`
  field) round-trips as if it had `{workstreams: [{id: 'main', tree: shared}]}`.
- Approve/reject state machine unchanged — all existing snapshot state-machine
  tests keep passing.

### BUG 4 — MCP `submit_contribution` is workstream-blind

**File:** `mcp/server.js`

**Symptom:** same shape as BUG 2 in the MCP handler. Uses
`readShared() / writeShared() / writeSharedMd()`, iterates all roles without
filtering, no `contributions` param on `generateRoleFile`. In a
workstream-migrated project, MCP contributions vanish into empty main.

**Fix:**

*Write path:*
1. Add optional `workstream` (string) to `submit_contribution` input schema.
   Default at request time: `config.activeWorkstream || 'main'`.
2. Validate against known workstreams; return a clean error mentioning
   `list_workstreams` if the caller passed a bogus id.
3. Replace `readShared / writeShared / writeSharedMd` with workstream
   variants, filter roles, thread contributions.

*Read path (consistent with the whole-workspace snapshot direction):*
4. `get_context` becomes whole-workspace-aware: returns
   `{workstreams: [{id, tree}, ...]}` instead of a single tree. For a
   single-workstream project the array has one element — output is
   structurally similar to today. Existing MCP clients that just read
   `.whys` will need a one-line adaptation (`data.workstreams[0].tree.whys`)
   — noted in CHANGELOG and `docs/mcp.md` as an intentional breaking change
   in the pre-1.0 window, since keeping `get_context` main-only would be a
   silent lie in workstream-migrated projects.

*New tools so agents can discover and read individual workstreams:*
5. `list_workstreams()` — returns `config.workstreams`.
6. `get_workstream({ id })` — returns one workstream tree (for agents that
   don't want the whole workspace payload).

7. Update `docs/mcp.md` and `mcp/server.test.js`.

**Test:**
- Extend `mcp/server.test.js` `submit_contribution` cases to include
  `{ text, workstream: 'growth' }` and assert `writeWorkstream('growth', ...)`
  was called, not `writeShared`.
- New tests for `list_workstreams` and `get_workstream`.

## Non-blocking follow-ups

### `teamctx status` post-migration reads only `main`

**File:** `cli/commands/status.js`

**Symptom:** shows `Why nodes: 0` after workstream migration because it uses
`readShared()`. Not corrupting; just misleading. Users think their content
disappeared.

**Fix:** in a migrated project (detected via `config.workstreamsMigrated ===
true` or `existsSync(workstreams/)`), sum Why nodes across all workstreams and
show a per-workstream breakdown. Preserve the flat view for pre-migration
projects.

**Not blocking merge** — cosmetic. Bundle if easy, otherwise separate PR.

## Out of scope for this PR

- **Whole-workspace snapshots** (option A). If the team wants snapshot to
  freeze the entire project state (all workstreams + config + role
  assignments) in one atomic blob, that's a design conversation and its own
  PR after this lands.
- **Rewriting past-buggy state**: if any user has already run `review
  approve` on a workstream-targeted queue item and corrupted their role
  files, this PR doesn't restore them. Recovery is: `git log`, find the
  pre-corruption commit, `git checkout <sha> -- .teamctx/context/roles/`.
- **Multi-tenant queue namespacing**: queue is still project-wide, not
  workstream-partitioned. `review list` shows every pending item across all
  target workstreams. Fine for MVP; if teams later want per-workstream queue
  views, that's a small follow-up (`review list --workstream <id>`).
- **`teamctx reflect --workstream` regenerating all downstream role files**:
  already correct on this branch — my fix during the rebase filters roles by
  workstream. No change needed here.

## Data model changes

Three changes, all backward-compatible via read-time fallbacks:

1. **Queue item** (`.teamctx/queue/<id>.json`): new additive field
   `workstream: string`. Absent → `'main'`.
2. **Snapshot** (`.teamctx/snapshots/<id>.json`): field rename from
   `shared: {...}` to `workstreams: [{id, tree}, ...]`. At read time, a
   snapshot without `workstreams` but with `shared` is interpreted as
   `[{id: 'main', tree: shared}]`. Old snapshots keep working; new ones
   get the new shape.
3. **Contribution log entry** (`.teamctx/contributions.jsonl`, one line):
   new additive field `workstream: string`. Absent → `'main'`.

No on-disk migrations required. No existing tests need to be rewritten; new
tests add coverage.

## MCP tool surface changes

| Tool | Change |
|---|---|
| `submit_contribution` | new optional input `workstream` |
| `get_context` | **response shape changes** to `{workstreams: [{id, tree}, ...]}` (whole-workspace) — see BUG 4 for rationale |
| `list_workstreams` | **NEW** — returns `config.workstreams` |
| `get_workstream({ id })` | **NEW** — returns one workstream tree |

`get_context`'s shape change is an intentional breaking change flagged in
CHANGELOG. Rationale: keeping it main-only would silently mislead callers in
workstream-migrated projects — worse than a documented break.
`get_role_context` and `ask` are unchanged (both already correctly consume
role-bound workstreams via existing code paths).

## Commit-by-commit breakdown

Small, reviewable commits. All DCO signed-off, single author.

1. `docs(plan): workstream integration fixes` (this file, already committed)
2. `feat(contribute): persist workstream on queue items and audit log` (BUG 1)
3. `test(storage): queue item workstream round-trip` (BUG 1 test)
4. `fix(review): approve into the queue item's workstream, filter roles, thread contributions` (BUG 2)
5. `test(review): approve applies to correct workstream, doesn't corrupt other role files` (BUG 2 integration test)
6. `feat(snapshots): capture all workstreams in a single snapshot` (BUG 3 — approach A)
7. `test(snapshots): whole-workspace capture + legacy-read fallback` (BUG 3 tests)
8. `feat(mcp): workstream-aware submit_contribution, whole-workspace get_context, new list/get_workstream tools` (BUG 4)
9. `test(mcp): workstream submit_contribution, new tools, new get_context shape` (BUG 4 tests)
10. `feat(status): per-workstream Why-node breakdown after migration` (non-blocking)
11. `docs: CHANGELOG entry, README + docs/mcp.md updates (incl. get_context breaking-change note)`

## Testing plan

- Every changed file gets a unit or integration test added or extended.
- Full test suite must stay green (currently 130 on this branch).
- **New integration test file** `src/integration.test.js` (or similar) that
  builds a fake `.teamctx/` in a temp dir, splits into workstreams, and
  exercises the full contribute → queue → approve → verify flow end-to-end
  without hitting the real AI. Purpose: catch this whole class of bug in
  CI going forward.
- Manual E2E re-run using the same scenario that surfaced these bugs, to
  confirm the report's four blocking findings are all closed.

## Success criteria

- `contribute --workstream tech` → `review approve <id>` lands the operations
  in `workstreams/tech.json`, not `main`.
- Role files bound to workstreams other than the approve target are
  unchanged after `review approve`.
- Decision markers appear in every role file regenerated by `review approve`
  (parity with `contribute --apply`).
- `snapshot create` on a post-split project captures **all** workstreams;
  `snapshot show <id>` prints every workstream's tree in one output.
- Legacy snapshots with the old `shared` field still load and display
  correctly (interpreted as a single-workstream snapshot on `main`).
- MCP `submit_contribution({ text, workstream: 'tech' })` lands in
  `tech.json`. `get_context` returns whole-workspace shape.
  `list_workstreams` and `get_workstream({id})` return real data.
- `teamctx status` shows non-zero Why nodes after migration (per-workstream
  breakdown).
- Full test suite green; new integration test exercises the fix.
