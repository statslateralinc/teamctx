# Proposal: Dropbox import connector

**Status:** Proposal (suggestion, not committed) · **Serves:** Bring your own tools ·
**Rough size:** Small — genuinely the easiest of the six

## Problem

#25 calls this *"the simplest file-store connector, a good first connector to
build"*, and having now written up four of the six, that assessment holds up.
This proposal's job is mostly to say **why** it is easier, because the reasons
are specific and each one is a place another connector had to do real work.

Dropbox is where a certain kind of team keeps its written record: the folder of
specs, the handover notes, the `.md` files someone maintained for a year. It is
a plain file store, which is exactly what makes it cheap to import and also
what caps how much this connector can ever do.

## What exists today

- **The connector contract** (#21) — `auth → list → fetch`, a registry, and the
  `folder` reference implementation.
- **`normalizeDocument`** (`src/import.js`) — size cap (256KB), empty check,
  title fallback.
- **`--since`** on the shared import surface; the `Context-Source` trailer for
  provenance.
- **Google Drive (#23)** and **Microsoft 365 (#24)** are the useful comparisons.
  Nothing is shared between them yet.
- No Dropbox SDK. The v2 API is JSON-over-POST; `fetch` reaches all of it.

## Why this one is easier — four specific reasons

**1. The whole tree comes back in one call.** `files/list_folder` takes
`recursive: true` and returns every file beneath a path, at every depth.

That is the single biggest difference. Drive has no recursive query, so it needs
a breadth-first walk with a `seen` set because a file can have several parents.
Graph is the same. Notion's tree walk *is* the connector. Coda returns a flat
tree but only per-doc. Here: one request, cursor-paged with
`files/list_folder/continue`, and the recursion problem simply does not exist.

**2. The API says how to fetch each file, so nothing is guessed.** Every file's
metadata carries `is_downloadable`, and when it is false, `export_info.export_as`
names the format to ask for.

Drive needed a hardcoded table of Google mimeTypes. M365 needs extension
sniffing. Dropbox answers the question in the listing, which means the routing
is data-driven and cannot drift when Dropbox adds a file type.

**3. Auth is a copy-paste flow with no redirect URI.** Dropbox's
[OAuth guide](https://developers.dropbox.com/oauth-guide) makes `redirect_uri`
*optional* on the code flow — omit it and Dropbox shows the user an
authorization code on screen to paste back. Add `token_access_type=offline` and
the exchange returns a refresh token.

Compare: Google needs a Cloud project, an OAuth client, a browser loopback
listener, and hands back a token that expires in seven days unless the consent
screen is configured just so. Dropbox needs an app in the App Console and a
paste. It is the closest an OAuth connector gets to Notion's "copy the token".

**4. Rate limiting is one rule.** A 429 *always* carries `Retry-After`, and the
[error handling guide](https://developers.dropbox.com/error-handling-guide) says
to honour it. No per-verb buckets (Coda), no pacing to avoid a limit you reach
by walking normally (Notion), no dynamic invisible quota (Graph).

## The one hard part, and it is borrowed

Dropbox is a file store, so a Word document in Dropbox is a real `.docx` — a ZIP
of OOXML, exactly as in Microsoft 365 (#24). There is no server-side conversion
to text.

It is worse than it first looks, and this is the finding worth carrying out of
this write-up: **`files/export` does not produce text either.** A Google Doc
stored in Dropbox comes back with `export_as: "docx"`. So the one path that
looks like Drive's markdown export actually lands on the same OOXML problem.

Only `.paper` exports as markdown.

That makes `src/formats/docx.js` — proposed in the M365 write-up as a shared,
dependency-free reader — a blocker for three things rather than one: `folder`
reading Word files off local disk, M365, and this. **It should land first, on
its own.** Three consumers is no longer a speculative argument for shared
placement.

## Suggested approach (one way to do it)

### Selectors

```bash
teamctx import --from dropbox /Specs                    # a folder path
teamctx import --from dropbox "https://www.dropbox.com/scl/fo/…"   # a shared link
teamctx import --from dropbox id:AbCdEf123               # a file id
```

Paths are Dropbox's own form and are what people will reach for first. A shared
link resolves through `sharing/get_shared_link_metadata`, which also accepts a
relative `path` to reach inside a shared folder.

As with Drive and M365, **no bare "everything" form.** `""` is a legal Dropbox
path meaning the entire account, which is precisely why it must be typed rather
than defaulted into.

### Listing and routing

One `files/list_folder` with `recursive: true`, paged via
`files/list_folder/continue` while `has_more`. Then per entry:

| Metadata | Handling |
| --- | --- |
| `.md`, `.txt`, `is_downloadable: true` | `files/download` |
| `.paper` (`export_as: markdown`) | `files/export` |
| `is_downloadable: false`, `export_as: docx` | **skipped in v1** — needs the OOXML reader |
| `.docx` | **skipped in v1** — same |
| folder entries (`.tag: "folder"`) | ignored; the recursive listing already has the children |
| everything else | `unsupported type` |

Once `src/formats/docx.js` exists, the two skipped rows become supported and
nothing else about this connector changes. That is the shape a scope cut should
have.

`--since` filters client-side on `server_modified`. There is no time filter on
`list_folder`, but unlike M365 that costs nothing extra here: the listing was a
single call regardless, so filtering in memory wastes no requests.

### Two API details that will bite

- **`Dropbox-API-Arg` is JSON in an HTTP header.** Download and export put their
  arguments there rather than in a body, and HTTP headers are ASCII. A file
  named `Café notes.md` breaks the request unless every non-ASCII character is
  escaped to `\uXXXX` first. This is the kind of thing that passes every fixture
  test and fails on the first real folder.
- **Two hostnames.** RPC calls go to `api.dropboxapi.com`, content to
  `content.dropboxapi.com`. Mixing them up returns a confusing error rather than
  a clear one.

### Auth

`DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET` and `DROPBOX_REFRESH_TOKEN` in
`.env.local`, exchanged lazily on the first request — the same shape Drive
established, and for the same reason: `auth(env)` stays synchronous and spends
nothing on a misconfigured run.

`DROPBOX_ACCESS_TOKEN` is also accepted on its own. The App Console's "Generate
access token" button produces a short-lived one, which is enough to try the
connector out without completing the code flow at all.

Scopes: `files.metadata.read`, `files.content.read`, `sharing.read`. All three
are read-only, and there is no restricted-scope review to pass — another place
this is simply easier than Drive.

## Scope

**In:** recursive folder import, `.md` / `.txt` / `.paper`, shared links,
`--since`, paths and file ids.

**Out:** `.docx` and other exportable-as-docx files until `src/formats/docx.js`
lands; `.pptx` / `.xlsx` for the reason every other connector skips
spreadsheets and decks; team folders and Dropbox Business admin endpoints, which
are a different permission model and a different issue; file *comments*, which
are a separate endpoint and where a decision is sometimes actually recorded.

## Where to start

- `src/connectors/gdrive.js` (#23) — closest working example: lazy token
  exchange, metadata-first classification, skip-with-a-reason.
- `src/connectors/coda.js` (#27) — the other connector whose `fetch` is an
  export rather than a download.
- `src/connectors/index.test.js` — the conformance suite runs against every
  registered connector automatically, including the rule that none may import
  the AI layer.
- Tests: fixtures mocked at `fetch`. Worth a test with a non-ASCII filename
  specifically, since the `Dropbox-API-Arg` escaping is the one piece of this
  connector that is easy to get silently wrong.

## Open questions

- **Is building on Paper wise?** `.paper` is the only thing here that exports as
  markdown, so it is the highest-value content this connector can reach. But
  Dropbox
  [discontinued the Paper mobile and desktop apps in October 2025](https://help.dropbox.com/installs/paper-mobile-discontinuation),
  leaving web only. The files are still stored and still exportable, but this is
  a wind-down. Worth supporting anyway — the docs that exist are worth importing
  once — but not worth designing around.
- **Should this connector wait for `src/formats/docx.js`, or ship without it?**
  Shipping first gives a genuinely useful connector for markdown-keeping teams
  and a small, reviewable PR. It also means announcing a Dropbox connector that
  ignores Word documents, which some users will read as broken.
- **Does `sharing/get_shared_link_metadata` cover the modern `/scl/` links?**
  Dropbox changed its shared-link format; the endpoint is documented against the
  older `/s/` form. Needs checking against a freshly created link before it goes
  in the help text.
- **Five connectors now hand-roll paging and backoff.** Dropbox's is the
  simplest of the five, which is itself evidence for the position the last two
  write-ups reached: these are five different problems that happen to share a
  verb, not one problem solved five times.
