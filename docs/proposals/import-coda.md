# Proposal: Coda import connector

**Status:** Proposal (suggestion, not committed) · **Serves:** Bring your own tools ·
**Rough size:** Small–Medium — Coda exports markdown itself; the work is the async job

## Problem

Coda is Notion's neighbour: structured docs, written deliberately, holding the
reasoning a team would otherwise have to remember. #27 puts it plainly — *like
Notion, structured docs; normalize carefully.*

The interesting part is that "carefully" turns out to mean something completely
different here, and the difference is worth writing down before anyone assumes
the Notion connector can be copied with the nouns swapped.

## What exists today

- **The connector contract** (#21) — `auth → list → fetch`, a registry, and the
  `folder` reference implementation.
- **`normalizeDocument`** (`src/import.js`) and the whole downstream pipeline:
  distill with `intent: 'document'`, carry forward what earlier documents
  proposed, queue one contribution each for review.
- **Notion (#26) and Slack (#22) are siblings, not dependencies.** Both build on
  the same contract in parallel and nothing here imports from either; the
  comparison to Notion below is about API shape, not shared code. `--since`
  currently lands with #22 even though it belongs on the shared import surface,
  so until that merges the window is only reachable by calling `list` directly.

## The constraint that decides the architecture

**Coda inverts Notion's cost model, in both directions.**

| | Notion | Coda |
| --- | --- | --- |
| Listing pages | search, titles only, no hierarchy | `GET /docs/{doc}/pages` — the **whole tree**, one read |
| Page content | tree walk, one level per request | **async export job**: POST → poll → download |
| Markdown | we render it from blocks | the API produces it |

Two consequences.

**1. `list` is genuinely free, so `--dry-run` finally means something.** Notion
had to read a page's blocks just to discover its child pages, which is the same
work `fetch` does — the split saved nothing on a subtree. Coda hands back every
page with `id`, `name`, `parent`, `children` and `browserLink` in a single
paginated read. Listing an entire doc costs one or two requests and no export
jobs at all.

**2. `fetch` is the expensive one, and it is rate-limited on the scarce budget.**
Coda's limits are per user and differ sharply by verb:

| Operation | Limit |
| --- | --- |
| Reading data | 100 / 6s |
| **Writing (POST/PUT/PATCH)** | **10 / 6s** |
| Listing docs | 4 / 6s |

Beginning an export is a **POST**. So the operation we do once per document sits
in the tightest general bucket — about one every 600ms — while the listing we do
once per run is nearly free. `GET /docs` is tighter still at 4 per 6 seconds,
which matters only for the no-selector case.

Notion's pacing was one global gap because every request cost the same. Coda
needs a gap **per bucket**, or the import either crawls (pacing reads at write
speed) or gets 429'd (pacing writes at read speed).

## Suggested approach (one way to do it)

1. **A page is a document**, exactly as in Notion — but here it falls out of the
   API rather than needing a rule. Coda returns subpages as their own entries
   with a `parent` pointer, so the thing Notion needed a deliberate
   *stop-at-`child_page`* decision to achieve is simply the shape of the data.

2. **Let Coda produce the markdown.** `POST /docs/{docId}/pages/{pageId}/export`
   with `outputFormat: markdown`, poll
   `GET …/export/{requestId}` until `status` is `complete`, then fetch
   `downloadLink`. No block renderer, no table assembly, no rich-text
   flattening — the half of the Notion connector that carried the most risk does
   not exist here.

3. **The download link is on another host — do not send it the token.** The
   export lands on signed storage, not `coda.io`. Attaching the `Authorization`
   header to that request would hand a user's Coda token to whatever host the
   API names. This is the one genuinely security-relevant line in the connector.

4. **Bound the polling.** An export that never completes must fail the document,
   not hang the import. A capped number of attempts with a gap between them,
   and a `failed` status surfaced as a skip reason rather than an empty
   document.

5. **Selectors, parsed from what people actually paste:**
   `https://coda.io/d/Handbook_dAbCd1234/Onboarding_su42` carries both ids —
   `_d` prefixes the doc id, `_su` the short page id, and the API accepts that
   short id directly as `pageIdOrName`.
   - a **doc** link or id → every canvas page in it
   - a **page** link → that page
   - nothing → every doc the token can see, bounded by `--since`

6. **Skip pages that have no content, with a reason.** `contentType`
   distinguishes a `canvas` page from an embed or a sync page; only canvas pages
   export anything. Reporting them is better than emitting empty documents that
   `normalizeDocument` then rejects, which reads like a bug.

## A note on the rebrand

Coda is being folded into **Superhuman**: `coda.io/developers` now 307-redirects
to `docs.superhuman.com/developers`. The API base is still
`https://coda.io/apis/v1` and unchanged, but any doc link we write today will
rot. Cite the API base in code and keep prose links to a minimum.

## Where to start

- `src/connectors/folder.js` — the contract at its smallest, and the file a
  connector author actually copies.
- `src/connectors/index.test.js` — the conformance suite runs automatically
  against every registered connector.
- Tests: fixtures mocked at `fetch`. The export job needs a fixture that is
  `inProgress` before it is `complete`, or the polling loop is untested in the
  only state that matters.

## Open questions

- **Three connectors in flight now hand-roll paging and 429 handling** (#22,
  #26, this one), and Coda adds per-bucket pacing that neither of the others
  needed. A shared helper was deferred at the contract stage for want of a
  second implementation to design against; there are now three, and this one is
  different enough to say what it should actually cover. Worth doing once they
  land, rather than in whichever of the three merges first.
- **`--since` has nothing to filter on in the page list.** Coda pages expose
  `createdAt`/`updatedAt` on the doc, but the window would have to be applied
  per page. If the field is absent, does `--since` silently do nothing — which
  is worse than refusing it?
- **Is a whole doc too much?** A Coda doc can be dozens of pages. Notion capped
  a subtree walk at 100 pages because each page was expensive to *discover*;
  here discovery is free and it is the *export* that costs, so the cap belongs
  somewhere else. Cap documents per run, or make `--dry-run` the guard?
- **Tables are the whole point of Coda**, and a table exported as markdown is a
  grid of values with no schema. A table of "decisions with owners and dates" is
  exactly the context worth importing, and exactly what flattens worst. Possibly
  a follow-up that reads tables through the rows API rather than the exporter.
