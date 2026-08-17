# Proposal: Context import (cold-start onboarding)

**Status:** Proposal (suggestion, not committed) · **Serves:** Bring your own tools · Managers in control ·
**Rough size:** Medium–Large — splittable (file ingestion → AI distill → review flow)

## Problem

A new team starts teamctx with a blank context tree. But no real team starts from
nothing — they have decks, docs, meeting notes, README files, strategy memos.
Today someone has to manually re-type that knowledge as `contribute` calls, which
is the single biggest adoption cliff: the value of teamctx only shows once context
exists, and building it by hand is exactly the kind of chore that never happens.

The founder's field workaround proves the concept: on consulting engagements he
manually "back-calculated" a client's context from their existing artifacts in a
few hours. This proposal productizes that.

## What exists today

- `teamctx contribute "<text>"` — AI distills free text into Why/What/How
  operations, which enqueue for manager review (`review approve/reject`).
- The contribution pipeline already handles **batching, review, and role-file
  regeneration** — import can reuse all of it.
- `src/ai.js` + `src/providers/` — provider-agnostic AI calls with structured
  outputs.
- Nothing reads files as input; all context enters as typed/pasted text or web
  contributions.

## Suggested approach (one way to do it)

1. **`teamctx import <path…> [--workstream <id>]`** — accept files and directories.
   Start with plain text formats only: `.md`, `.txt` (a PDF/docx extractor is a
   natural follow-up, but don't block on it — teams can export to text).
2. **Chunk + distill** — for each document, run the existing contribute-style
   distill with an import-specific prompt: "extract durable team context (whys,
   decisions, constraints) — not document structure or one-off details." One
   proposed contribution per source document keeps review tractable and
   attribution clear (`source: <filename>`).
3. **Everything lands in the review queue** — never auto-apply. The manager
   approves/rejects each proposed contribution exactly like any other. This is
   what keeps imported noise out of the tree and reuses the whole existing gate.
4. **Dedupe pass** — before enqueueing, ask the AI to drop proposals that
   duplicate existing Why nodes (the `reflect` machinery has similar logic to
   borrow from).
5. **Dry-run by default?** Consider `--dry-run` printing the proposed
   contributions without enqueueing, so a manager can sanity-check an import of
   30 files before flooding the queue.

## Where to start

- `cli/commands/contribute.core.js` — the enqueue path import should feed into.
- `src/ai.js` — add an import-distill prompt alongside the contribute prompt.
- Tests: fixture directory of 2–3 small markdown files → expected queue items
  (mock the provider; see `contribute.core.test.js` for the pattern).

## Follow-up: import connectors (Slack, Google Drive, then Microsoft 365, Dropbox, Notion)

> Now written up in full: [Import connector contract](import-connectors.md).
> The rules below are the summary it expands on.

Local files are the starting point, but most teams' context lives in cloud tools.
The design rule for connectors:

- **A connector is a thin fetch adapter** — it turns a remote source (a Slack
  channel/thread, a Drive folder) into the same normalized text documents the
  local-file path produces. Everything downstream (distill → dedupe → review
  queue) is shared and already exists. Connectors should contain *no* AI logic.
- **Pull-based, user OAuth, no server** — `teamctx import --from slack <channel>`
  runs locally with the user's own token, consistent with the project's
  no-server/BYO-key ethos. No webhooks, no hosted component.
- **One interface, many contributors** — define the connector contract once
  (auth → list → fetch → normalize), so each new source is a well-scoped,
  independent PR. First wave (6): Slack, Google Drive, Microsoft 365
  (SharePoint/OneDrive — many SMB/mid-market teams are Microsoft-cloud-first),
  Dropbox, Notion, Coda. Confluence/Airtable/Box after. Build the contract
  first; connectors then land in any order, one PR each.
- **Slack note:** threads are where decisions get made and then lost — a Slack
  import that distills a channel's last N days into proposed contributions is
  the highest-leverage connector, and also the hardest to keep signal-rich.
  Start with explicit thread/channel selection, not firehose ingestion.

## Open questions

- Chunking long documents: per-file is simplest; per-section may distill better.
- Should import tag contributions (`--decision`-style) so imported context is
  distinguishable from lived context later?
- Connector auth UX: device-code flow vs. pasted tokens for CLI-only users.
