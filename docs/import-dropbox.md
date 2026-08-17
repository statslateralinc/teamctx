# Importing from Dropbox

Turn documents you already keep in Dropbox into proposed contributions. Each
document becomes one entry in the manager's review queue — nothing is added to
shared context without approval, exactly as with a typed `teamctx contribute`.

```bash
teamctx auth dropbox                                    # once
teamctx import --from dropbox /Specs --dry-run          # see what would happen
teamctx import --from dropbox /Specs                    # distil and queue
```

## Setting up

### 1. Create a Dropbox app

teamctx ships no Dropbox app of its own, so nothing is shared between installs:
your quota is yours, and no third party sits between your team and your files.
That does mean a one-time setup.

1. Go to [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps)
   and choose **Create app**
2. Choose **Scoped access**
3. Choose **Full Dropbox** — ⚠️ **not** "App folder"
4. Name it anything (`teamctx` is fine)

> **The access type cannot be changed later.** An "App folder" app can only ever
> see `/Apps/<app name>`, however much is in the rest of your Dropbox — so every
> path you try will come back missing, with nothing to explain why. If you pick
> the wrong one you have to create a new app. teamctx detects this case and says
> so, but it is much easier to get right the first time.

### 2. Give it read permissions

On the app's **Permissions** tab, tick:

- `files.metadata.read` — see which files exist
- `files.content.read` — read them
- `sharing.read` — resolve shared links

Then click **Submit**. All three are read-only; teamctx never writes to Dropbox.

> **Do this before the next step.** Scopes added *after* you authorize do not
> take effect until you authorize again, and the symptom is every request
> failing with a permissions error.

### 3. Log in

```bash
teamctx auth dropbox
```

It walks you through the rest: paste the **App key** and **App secret** from the
app's Settings tab, open the URL it prints, click Allow, and paste back the code
Dropbox shows you.

There is no redirect URL, so nothing on your machine is listening on a port and
the code travels only where you paste it.

The result is written to `.env.local`, which is gitignored:

```
DROPBOX_APP_KEY=…
DROPBOX_APP_SECRET=…
DROPBOX_REFRESH_TOKEN=…
```

You do this once. The login does not expire. If you re-run `teamctx auth
dropbox` later, existing values are offered back as defaults — the secret shown
masked — so you can press enter to keep them.

<details>
<summary>Setting the variables by hand instead</summary>

`teamctx auth dropbox` is a convenience, not a requirement — `.env.local` is
read directly. For a quick trial without completing the code exchange, the app
console's **Generate access token** button gives a `DROPBOX_ACCESS_TOKEN` that
works on its own for about four hours.
</details>

## Importing

The selector is a Dropbox path, a file, or a shared link:

```bash
teamctx import --from dropbox /Specs                     # a folder and everything under it
teamctx import --from dropbox "/Specs/architecture.md"   # one file
teamctx import --from dropbox /                          # your whole Dropbox
teamctx import --from dropbox "https://www.dropbox.com/scl/fo/…"   # a shared link
```

Folders are read recursively, so `/Specs` includes `/Specs/archive/notes.md`.

There is no default — you have to name a path. `/` means your entire Dropbox and
is available, but only if you type it.

**Always dry-run first.** It reports exactly what would be imported and what was
skipped, without distilling anything:

```bash
teamctx import --from dropbox /Specs --dry-run
```

```
Skipped 1 file:
  dropbox:/Specs/team-photo.jpg — unsupported type (.jpg)

4 documents would be imported:

  dropbox:/Specs/architecture.md          architecture.md (1KB)
  dropbox:/Specs/archive/nested.md        nested.md (1KB)
  dropbox:/Specs/billing-decision.md      billing-decision.md (1KB)
  dropbox:/Specs/Café notes.md            Café notes.md (1KB)
```

### Other flags

| Flag | Effect |
| --- | --- |
| `--dry-run` | List what would be imported; change nothing |
| `--since <date>` | Only files modified since then, e.g. `--since 2026-08-01` |
| `--workstream <id>` | Queue against a specific workstream instead of your active one |

`--since` does not apply when you name a single file — asking for one document
by name and getting nothing because it is a fortnight old would be unhelpful.

## What gets imported

| File | What happens |
| --- | --- |
| `.md`, `.txt` | Imported |
| Dropbox Paper (`.paper`) | Exported as markdown, then imported |
| Folders | Read through, recursively |
| `.docx`, and Google Docs kept in Dropbox | **Skipped** — reading Word documents needs an extractor teamctx does not have yet |
| `.xlsx`, `.pptx`, PDFs, images, video, anything else | **Skipped** as an unsupported type |

Everything skipped is listed with a reason. That decision is made from the file
listing, so a 2GB video is never downloaded just to be rejected — and a dry run
over a large folder costs one request.

## When something goes wrong

**`no "/Specs". At the top level this app can see: …`**
The path does not exist *for this app*. The message lists what it can see, which
is usually enough to spot the problem — most often the folder is nested one
level deeper than expected.

**`no "/Specs", and this app can see nothing at all, anywhere.`**
The app was created with **App folder** access instead of **Full Dropbox**. The
access type is fixed at creation, so this needs a new app (see step 1), followed
by `teamctx auth dropbox` again.

**Every request fails with a permissions error.**
The scopes were added after you authorized. Re-run `teamctx auth dropbox`.

**`the refresh token is no longer valid`**
The app was deleted or access was revoked from
[dropbox.com/account/connected_apps](https://www.dropbox.com/account/connected_apps).
Run `teamctx auth dropbox` again.

**Paths behave strangely on Windows.**
Git Bash rewrites arguments that look like Unix paths — `/Specs` silently becomes
`C:/Program Files/Git/Specs`. Use **PowerShell** or **cmd** on Windows, or
prefix the command with `MSYS_NO_PATHCONV=1`.

**`Nothing to import.`**
The folder holds no importable documents. Run with `--dry-run` to see the skip
reasons for what is in there.

## What happens next

Imported documents are distilled and queued — they are *not* applied. A manager
reviews them like any other contribution:

```bash
teamctx review list
teamctx review approve <id>
teamctx review reject <id> --reason "…"
```

Each contribution records where it came from, so `git log .teamctx/` shows
`Source: import:dropbox:/Specs/architecture.md` and the audit trail points back
at the original document.
