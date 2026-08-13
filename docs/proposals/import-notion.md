# Proposal: Notion import connector

**Status:** Proposal (suggestion, not committed) · **Serves:** Bring your own tools ·
**Rough size:** Medium — the contract exists; the work is the block tree

## Problem

Notion is where teams write things down on purpose. A spec, a decision log, a
postmortem, an onboarding doc — someone sat down and explained the reasoning,
once. Then it was read twice and never entered anyone's working context again.

That inverts the Slack problem. Slack's hard part is *selection*: a channel is
mostly standups and deploy bots, and importing the firehose drowns the review
queue. A Notion page is worth importing almost by definition. Notion's hard part
is *structure* — getting the text out means walking a tree, and deciding where
one document ends and the next begins.

#26 calls this out: a structured workspace, not a file store, so the normalize
step is meatier and will stress-test the contract. That is the right read.

## What exists today

- **The connector contract** (#21) — `auth → list → fetch`, a registry, and the
  `folder` reference implementation. A connector produces documents and nothing
  else.
- **`normalizeDocument`** (`src/import.js`) — size cap, empty check, title
  fallback, applied to whatever a connector returns.
- The whole downstream pipeline: distill with `intent: 'document'`, carry
  forward what earlier documents proposed, queue one contribution each for
  review.
- **Slack (#22) is a sibling, not a dependency.** It builds on the same contract
  in parallel; nothing here imports from it. `--since` currently lands with that
  PR even though it belongs on the shared import surface, so until it merges the
  window below is only reachable by calling `list` directly.
- No HTTP client and no Notion SDK. Bare `fetch` is enough;
  `@notionhq/client` would be the project's first runtime dependency for a
  REST API that is three endpoints.

## The constraints that decide the architecture

Three, and they all push the same way.

**1. A page's content is not in the page.** `GET /v1/pages/{id}` returns
properties — title, timestamps, `url` — and explicitly *not* content. Content is
`GET /v1/blocks/{id}/children`, which returns **only the first level**. Every
block with `has_children: true` costs another request. A page with nested
toggles and lists is a tree walk, not a fetch.

**2. Three requests per second.** Notion allows "an average of three requests
per second, with some bursts", with a second per-workspace limit that scales
with the plan. Over the limit is a 429 carrying `Retry-After`; a 529 means
overloaded and is retried identically.

Slack's problem was a hard cap per minute — one request buys fifteen messages.
Notion's is the opposite shape: the per-request cost is fine, but one document
takes many requests. Same mitigation (honour `Retry-After`), different reason —
pacing rather than recovery.

**3. Search matches titles only, and sees only what was shared.**
`POST /v1/search` is not full-text; it matches *titles* of pages explicitly
connected to the integration. A newly created connection sees nothing at all
until the user opens a page in Notion and picks ••• → **Add connections**.
Access then cascades: connecting a parent grants every child page beneath it.

That third constraint is a gift, not an obstacle. The contract's rule 4 asks for
explicit selection rather than a firehose — in Notion the user has *already made
that choice*, in Notion's own UI, before teamctx sees anything.

## Suggested approach (one way to do it)

1. **A page is a document — and a child page is a different document.**
   Recurse through block children for structure (toggles, nested lists,
   callouts, quotes) but stop at `child_page` and `child_database`. Those get
   their own id and their own queue entry.

   This is the decision the whole connector turns on. Inline child pages and
   importing a wiki root produces one document the size of a wiki, which a
   manager reviews as a single yes/no — exactly the granularity the pipeline was
   built to avoid.

2. **Three selectors, in the order people will reach for them:**
   - `teamctx import --from notion <page-url>` — pasted from Notion's "Copy
     link". The high-signal case, same as Slack's permalink: the one document
     you already know matters.
   - `teamctx import --from notion <page-id>` — the bare UUID.
   - `teamctx import --from notion` — everything connected, bounded by
     `--since`. Defensible only because the connection list *is* the user's
     selection.

   Notion URLs end in a 32-hex id (`.../Some-Title-1a2b3c…`), sometimes with
   `?v=` for a view. Parsing means pulling the last 32 hex characters and
   re-hyphenating into a UUID.

3. **`list` is search, `fetch` is the tree walk.** This is where the contract's
   split earns its keep more than anywhere else: search returns titles and
   `last_edited_time` for one cheap request, and the expensive recursion only
   happens for pages that survive. `--dry-run` on a whole workspace costs a
   request or two.

4. **Render blocks as markdown**, because the distiller reads prose:

   | Block | Rendering |
   | --- | --- |
   | `paragraph` | text |
   | `heading_1/2/3` | `#` / `##` / `###` |
   | `bulleted_list_item` | `- ` |
   | `numbered_list_item` | `1. ` |
   | `to_do` | `- [ ] ` / `- [x] ` |
   | `quote`, `callout` | `> ` |
   | `code` | fenced, with `language` |
   | `table_row` | `\| a \| b \|` |
   | `divider` | `---` |

   Every one of those carries `rich_text[]`, and every rich text object carries
   `plain_text` — so the extraction is uniform. Links become `[text](href)`.
   Blocks with no text (`image`, `embed`, `file`, `breadcrumb`,
   `table_of_contents`) are skipped silently, the way `folder` walks past a
   `.png` inside a directory without comment.

5. **Ids and provenance.** `notion:<page-id>`. Notion returns a `url` on every
   page object, so the queue entry can link to something openable without
   constructing it. Provenance that cannot be followed is decoration.

6. **`--since` maps to sort, not filter.** Search has no time filter — only
   `sort` by `last_edited_time`. Sort descending and stop paging at the
   boundary, which also caps the request count on a large workspace.

## Scope: databases are out

The 2025 API split databases into *data sources*, and a database row is itself a
page — so importing a database means importing N pages plus a schema nobody
asked for. Rows are also usually records, not reasoning, which is the wrong
shape for a context tree.

v1 handles pages. `data_source` results from search are skipped with a reason
rather than silently dropped, so the behaviour is visible instead of looking
like a bug.

## Where to start

- `src/connectors/folder.js` — the contract at its smallest, and the file a
  connector author actually copies.
- `src/connectors/index.test.js` — the conformance suite runs against every
  registered connector automatically, including the rule that none may import
  the AI layer.
- `src/import.js` — `normalizeDocument`, and the skip-reason vocabulary.
- Tests: fixture JSON captured from the API shape, mocked at `fetch`. Block
  recursion needs a fixture with real nesting, or the walk is untested where it
  is most likely to be wrong.

## Open questions

- **Depth and size caps.** A deeply nested page is a lot of requests, and
  `normalizeDocument` will reject the result anyway if it blows the size cap —
  after paying for every one of them. Should the walk stop early, and at what?
- **`last_edited_time` is a noisy signal.** Fixing a typo bumps it, so `--since`
  resurfaces a page whose content did not meaningfully change. Slack has the
  same re-import problem; here the timestamp actively lies.
- **Two connectors now hand-roll paging and 429 handling.** The contract
  proposal deferred a shared helper until there was a second one to design
  against. There is now. Extract it here, or wait for a third and risk the
  divergence being harder to unpick?
- **Is "everything connected" a firehose?** Rule 4 says explicit selection. The
  user did select — in Notion's UI, possibly months ago, possibly a parent whose
  subtree they have forgotten. Should the no-selector form require `--since`,
  or print what it found and ask?
- **Comments.** The decision is often in a page comment (*"we went with B
  because…"*), not the page body. Separate endpoint, separate scope, and the
  page alone may misrepresent what was concluded. Worth a follow-up.
