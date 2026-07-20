# Plan: Approve the context itself (context snapshots)

**Branch:** `feat/context-snapshots` (stacked on `feat/manager-approval-queue`)
**Roadmap:** "Later" — *managers in control*
**PR shape:** Single PR delivering the MVP.

---

## Goal

Give teams a durable "last known-good state" of the shared context. Anyone can
snapshot the current `shared.json`; the manager approves or rejects the snapshot.
The approved snapshot is a versioned reference the team can point at — "this is
the context we all agreed on as of vN."

Complements the manager approval queue, which gates *individual contributions*.
Snapshots gate *the whole context state* at chosen checkpoints.

## In scope (this PR)

- Snapshot data model on disk (`.teamctx/snapshots/<id>.json`) with status
  `pending` / `approved` / `rejected`.
- Collision-safe IDs (`snap-<timestamp>-<rand5>`) — same shape as queue items,
  distributed-safe across concurrent clones. Git-style prefix matching in the
  CLI so users don't need to type the full ID (`teamctx snapshot approve snap-172105`).
- Current-approved pointer at `.teamctx/snapshots/current.json`.
- `teamctx snapshot create / list / approve / reject / show / current` CLI.
- Manager gate reused from `src/review.js` `canApprove()`.
- Git-based delivery (commit + push on create/approve/reject) same as the queue.
- Tests for storage helpers and the pure state-machine.
- Docs (README table rows, file-layout diagram, CHANGELOG).

## Out of scope (follow-ups)

- **Snapshot rollback/restore** — overwriting `shared.json` with an old snapshot
  loses intervening contributions. Real footgun; needs its own design (probably
  requires re-queueing dropped ops). Deferred.
- **Snapshot diffs** (`teamctx snapshot diff v2 v3`) — useful, non-trivial. Later.
- **Auto-snapshot on every approved contribution** — noisy. Manual snapshots are
  intentional checkpoints; auto snapshots dilute that.
- **Web review UI** for snapshots.
- **Multi-approver / RBAC.**
- **"Context has drifted from approved snapshot" warning** in `teamctx status` —
  nice touch, but a separate polish PR.

## Dependency on the queue PR

Reuses `canApprove(config)` from `src/review.js` — introduced in
`feat/manager-approval-queue`. This branch is stacked on that one; PR base
should be `feat/manager-approval-queue` on GitHub. Once the queue PR merges,
rebase this branch on `main`.

## Data model

Snapshot file — `.teamctx/snapshots/<id>.json`:

```json
{
  "id": "snap-1720968000000-a1b2c",
  "createdAt": "2026-07-14T12:00:00.000Z",
  "createdBy": "satyagya",
  "message": "post-launch v2 planning",
  "status": "pending",
  "shared": { /* full shared.json snapshot */ },
  "approvedAt": null,
  "approvedBy": null,
  "rejectedAt": null,
  "rejectedBy": null,
  "reason": null
}
```

ID format: `snap-<Date.now()>-<5-char base36 random>` — same pattern the queue
uses for its `q-…` IDs. Collision-safe across concurrent clones by construction.

On approve: `status: "approved"`, `approvedAt`, `approvedBy` filled.
On reject: `status: "rejected"`, `rejectedAt`, `rejectedBy`, `reason` filled.

Snapshots are never deleted — history is the point. Rejected snapshots stay in
`snapshots/` marked rejected (not moved to `rejected/` like queue items are).

Current-approved pointer — `.teamctx/snapshots/current.json`:

```json
{
  "id": "snap-1720881600000-x9y8z",
  "approvedAt": "2026-07-13T18:00:00.000Z",
  "approvedBy": "manager-name",
  "message": "pre-launch context freeze"
}
```

Rewritten on each approve. Absent until the first approval.

## File layout diff

```
.teamctx/
  snapshots/                            # NEW
    snap-1720881600000-x9y8z.json
    snap-1720968000000-a1b2c.json
    current.json                        # pointer to latest approved
  queue/                                # existing (from queue PR)
  rejected/                             # existing (from queue PR)
  ...
```

Filenames are the snapshot ID + `.json`. Lexicographic sort by filename
happens to match creation order because the timestamp component is monotonic.

## Public functions (`src/storage.js`)

- `snapshotsDir(dir?)` — `<teamctxDir>/snapshots`.
- `writeSnapshot(snapshot, dir?)`.
- `readSnapshot(id, dir?)` — throws if missing.
- `listSnapshots(dir?)` — sorted by `createdAt` asc, `[]` if dir missing.
- `resolveSnapshotId(prefix, dir?)` — returns full ID for a unique prefix;
  throws `"no snapshot matches …"` or `"prefix … is ambiguous"` otherwise.
- `readCurrentSnapshotPointer(dir?)` — `null` if missing.
- `writeCurrentSnapshotPointer(pointer, dir?)`.

## Pure logic (`src/snapshots.js`)

