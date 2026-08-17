# Proposal: Microsoft 365 import connector

**Status:** Proposal (suggestion, not committed) · **Serves:** Bring your own tools ·
**Rough size:** Large — the fetch is easy, the text extraction is a second PR

## Problem

`context-import.md` names the reason this connector matters, and it is not a
technical one: *"many SMB/mid-market teams are Microsoft-cloud-first."* For a
large share of the teams teamctx is aimed at, Slack, Notion and Coda are not
where the writing lives. SharePoint is. The architecture doc is a `.docx` in a
document library, and it has been read twice.

This is also the connector where the pattern established by the other five
stops working, so it is worth saying plainly up front:

> Every connector so far ends with an API handing back text. Microsoft Graph
> never does. There is no export-to-text, for any file type, at all.

That single fact decides everything below.

## What exists today

- **The connector contract** (#21) — `auth → list → fetch`, a registry, and the
  `folder` reference implementation. A connector produces documents and nothing
  else: no AI calls, no queue writes, no dedupe.
- **`normalizeDocument`** (`src/import.js`) — size cap (256KB), empty check,
  title fallback.
- **`--since`** on the shared import surface, and the `Context-Source` trailer
  that puts provenance in the git history.
- **Google Drive (#23) is the closest sibling** and worth reading first — same
  shape of problem, opposite answers at almost every turn. Nothing is shared
  between them yet; see the open question on that.
- **`src/prefs.js`** — a gitignored, per-user preference store
  (`.teamctx/.local/prefs.json` locally, KV when hosted). It already exists, and
  it is the obvious home for a token that a login flow obtains rather than one
  the user pastes.
- No Graph SDK. `@microsoft/microsoft-graph-client` plus MSAL is a large
  dependency tree for what is four REST endpoints and a token exchange.

## The constraints that decide the architecture

**1. Graph cannot convert anything to text.** The
[format conversion endpoint](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content-format)
takes exactly three target formats:

| Format | Sources | Useful here? |
| --- | --- | --- |
| `pdf` | doc, docx, ppt, pptx, xls, odt, html, md… | No — still binary |
| `jpg` | ~120 extensions | No |
| `html` | loop, fluid, whiteboard only | Not for Word documents |

Google Docs export as markdown in one request. A `.docx` in OneDrive can be
turned into a PDF or a picture, and that is the whole list. Since a `.docx` *is*
the native format — not a pointer to a server-side document, the way a Google
Doc is — the bytes are the document, and the bytes are a ZIP.

So **text extraction has to happen locally, or not at all.** There is no third
option, and no amount of API cleverness produces one.

**2. Children listing supports no `$filter`.** `driveItem/children` accepts
`$expand`, `$select`, `$top`, `$orderby` and `$skipToken` —
[not `$filter`](https://learn.microsoft.com/en-us/graph/api/driveitem-list-children).
Drive could push `modifiedTime >` into the query and let the server do the work;
here `--since` is a client-side filter over everything the folder returns. It
still saves the download, which is the expensive part, but it does not save the
listing.

**3. Any sharing link resolves directly — but possibly at the cost of a write
scope.** `GET /shares/{encoded}/driveItem` takes a base64url-encoded sharing URL
with a `u!` prefix and returns the item, whatever the link's shape. That is far
better than Drive, where five URL forms each needed their own regex.

The catch is in the permissions table:
[shares-get](https://learn.microsoft.com/en-us/graph/api/shares-get) lists
`Files.ReadWrite` as the *least privileged* delegated permission, and does not
list `Files.Read.All` at all. A read-only tool asking for a write scope is
exactly the kind of thing that gets an app rejected by an IT admin, and it is
the opposite of the line held for Drive. **This needs verifying against a real
tenant before it goes in** — Graph's permission tables are not always current,
and `Files.Read.All` may well work.

**4. Device code flow is available, and it is the best CLI auth of any
connector.** Google's device flow does not support any usable Drive scope, so
Drive was stuck with a browser dance the user runs themselves. Microsoft's
[device authorization grant](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)
supports arbitrary Graph scopes, needs no client secret (public client), and
returns a refresh token when `offline_access` is requested. Print a code, the
user visits a URL, done — no listener, no browser launch, no secret to store.

`context-import.md` lists *"device-code flow vs. pasted tokens for CLI-only
users"* as an open question. Drive answered it one way by force. Microsoft
answers it the other way, and the difference is not a preference — it is what
each identity provider will allow.

## Suggested approach (one way to do it)

### 1. Text extraction lives in `src/formats/`, not in the connector

A `.docx` is a ZIP holding `word/document.xml`. Extracting its text is: read the
ZIP central directory, `zlib.inflateRawSync` the one entry, strip tags with
paragraph breaks at `</w:p>`. Node ships `zlib`, so this is no new dependency —
roughly 80 lines, most of it the ZIP header layout.

Eighty lines of ZIP parsing inside a "thin fetch adapter" is wrong, though. It
belongs in `src/formats/docx.js`, for a reason that is concrete rather than
tidy-minded: **`folder` and Dropbox (#25) want exactly the same thing.** Putting
it there means `teamctx import ./docs` starts reading Word files off the local
disk too, which is a feature this project's users will hit long before they
connect a tenant.

This is plausibly its own PR, landing first. Happy to split it if review agrees.

Worth handling deliberately:

- ZIP entries may be *stored* (method 0) as well as deflated — both appear in
  real `.docx` files.
- Check `size` from the listing before downloading. A 40MB Word document is 40MB
  of embedded images wrapped around 20KB of prose, and `normalizeDocument` would
  reject the result anyway — after paying for all of it.
- `.doc` (the pre-2007 binary format) is a different problem entirely and is out.

### 2. Selectors are whatever the user pasted

```bash
teamctx import --from m365 "https://contoso.sharepoint.com/sites/Eng/Shared%20Documents/Specs"
teamctx import --from m365 "https://contoso-my.sharepoint.com/:w:/g/personal/…"
teamctx import --from m365 "https://1drv.ms/w/s!AbCd…"
```

All three go through `/shares/u!<base64url>/driveItem`. No URL parsing, no
per-product special cases, and it works for short links, which no amount of
regex would.

As with Drive there is **no bare "import everything" form**. `Files.Read.All`
sees the whole tenant; the selection has to happen on the command line.

### 3. Walk folders, classify by extension

Graph has no recursive listing either, so this is the same breadth-first walk as
Drive and Notion, with the same `seen` set and the same `MAX_FILES` cap.

| Extension | Handling |
| --- | --- |
| `.md`, `.txt` | download via `/content` |
| `.docx` | download, extract with `src/formats/docx.js` |
| folder | recurse |
| `.xlsx`, `.pptx` | **skipped**, with a reason |
| everything else | `unsupported type` |

`.xlsx` is skipped for the reason Drive skips Sheets: a spreadsheet is records,
not reasoning. `.pptx` is skipped for a weaker reason — extracting slide text
means a second OOXML shape (`ppt/slides/slideN.xml`), and that is scope for a
follow-up rather than a decision that decks do not matter.

As with Drive, **the classification happens in `list`, from metadata**, so
nothing unimportable is downloaded and `--dry-run` is cheap.

### 4. Auth reads a refresh token; the device flow gets its own command

The connector keeps the shape Drive established — `auth(env)` is synchronous and
returns `{ ok, help }`, credentials come from `M365_CLIENT_ID`, `M365_TENANT_ID`
and `M365_REFRESH_TOKEN`, and the access token is exchanged lazily on the first
request. No client secret: a public client does not have one.

The device flow does **not** go in `auth`, even though it would be a much better
experience, and the reason is structural rather than cautious. `auth(env) →
{ ok, help }` has nowhere to print a user code and no business blocking for
ninety seconds while someone finds their phone. Interactivity belongs in a
command:

```
teamctx auth m365     → prints a code and a URL, polls, stores the refresh token
```

That is its own issue. It would also be the first thing to justify writing
credentials into `src/prefs.js` — gitignored and per-user — instead of asking
people to paste secrets into `.env.local` by hand. If it lands, Drive's seven-day
refresh-token misery is the next thing it should fix.

### 5. Throttling is honest here in a way Drive's was not

Microsoft
[publishes no fixed per-minute number](https://learn.microsoft.com/en-us/graph/throttling)
for SharePoint and OneDrive — it is dynamic, and the `Retry-After` on a 429 is
the authoritative answer. Requests against different sites still draw on shared
backend buckets, so "we are only reading one folder" is not protection.

That makes the retry loop load-bearing, unlike Drive where the quota was far
past anything an import could reach. Honour `Retry-After` on 429 and 503;
exponential backoff with jitter only where the header is absent.

## Scope

**In:** OneDrive and SharePoint document libraries — the "library import" the
issue actually asks for. Folders walked recursively, `.md`/`.txt`/`.docx`,
`--since`, sharing links of any shape.

**Out, and each for a stated reason:**

- **SharePoint site pages.** `/sites/{id}/pages` with `$expand=canvasLayout`
  returns webparts carrying `innerHtml`, so a modern SharePoint wiki page *is*
  reachable as text — this is the closest thing M365 has to a Notion page, and
  it is genuinely valuable. It is also a different resource type with a
  different permission (`Sites.Read.All`, and unsupported for personal
  Microsoft accounts), and it would roughly double this connector. The issue
  says *library* import. Follow-up.
- **OneNote.** `/onenote/pages/{id}/content` returns HTML. Same argument.
- **Teams messages.** That is Slack's problem with different nouns, and #22
  already owns the thinking.
- **`.pptx`, `.xlsx`, `.doc`, PDFs, and anything binary.**

## Where to start

- `src/connectors/gdrive.js` (#23) — closest sibling: same BFS walk, same
  metadata-first classification, same lazy token exchange. Read it before
  writing anything here.
- `src/connectors/folder.js` — the contract at its smallest.
- `src/connectors/index.test.js` — the conformance suite runs against every
  registered connector automatically, including the rule that none may import
  the AI layer.
- Tests: fixtures mocked at `fetch`, plus — importantly — a **real `.docx`
  committed as a fixture** for `src/formats/docx.js`. A hand-written ZIP will
  agree with a hand-written parser and prove nothing.

## Open questions

- **Does `Files.Read.All` work against `/shares`?** The docs say the least
  privileged delegated permission is `Files.ReadWrite`. If that is accurate, a
  read-only tool has to request a write scope purely to resolve a pasted link,
  and the alternative is parsing SharePoint URLs by hand after all. Worth
  testing against a real tenant early, because it changes the design.
- **Should `src/formats/docx.js` land first, on its own?** It is useful without
  this connector — `folder` gains Word support the day it merges — and it is the
  riskiest code here. Splitting it means this PR is small and boring, which is
  usually the right shape.
- **Four connectors now hand-roll paging and backoff**, and all four differently:
  Slack recovers, Notion paces, Coda buckets by verb, Drive barely needs it, and
  Graph is dynamic and header-driven. The contract proposal deferred a shared
  helper until there was something to design against. There is now — but the
  divergence looks less like duplication and more like five genuinely different
  problems.
- **Is `teamctx auth <connector>` the right shape?** It would fix M365 and Drive
  at once, and it is the only thing that makes the device flow reachable. It is
  also new surface that every future connector will be measured against, so it
  deserves its own issue rather than arriving inside this one.
- **Does anything survive a `.docx` round-trip that should not?** Tracked
  changes, comments, and deleted-but-not-accepted text all live in
  `word/document.xml`. Naïve tag-stripping can resurrect a sentence someone
  deleted, and putting that into shared context would be worse than importing
  nothing. Needs a real document with revision marks to find out.
