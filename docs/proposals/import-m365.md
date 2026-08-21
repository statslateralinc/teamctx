# Proposal: Microsoft 365 import connector

**Status:** Proposal (suggestion, not committed) · **Serves:** Bring your own tools ·
**Rough size:** Large — but most of it is one reusable piece that lands separately

## Problem

`context-import.md` names the reason this connector matters, and it is not a
technical one: *"many SMB/mid-market teams are Microsoft-cloud-first."* For a
large share of the teams teamctx aims at, Slack, Notion and Coda are not where
the writing lives. SharePoint is. The architecture doc is a `.docx` in a
document library, and it has been read twice.

It is also the connector where the pattern the other five share breaks:

> Every connector so far ends with an API handing back text.
> **Microsoft Graph never does.**

That one fact decides everything below.

## What exists today

Five connectors are built or in review, and three pieces of shared machinery
landed *after* this write-up was first drafted — which changes the plan:

- **`teamctx auth <connector>`** and the contract's optional `authorize`. A
  login flow is no longer something this connector must invent or defer.
- **`cli/oauth-loopback.js`** — a short-lived listener on `127.0.0.1`, written
  for Drive. Microsoft supports the same desktop redirect, so **M365 needs no
  new auth plumbing at all**.
- **Google Drive (#23) is built**, not hypothetical. It is the closest sibling:
  same BFS folder walk, same metadata-first classification, same lazy token
  exchange. Read `src/connectors/gdrive.js` before writing anything here.

Still relied on and unchanged: `normalizeDocument`, `--since` on the shared
import surface, and the `Context-Source` trailer.

No Graph SDK. `@microsoft/microsoft-graph-client` plus MSAL is a large
dependency tree for four REST endpoints and a token exchange.

## The constraint that decides the architecture

**Graph cannot convert anything to text.** The
[format conversion endpoint](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content-format)
takes exactly three targets:

| Format | Sources | Useful here? |
| --- | --- | --- |
| `pdf` | doc, docx, ppt, xls, odt, html, md… | No — still binary |
| `jpg` | ~120 extensions | No |
| `html` | loop, fluid, whiteboard only | Not for Word documents |

A Google Doc is a pointer to a server-side document, so Drive can render it as
markdown. A `.docx` **is** the native format — the bytes are the document, and
the bytes are a ZIP. So text extraction happens locally or not at all.

Dropbox settled where that belongs. A Google Doc *stored in Dropbox* reports
`export_as: "docx"`, so Dropbox hits the same wall. Three things now want the
same reader:

1. `folder` — `teamctx import ./docs` would read Word files off local disk
2. Dropbox — its `.docx` and `export_as: docx` rows are currently skipped
3. M365 — without it, this connector imports almost nothing

**`src/formats/docx.js` should land first, as its own PR.** Roughly 80 lines of
ZIP central-directory parsing plus `zlib.inflateRawSync` — no new dependency,
since Node ships `zlib`. It is also the riskiest code in this area, which is a
second reason to review it on its own.

## The other constraints, briefly

**Children listing supports no `$filter`.**
[`driveItem/children`](https://learn.microsoft.com/en-us/graph/api/driveitem-list-children)
accepts `$expand`, `$select`, `$top`, `$orderby` and `$skipToken` — not
`$filter`. Drive pushed `modifiedTime >` server-side; here `--since` filters in
memory. It still saves the download, which is the expensive part.

**No recursive listing.** Same BFS walk as Drive and Notion. Dropbox's
`recursive: true` has no equivalent here.

**Throttling is dynamic and undocumented.** Microsoft
[publishes no fixed per-minute number](https://learn.microsoft.com/en-us/graph/throttling)
for SharePoint and OneDrive; the `Retry-After` on a 429 is authoritative, and
requests against different sites still draw on shared backend buckets. That
makes the retry loop load-bearing, unlike Drive where the quota sat far past
anything an import could reach.

**Work or school account only, for SharePoint.**
[`GET /sites/…`](https://learn.microsoft.com/en-us/graph/api/site-get) is
explicitly *"Not supported"* for personal Microsoft accounts. OneDrive personal
still works through `/me/drive`.

## Suggested approach

### 1. Parse SharePoint URLs; keep `/shares` as a fallback

The earlier draft routed every selector through
`/shares/u!<base64url>/driveItem`, which resolves any sharing link whatever its
shape. That is elegant, but its
[permissions table](https://learn.microsoft.com/en-us/graph/api/shares-get)
lists `Files.ReadWrite` as the *least privileged* delegated permission and does
not list `Files.Read.All` at all. A read-only tool asking for a write scope is
what gets an app refused by an IT admin.

There is a way around it for the common case. A SharePoint URL decomposes
directly into Graph's own addressing:

```
https://contoso.sharepoint.com/sites/Eng/Shared Documents/Specs
        \____ hostname ____/  \_ path _/ \___ drive path ___/

GET /sites/contoso.sharepoint.com:/sites/Eng          -> the site
GET /sites/{site-id}/drive/root:/Shared Documents/Specs:/children
```

Both are documented against `Sites.Read.All` — a read scope. So:

- **SharePoint URLs** — parsed, no `/shares`, read scope only
- **OneDrive paths** (`/Documents/Specs`) — straight to `/me/drive/root:/…`
- **`1drv.ms` short links** — cannot be parsed, so these fall back to `/shares`,
  and only then does the scope question arise at all

That keeps the write scope off the common path, and confines an unresolved
question to one selector form a user can avoid.

**Still needs a real tenant to confirm.** If `Files.Read.All` does work against
`/shares`, the fallback is uncontroversial and the parsing is an optimisation
rather than a workaround.

### 2. Two account types, decided at login

Microsoft has two populations and they are not interchangeable. A **work or
school** account reaches SharePoint; a **personal** Microsoft account does not —
`GET /sites/…` is documented as *"Not supported"* for it. They also sign in
through different tenant endpoints, and requesting a scope the account cannot
hold fails the whole consent rather than degrading.

| | Work / school | Personal |
| --- | --- | --- |
| Tenant endpoint | `/organizations` | `/consumers` |
| Scopes | `Files.Read.All Sites.Read.All offline_access` | `Files.Read.All offline_access` |
| OneDrive | ✅ | ✅ |
| SharePoint libraries | ✅ | ✅ *(shared links only, via `/shares`)* |
| SharePoint sites by URL | ✅ | ❌ |

So `authorize` asks which one, and picks the endpoint and scope set from the
answer. That is not a workaround — it is the only correct behaviour for a
connector serving both, and getting it wrong means a personal account can never
log in at all.

The app registration must be created as **"Accounts in any organizational
directory and personal Microsoft accounts"** for both to work against one
client id.

### 3. Login reuses what Drive built

`authorize` uses the existing loopback helper. Microsoft supports the desktop
loopback redirect, so this is the same shape as `teamctx auth gdrive`: a client
id from an Entra app registration, a browser round trip, a refresh token into
`.env.local`. **No new auth code.**

Microsoft also supports the
[device code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)
for arbitrary Graph scopes with no client secret — which Google does *not* allow
for Drive. It is a nicer flow for headless machines, but it is a second auth
mechanism to maintain for one connector. **Proposed: reuse loopback now, and
revisit device code as a shared option if a second connector wants it.**

Worth confirming during implementation: whether the Entra app can be registered
as a *public* client with no secret, in which case `M365_CLIENT_SECRET`
disappears from the setup entirely.

### 4. Walk folders, classify by extension

| Extension | Handling |
| --- | --- |
| `.md`, `.txt` | download via `/content` |
| `.docx` | download, extract with `src/formats/docx.js` |
| folder | recurse |
| `.xlsx`, `.pptx` | **skipped**, with a reason |
| everything else | `unsupported type` |

`.xlsx` for the reason Drive skips Sheets: a spreadsheet is records, not
reasoning. `.pptx` because slide text is a second OOXML shape
(`ppt/slides/slideN.xml`) that belongs in a follow-up — not because decks do not
matter.

As with Drive and Dropbox, **classification happens in `list`, from metadata**,
so nothing unimportable is downloaded and `--dry-run` stays cheap. Check `size`
before downloading: a 40MB Word file is 40MB of embedded images wrapped around
20KB of prose, and `normalizeDocument` would reject the result anyway.

## Scope

**In:** OneDrive and SharePoint document libraries — the "library import" the
issue asks for. Recursive folders, `.md` / `.txt` / `.docx`, `--since`,
SharePoint URLs and OneDrive paths.

**Out, each for a stated reason:**

- **SharePoint site pages.** `/sites/{id}/pages` with `$expand=canvasLayout`
  returns webparts carrying `innerHtml`, so a modern SharePoint wiki page *is*
  reachable as text — the closest thing M365 has to a Notion page, and genuinely
  valuable. It is a different resource type with a different permission and
  would roughly double this connector. The issue says *library* import, which
  means files. Follow-up.
- **OneNote.** `/onenote/pages/{id}/content` returns HTML. Same argument.
- **Teams messages.** Slack's problem with different nouns; #22 owns it.
- **`.pptx`, `.xlsx`, `.doc`, PDFs, binaries.**

## What a personal account can verify, and what it cannot

Worth stating plainly, because the connector is built for both audiences but
will initially be tested by one. The SharePoint-site path is not scoped out —
it is written, unit-tested, and shipped **unverified against a live tenant**,
and the PR should say so rather than imply otherwise.

**Exercised end to end with a personal Microsoft account:**

- the whole login flow — app registration, loopback redirect, token exchange,
  refresh, and the `/consumers` endpoint with its reduced scope set
- `/me/drive` listing, the BFS folder walk, and the `seen` set
- classification, skip reasons, size pre-checks, `--since`
- `.docx` extraction — entirely local, so a real Word file tests it fully
- `/shares` resolution, using a `1drv.ms` link the account shares with itself —
  which also answers whether `Files.Read.All` suffices there

**Not reachable without a work or school tenant:**

- `GET /sites/{hostname}:/{path}` and the SharePoint drive-path walk
- the `Sites.Read.All` scope and the `/organizations` endpoint
- throttling behaviour at tenant scale

That is roughly one selector form out of three. Everything downstream of
"we have a driveItem" is shared between them, so a bug in the SharePoint path
would be in URL parsing and site resolution — the part most amenable to unit
tests against captured responses.

Mitigation: capture the two SharePoint responses from Microsoft's own
documentation as fixtures, keep the parsing pure and separately tested, and put
an explicit "unverified against a live tenant" note in the PR body so a reviewer
with one knows exactly where to look.

## Suggested order

1. **`src/formats/docx.js`** — standalone PR, useful the day it lands
2. **Wire it into `folder` and Dropbox** — two connectors gain Word support
3. **This connector**

Dropbox's Paper bug and Drive's design both changed on contact with a real
account, so expect the same here for the OneDrive half — and expect the
SharePoint half to need a second pair of hands.

## Where to start

- `src/connectors/gdrive.js` — closest working example: BFS walk with a `seen`
  set, metadata-first classification, lazy token exchange, loopback `authorize`
- `src/connectors/index.test.js` — the conformance suite runs against every
  registered connector, including the rule that none may import the AI layer
- Tests: fixtures mocked at `fetch`, plus a **real `.docx` committed as a
  fixture** for the reader. A hand-written ZIP will agree with a hand-written
  parser and prove nothing.

## Open questions

- **Does `Files.Read.All` work against `/shares`?** Decides whether the fallback
  is fine or whether `1drv.ms` links have to be refused outright. Answerable
  with a personal account, which is convenient — share a file with yourself and
  try to resolve the link.
- **Can the Entra app be a public client?** If so, the setup loses a secret —
  and a public client is also what makes the device code flow available later.
- **What survives a `.docx` round trip that should not?** Tracked changes,
  comments, and deleted-but-unaccepted text all live in `word/document.xml`.
  Naïve tag-stripping can resurrect a sentence someone deleted, and putting that
  into shared context would be worse than importing nothing. Needs a real
  document with revision marks to answer.
- **Five connectors now hand-roll paging and backoff**, all differently, because
  the limits genuinely differ — Slack recovers, Notion paces, Coda buckets by
  verb, Drive barely needs it, Dropbox honours one header, Graph is dynamic and
  invisible. That looks less like duplication than like six different problems
  sharing a verb.