- `newSnapshotId()` — `snap-<Date.now()>-<rand5>`.
- `buildSnapshot({ workstream, author, message })` — assigns id + createdAt.
- `buildApproved(snapshot, approvedBy)`.
- `buildRejected(snapshot, rejectedBy, reason)`.
- `buildPointer(approvedSnapshot)` — pointer object from an approved snapshot.

Tested in `src/snapshots.test.js` — no filesystem, no git.

## CLI

- `teamctx snapshot create [-m "label"]` — reads `shared.json`, generates a
  new ID, writes snapshot as `pending`, commits + pushes.
- `teamctx snapshot list` — table: id, status, createdBy, createdAt, message.
  Marks the current-approved row with a `*`.
- `teamctx snapshot show <id-or-prefix>` — regenerates and prints the
  snapshotted `shared.md` to stdout (from the snapshot's `shared` field).
  Doesn't touch disk.
- `teamctx snapshot approve <id-or-prefix>` — manager-gated. Marks snapshot
  approved, updates `current.json` pointer, commits + pushes.
- `teamctx snapshot reject <id-or-prefix> [--reason "..."]` — manager-gated.
  Marks rejected, commits + pushes.
- `teamctx snapshot current` — prints `<id> — <message> (approved by <who> on <when>)`
  or "No approved snapshot yet."

All ID-taking commands accept a unique prefix (git-style): `snap-172105` is
resolved to the full ID via `resolveSnapshotId`.

## Manager gate

Reuses `canApprove(config)` verbatim from `src/review.js`. Same rule: solo mode
if `config.manager` unset; else `config.me === config.manager` may approve/reject.

Applies to `approve` and `reject` only. `create` is open to any contributor —
snapshotting is proposing, not approving.

## Git delivery

Same model as the queue PR (`docs/superpowers/plans/2026-07-13-manager-approval-queue.md`).

- `snapshot create` → commit `snapshot: v<N> created by <author> (<message>)`, push.
- `snapshot approve` → commit `snapshot: v<N> approved by <manager>`, push.
- `snapshot reject` → commit `snapshot: v<N> rejected by <manager> (<reason>)`, push.

Managers `git pull` before `teamctx snapshot list` to see fresh pending snapshots.

## Concurrency note

Two contributors can call `snapshot create` at nearly the same time from
different clones. Because IDs are `snap-<timestamp>-<rand5>`, both write
different filenames — no git conflict, both snapshots land cleanly. Same
model the queue already uses.

The only shared file is `snapshots/current.json` (pointer to latest
approved). If two managers approve different snapshots simultaneously from
different clones, git surfaces that as a conflict on the pointer — the
correct outcome, because they disagree on which snapshot is blessed. A human
resolves.

## Interaction with existing flows

- `contribute --apply` and `review approve` mutate `shared.json` after a
  snapshot exists. The snapshot is a *frozen copy* — it doesn't change. The
  "current approved" pointer keeps pointing at v2 even though shared.json has
  drifted. That's the correct behavior: v2 is the last state the manager
  signed off on; drift from it is expected until the next snapshot cycle.
- We do **not** touch `shared.json` from the snapshot flow. Snapshots are
  read-only relative to shared state.

## Commit-by-commit breakdown

Each signed off (`-s`), honest timestamps.

1. **`docs: plan for context snapshot approval`** — this file.
2. **`feat(storage): add snapshot storage helpers`** — `src/storage.js`.
3. **`test(storage): cover snapshot storage helpers`** — `src/storage.test.js`.
4. **`feat(snapshots): pure state-machine (build/approve/reject/pointer)`** —
   `src/snapshots.js`.
5. **`test(snapshots): cover snapshot state machine`** — `src/snapshots.test.js`.
6. **`feat(cli): teamctx snapshot create/list/show/approve/reject/current`** —
   `cli/commands/snapshot.js` + registration in `cli/index.js`.
7. **`docs: README + CHANGELOG for context snapshots`** — file-layout diagram,
   commands table, `[Unreleased]` entry.

## Testing plan

- Storage helpers: round-trip, list-sort-order, next-version arithmetic,
  pointer read/write, empty dirs.
- State machine: `buildSnapshot` shape, `buildApproved`/`buildRejected` fill
  the right fields, `buildPointer` derives from approved snapshot.
- End-to-end manual (documented in PR description): init → contribute (apply
  path) → snapshot create → snapshot list (sees pending) → snapshot approve
  (using short prefix) → snapshot current (shows the approved snap ID) →
  contribute again → snapshot list (first snapshot still approved, shared.json
  has drifted).

## Open questions (parked)

- **Should `snapshot create` require any pending contributions to be
  cleared/resolved first?** No — orthogonal concerns. A manager may want to
  snapshot a mid-review state deliberately.
- **Show a "shared.json has drifted from snapshot v2" note in `teamctx status`?**
  Nice-to-have; separate polish PR to avoid scope creep.
- **Should the pointer file be committed?** Yes — it's the shared "which
  version is blessed" signal. Same commit as the approve.

## Ready to build

Small surface, reuses existing patterns (manager gate, git delivery, table
listing). One new module, one new command file, one storage helper cluster.
