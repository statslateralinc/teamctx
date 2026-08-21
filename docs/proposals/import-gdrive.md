# Proposal: Google Drive import connector

**Status:** Proposal (suggestion, not committed) · **Serves:** Bring your own tools ·
**Rough size:** Medium — the extraction is easy; the auth is the work

## Problem

Drive is where the long-form thinking lives. The architecture doc, the incident
review, the "why we chose Postgres" memo someone wrote in an afternoon and
nobody has opened since. It is the closest thing most teams have to a written
record of their own reasoning, and it is entirely invisible to an AI assistant.

Two connectors already landed against the contract, and each had one hard part:
Slack's was **selection** (a channel is mostly noise), Notion's was
**structure** (content is a block tree, not a document). Drive has neither.
Google Docs exports as markdown natively — one request, and the text is already
in the shape the distiller wants.

Drive's hard part is **authentication**, and it is harder than both of them
combined. That is the honest summary of this proposal: the fetch layer is the
smallest of the three, and getting a token into `.env.local` is a documented
multi-step procedure with a sharp edge in it.

## What exists today

- **The connector contract** (#21) — `auth → list → fetch`, a registry, and the
  `folder` reference implementation. A connector produces documents and nothing
  else: no AI calls, no queue writes, no dedupe.
- **`normalizeDocument`** (`src/import.js`) — size cap (256KB), empty check,
  title fallback, applied to whatever a connector returns.
- **`--since`** on the shared import surface (`1a06abf`), and the
  `Context-Source` trailer that records provenance in the git history
  (`47bd168`) — so `import:gdrive:<fileId>` shows up in `git log .teamctx/`
  without any work here.
- **Slack (#22), Notion (#26), Coda (#27) are siblings, not dependencies.**
  Nothing here imports from them. The patterns are worth copying; the code is
  not shared yet, deliberately — see the open question on a paging helper.
- No HTTP client and no Google SDK. `googleapis` is a ~50MB dependency that
  wraps a discovery document; this connector needs four endpoints and bare
  `fetch` reaches all of them.

## The constraints that decide the architecture

**1. There is no token to copy.** Slack, Notion and Coda all end the same way:
the user opens a settings page, clicks "create", and pastes a string. Google has
no equivalent. `drive.readonly` is only reachable through a full three-legged
OAuth flow against an OAuth client the *user* creates in *their own* Google
Cloud project.

Worse, the device-code flow — the one designed for exactly this situation, a
program with no browser — [supports only a fixed scope
list](https://developers.google.com/identity/protocols/oauth2/limited-input-device),
and the only Drive scopes on it are `drive.appdata` and `drive.file`. Neither can
read a document the user already has. So the desktop loopback flow is the only
route, and it needs a browser and a local listener.

**2. The scope we need is a restricted one.** `drive.file` sees only files the
app itself created or the user picked through Google's own Picker UI — useless
for a CLI. `drive.metadata.readonly` cannot read content. That leaves
`drive.readonly`, which Google classifies as **restricted**: publishing an app
that requests it to external users requires verification *and* a third-party
security assessment.

teamctx never ships a client id, so it never faces that review — the user's own
client does. But it lands on the user as this trap: an OAuth client left in
**Testing** publishing status issues refresh tokens that **expire after seven
days**. A connector that works all week and fails silently the next Monday is a
bad connector, so this has to be said in the `help` text, not discovered.

The realistic paths, in the order most teams will land on them:

| Situation | Consent screen | Refresh token life |
| --- | --- | --- |
| Google Workspace org (most teams) | User type **Internal** | Does not expire |
| Personal Gmail | External + Testing | **7 days** |
| Personal Gmail, published | External + In production | Needs verification for a restricted scope |

**3. `parents` is one level deep.** `files.list` with `'<id>' in parents`
returns a folder's direct children and nothing else — Drive has no recursive
query. A folder tree is a walk, exactly like Notion's page tree and Coda's page
hierarchy, and it needs the same cycle guard and the same cap.

**4. Rate limits are, for once, not the problem.** 325,000 quota units per
minute per user per project; a `files.list` costs 100 and an export costs 200.
That is roughly 1,600 document exports a minute — far past anything a review
queue could absorb. Retries still belong in the code (403 `userRateLimitExceeded`,
429, and 5xx, with [truncated exponential
backoff](https://developers.google.com/workspace/drive/api/guides/limits) and
jitter) but they are defensive here, unlike Slack where ignoring `Retry-After`
turned a slow import into a failed one.

The real ceiling is size: Drive caps an export at 10MB, and `normalizeDocument`
rejects anything over 256KB. Every oversized document fails at *our* limit long
before Google's.

## Suggested approach (one way to do it)

### 1. `auth` exchanges a refresh token; teamctx never runs the browser dance

```
GOOGLE_CLIENT_ID=…
GOOGLE_CLIENT_SECRET=…
GOOGLE_REFRESH_TOKEN=…
```

`auth(env)` POSTs these to `https://oauth2.googleapis.com/token` with
`grant_type=refresh_token` and keeps the access token for the run. Access tokens
last an hour; an import is minutes.

Running the loopback flow *inside* the connector would mean an HTTP listener, a
browser launch, and somewhere to persist the result — three things a thin
pull-based adapter has no business owning, and a rule the other three connectors
all keep. The `help` string carries the procedure instead, including the
seven-day warning.

`GOOGLE_ACCESS_TOKEN` is also accepted, unrefreshed, so the connector can be
exercised with a token from the OAuth Playground without a client secret.

Two things that look like shortcuts and are not, recorded so nobody re-proposes
them:

- **`context-import.md` leaves "device-code flow vs. pasted tokens for CLI-only
  users" open.** For Drive it is settled: the device flow cannot request
  `drive.readonly` at all. Pasted credentials are not a preference here, they
  are the only option.
- **`gcloud auth application-default login --scopes=…/drive.readonly` does not
  help.** Adding a non-Cloud scope requires `--client-id-file` pointing at an
  OAuth client you created yourself, so it skips none of the setup — it only
  replaces the last step, and leaves the credentials somewhere teamctx would
  have to go looking for.

### 2. A file is a document; a folder is a selector

The same rule Notion's walk turned on. Recurse *through* folders for structure,
never *into* a file — each document gets its own id, its own queue entry, its own
yes or no. Importing a folder tree as one blob would hand the manager a single
review covering forty documents, which is precisely the granularity the queue
exists to avoid.

BFS with a `seen` set (Drive files can have multiple parents) and a `MAX_FILES`
cap that stops with one skip line rather than one per file — the shape
`listSubtree` already has in the Notion connector.

### 3. Selectors, and why there is no bare form

```bash
teamctx import --from gdrive https://drive.google.com/drive/folders/<id>   # a folder, recursively
teamctx import --from gdrive https://docs.google.com/document/d/<id>/edit  # one doc
teamctx import --from gdrive <fileId>                                      # bare id
```

Notion allows `--from notion` with no selector, because a Notion integration
sees only what the user explicitly connected — the selection already happened in
Notion's UI. **Drive has no such gate.** `drive.readonly` sees the user's entire
Drive, so the same bare form would mean "import everything I have ever owned".

So `--from gdrive` with no selector is an error that explains itself. Rule 4 of
the contract asks for explicit selection; here the CLI is the only place that
selection can happen.

### 4. Extraction is a mimeType switch

| mimeType | Handling |
| --- | --- |
| `…apps.document` (Google Doc) | `files.export?mimeType=text/markdown` — native markdown |
| `text/markdown`, `text/plain` (uploaded) | `files.get?alt=media` |
| `…apps.folder` | recurse; not a document |
| `…apps.presentation` (Slides) | `files.export?mimeType=text/plain` |
| `…apps.spreadsheet` | **skipped**, with a reason |
| everything else — PDF, `.docx`, images, video, `.apk`, any binary | `unsupported type`, matching `folder` |

Markdown export for Docs is [the documented
format](https://developers.google.com/workspace/drive/api/guides/ref-export-formats)
and it is the reason this connector is small: headings, lists, tables and links
arrive already rendered, so there is no equivalent of Notion's block renderer.

**Sheets is the only Google-native skip.** It cannot export text at all — the
formats are CSV and TSV, and only for the first sheet. A spreadsheet is records
rather than reasoning, which is the wrong shape for a context tree. Same call
the Notion proposal made about databases.

Slides *is* in, via `text/plain`. The "first-slide only" caveat in Google's
export table applies to the image formats (`image/jpeg`, `image/png`,
`image/svg+xml`), not to text. A deck's plain-text export is bullet fragments
without speaker notes, which is thin — but a decision presented to the team is
often only ever written down on a slide, and thin-but-real context is what the
review queue exists to judge. Let the manager reject it.

### The filter runs in `list`, not in `fetch`

This matters more than it looks. A real Drive is mostly photos, video, installers
and zip files — a folder of documents is the exception, not the rule. The
mimeType arrives as *metadata* from `files.list`, so the decision to skip a 2GB
video is made before a single byte of it is requested. Nothing unreadable is ever
downloaded, and `--dry-run` can report the whole folder for the cost of one
listing call.

Skips carry a reason and appear in that output, the way `folder` reports a
`.png`. Silence would read as a bug.

### 5. Details that are easy to get wrong

- **`fields` is not optional.** `files.list` returns `id, name, mimeType` and
  nothing else unless asked. Every call needs
  `fields=nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,parents)`.
- **Shared drives need two flags.** `supportsAllDrives=true` and
  `includeItemsFromAllDrives=true` on every request. One line, and without it a
  team's actual documents — the ones on a shared drive rather than in someone's
  My Drive — are invisible.
- **`trashed = false`** belongs in every `q`, or deleted documents import.
- **`--since` is a real server-side filter here:** `modifiedTime > '<iso>'` goes
  straight into the `q` string. Notion could only sort and stop early; Drive
  filters properly, which makes this the first connector where a repeat import
  is genuinely cheap.
- **Ids and provenance:** `gdrive:<fileId>`, with `webViewLink` straight from
  the API so the queue entry links to something openable rather than to a URL we
  guessed.

## Scope

**In:** Google Docs, Google Slides, uploaded `.md`/`.txt`, folders (recursive),
shared drives, `--since`.

**Out:** Sheets, PDFs and other binaries; comments and suggestions
(where the actual decision often is — same gap Notion has, same follow-up);
revision history; anything that writes to Drive. Read-only scope makes the last
one structural rather than a promise, which is the right way round.

## Where to start

- `src/connectors/folder.js` — the contract at its smallest, and the file a
  connector author actually copies.
- `src/connectors/notion.js` (#26) — the subtree walk, the cap-with-one-skip
  pattern, and the shape of a paced `call()` helper.
- `src/connectors/coda.js` (#27) — closest analogue for "list is cheap metadata,
  fetch is an export".
- `src/connectors/index.test.js` — the conformance suite runs against every
  registered connector automatically, including the rule that none may import
  the AI layer.
- Tests: fixtures captured from real API responses, mocked at `fetch`. The two
  places worth real fixtures are the folder recursion and the mimeType switch;
  everything else is one request and a string.

## Open questions

- **The seven-day cliff.** Personal-Gmail users on a Testing consent screen will
  re-authenticate weekly forever. A `teamctx auth google` helper would fix it in
  one command — and would break the rule that connectors are thin adapters,
  since it needs a listener and a place to write. Worth the exception, or is
  documentation enough?
- **`rclone` decided the opposite way.** It has the same problem — user's own
  client id, restricted scope, refresh token — and it *does* own the flow, with
  `rclone authorize` on a machine that has a browser and a pasted blob for
  headless boxes. That is the most-used Drive CLI there is, so "connectors stay
  thin" is a real position, not an obvious one. Worth deciding on purpose.
- **Three connectors now hand-roll paging and backoff** — and all three
  differently, because the limits genuinely differ (Slack recovers, Notion
  paces, Coda has per-verb buckets, Drive barely needs it). The contract
  proposal deferred a shared helper until there was something to design against.
  There are four now, and the divergence may itself be the answer.
- **Does exported markdown carry Drive artifacts?** Image placeholders,
  footnotes, comment anchors and suggestion markup all have to go somewhere.
  Worth measuring against a real document before assuming the export is clean.
- **Drive is the best place to design incremental re-import.** `modifiedTime` is
  a true filter and the id is stable, so "import what changed since last time"
  is tractable here in a way it is not for Slack or Notion. Run-scoped dedupe
  does not persist across runs today. Solve it here, or keep waiting?
- **`.docx` files sitting in Drive.** Drive can convert one to a Doc, but only by
  writing a copy — which `drive.readonly` forbids, correctly. Leave them as
  `unsupported type`, or is a local converter in scope for `folder` instead?
