# Plan: Manager approval queue

**Branch:** `feat/manager-approval-queue`
**Proposal:** [`docs/proposals/manager-approval-queue.md`](../../proposals/manager-approval-queue.md)
**Roadmap:** "Next" — *managers in control*
**PR shape:** Single PR delivering the full feature per the proposal's In-scope list.

---

## Goal

Turn contributions into durable, status-bearing objects that wait for a manager to approve before they enter shared context. Add a CLI review surface, and a minimal manager identity gate. Reuses the existing distill/apply logic — the change is *when* apply runs.

## In scope (this PR)

- Pending-contribution data model on disk.
- `teamctx contribute` enqueues by default; `--apply` flag preserves the old immediate-apply for solo users.
- `teamctx review list / approve / reject` CLI.
- Basic manager identity check via new `config.manager` field + `teamctx config manager` command; solo mode (no gate) when unset.
- Rejection archive with reason.
- Tests for storage helpers and the state-machine.
- Docs (README table row(s), file-layout diagram, CHANGELOG).

## Out of scope (follow-ups)

- Web review UI.
- Notification integration (email on new pending — `managerEmail` field exists but wiring the send is separate).
- `teamctx pull` unification — web submissions currently land in `.teamctx/pending/` as raw text; leaving that inbox untouched here so the two flows evolve independently. (See "Naming" below.)
- Multi-approver workflows, full RBAC.
- Approving the *context snapshot* itself (separate Later roadmap item).

## Naming — why `queue/` not `pending/`

`cli/commands/pull.js` already reads `.teamctx/pending/` as its **raw web-submission inbox** (shape: `{author, text}`) — an entirely different lifecycle from the *post-distill review queue* we're adding. Reusing `pending/` would blur two data models. Using `.teamctx/queue/` keeps them cleanly separated. The proposal's illustrative "e.g. a `pending/` area" wasn't aware of that collision.

## Data model

Queue item — one JSON file per contribution under `.teamctx/queue/<id>.json`:

```json
{
  "id": "q-1720000000000-a1b2c",
  "status": "pending",
  "createdAt": "2026-07-13T14:00:00.000Z",
  "author": "satyagya",
  "source": "cli",
  "text": "raw contribution text",
  "tagged": null,
  "summary": "AI summary of proposed change",
  "operations": [ /* op shape produced by proposeDiff */ ]
}
```

Rejected archive — `.teamctx/rejected/<id>.json`:
```json
{
  "id": "q-...",
  "status": "rejected",
  "rejectedAt": "...",
  "rejectedBy": "manager-name",
  "reason": "optional string",
  ...original queue fields...
}
```

Approved items are **not** archived — the contribution already lives in `contributions.jsonl`, and applied ops live in `shared.json`. Duplicating them would be dead weight.

## File layout diff

```
.teamctx/
  queue/                    # NEW — pending review queue (one <id>.json per item)
  rejected/                 # NEW — archived rejects
  pending/                  # existing — raw web submissions inbox (untouched)
  config.json               # + optional "manager": "<name>"
  ...
```

## Public functions (`src/storage.js`)

- `queueDir(dir?)` — `<teamctxDir>/queue`.
- `writeQueueItem(item, dir?)`.
- `readQueueItem(id, dir?)`.
- `listQueue(dir?)` — sorted by `createdAt` asc, `[]` if dir missing.
- `deleteQueueItem(id, dir?)`.
- `writeRejected(item, dir?)` — writes to `<teamctxDir>/rejected/<id>.json`.

## CLI

- `teamctx contribute "..."` — default: distill → preview → on approve, **enqueue** (no apply, no role regen, no commit yet). New `--apply` flag preserves the old immediate flow for solo users.
- `teamctx review list` — table of pending items.
- `teamctx review approve <id>` — reads queue item, applies its `operations` to current `shared.json`, regenerates role files, deletes queue item, commits. Manager-gated.
- `teamctx review reject <id> [--reason "..."]` — writes to `rejected/`, deletes queue item. Manager-gated.
- `teamctx config manager [name]` — get/set the manager identity (must match some contributor's `config.me`).

## Manager gate

- If `config.manager` is unset → solo mode: anyone can approve/reject.
- If set → only `config.me === config.manager` may approve/reject; otherwise refuse with a clear one-liner.
- No RBAC beyond this.

## Concurrency note

Between when a contribution is enqueued and when it's approved, `shared.json` may have shifted (other approvals landed). The approve flow re-applies the queued `operations` against the *current* `shared.json`. If a referenced parent id no longer exists (e.g. `parentWhyId`), the corresponding `addWhat` becomes a no-op — same silent-skip behaviour `applyOps` already has for stale refs today. Acceptable for MVP; a future PR can add "would drop N ops" warnings.

## Commit-by-commit breakdown

Each signed off (`-s`), honest timestamps.

1. **`docs: plan for manager approval queue`** — this file.
2. **`feat(storage): add queue + rejected storage helpers`** — src/storage.js.
3. **`test(storage): cover queue storage helpers`** — src/storage.test.js.
4. **`feat(cli): teamctx review list/approve/reject commands`** — cli/commands/review.js + registrations.
5. **`feat(cli): enqueue contribute by default; add --apply flag`** — cli/commands/contribute.js + register flag.
6. **`feat(config): add manager identity + 'teamctx config manager' command`** — cli/commands/config.js + register.
7. **`test(review): cover approve/reject state machine`** — new src/review.js if we extract the pure logic, plus src/review.test.js. (If tests can live purely against storage + applyOps without extracting, we skip the new module and put tests directly.)
8. **`docs: README + CHANGELOG for approval queue`** — file layout diagram + commands + entry.

## Open questions (parked)

- `pull` unification with the queue — deliberately deferred (see Out of scope).
- Should approve emit a notification when `managerEmail` is set? Deferred to the notification PR.
- MCP auth model alignment for approver identity — deferred; when the MCP auth model firms up, we can teach `config.manager` about it.

## Ready to build

Independent, splittable into clean commits, no external deps.
