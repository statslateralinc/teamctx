# Importing from Google Drive

Turn documents you already keep in Drive into proposed contributions. Each
document becomes one entry in the manager's review queue — nothing enters shared
context without approval, exactly as with a typed `teamctx contribute`.

```bash
teamctx auth gdrive                                                       # once
teamctx import --from gdrive "https://drive.google.com/drive/folders/…" --dry-run
teamctx import --from gdrive "https://drive.google.com/drive/folders/…"
```

## Setting up

Drive is the most involved of the connectors to set up, and the reason is worth
knowing: **Google has no token you can copy.** Reading files you already own
requires the `drive.readonly` scope, which is only reachable through a full
OAuth flow against a client you create yourself. teamctx ships no Google client,
so nothing is shared between installs — your quota is yours, and no third party
sits between your team and your files.

### 1. Create a Google Cloud project

1. [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate)
   — name it anything
2. Enable the Drive API:
   [console.cloud.google.com/apis/library/drive.googleapis.com](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   → **Enable**

### 2. Configure the consent screen

**APIs & Services → OAuth consent screen.**

> ⚠️ **If you are on Google Workspace, choose user type "Internal".**
>
> Choosing **External** leaves the app in "Testing" status, and Google then
> expires your refresh token after **seven days** — so the connector works all
> week and fails the following Monday with `invalid_grant`. Publishing an
> External app to escape that requires verification *and* a security assessment,
> because `drive.readonly` is a restricted scope.
>
> On a personal Gmail account, Internal is not offered. You can still use the
> connector; you will just have to re-run `teamctx auth gdrive` weekly.

Add `https://www.googleapis.com/auth/drive.readonly` when asked for scopes, and
add yourself as a test user if it asks.

### 3. Create an OAuth client

**Credentials → Create credentials → OAuth client ID → Application type:
"Desktop app".** Copy the **Client ID** and **Client secret**.

Desktop app is the right type because the login uses a loopback redirect. You do
not need to configure a redirect URI yourself — teamctx picks a free port and
tells Google about it.

### 4. Log in

```bash
teamctx auth gdrive
```

It prints the steps above, asks for the client ID and secret, then opens
Google's consent screen. Approve it in the browser and the command finishes on
its own.

While it waits, teamctx runs a short-lived HTTP server on `127.0.0.1` — bound to
loopback only, so nothing off your machine can reach it, and closed as soon as
the browser comes back. Google
[removed the older paste-a-code flow in 2023](https://developers.google.com/identity/protocols/oauth2/resources/oob-migration),
so this is the only supported route for a desktop app.

The result is written to `.env.local`, which is gitignored:

```
GOOGLE_CLIENT_ID=…
GOOGLE_CLIENT_SECRET=…
GOOGLE_REFRESH_TOKEN=…
```

<details>
<summary>Just trying it out</summary>

`GOOGLE_ACCESS_TOKEN` works on its own for about an hour — the
[OAuth Playground](https://developers.google.com/oauthplayground) will issue one
against your own client (gear icon → "Use your own OAuth credentials"). Enough
for a dry run, not enough to keep.
</details>

## Importing

The selector is a Drive link or a file id:

```bash
teamctx import --from gdrive "https://drive.google.com/drive/folders/<id>"   # folder, recursively
teamctx import --from gdrive "https://docs.google.com/document/d/<id>/edit"  # one document
teamctx import --from gdrive "<fileId>"                                      # bare id
```

Folders are read recursively. A file that lives in two folders at once is
imported once.

**There is no "import everything" form**, and that is deliberate:
`drive.readonly` can see your entire Drive, so the folder or file has to be
named. (The Notion connector does allow it, because a Notion integration only
ever sees pages you connected by hand — the choice was already made there.)

**Always dry-run first:**

```bash
teamctx import --from gdrive "https://drive.google.com/drive/folders/<id>" --dry-run
```

### Other flags

| Flag | Effect |
| --- | --- |
| `--dry-run` | List what would be imported; change nothing |
| `--since <date>` | Only files modified since then, e.g. `--since 2026-08-01` |
| `--workstream <id>` | Queue against a specific workstream instead of your active one |

`--since` filters server-side on `modifiedTime`, but never filters *folders* — a
folder's own timestamp does not move when a document inside it changes, so
filtering them would hide exactly the new work you asked for.

## What gets imported

| File | What happens |
| --- | --- |
| Google Docs | Exported as markdown, then imported |
| Google Slides | Exported as text, then imported |
| `.md`, `.txt` uploads | Downloaded as they are |
| Folders | Read through, recursively |
| Google Sheets | **Skipped** — Drive exports spreadsheets only as CSV, and a spreadsheet is records rather than reasoning |
| PDFs, `.docx`, images, video, anything else | **Skipped** as an unsupported type |

Everything skipped is listed with a reason. That decision comes from the file
listing, so a 2GB video is never downloaded just to be rejected — and a dry run
over a large folder costs about one request.

## When something goes wrong

**`the refresh token is no longer valid`**, roughly a week after it worked
The seven-day expiry on a Testing-status consent screen. Switch the user type to
Internal if you can, then `teamctx auth gdrive` again.

**`Google returned no refresh token`**
This account has already authorized this client, and Google only issues a
refresh token on first consent. Revoke it at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) and
run the command again.

**`this OAuth client was not granted access to that file`**
The client is requesting `drive.file` rather than `drive.readonly`.
`drive.file` only ever sees files your app itself created, which is no use here.

**`no such file or folder`**
Check the link, and that the signed-in Google account can actually open it —
being able to see it in your browser as a different account is not the same
thing.

**The login hangs and times out**
The browser never reached the listener. Check that nothing is blocking
`127.0.0.1`, and that you approved the consent screen rather than closing the
tab.

**`Nothing to import.`**
The folder holds no importable documents. Re-run with `--dry-run` to see the
skip reasons.

## What happens next

Imported documents are distilled and queued — they are *not* applied. A manager
reviews them like any other contribution:

```bash
teamctx review list
teamctx review approve <id>
teamctx review reject <id> --reason "…"
```

Each contribution records where it came from, so `git log .teamctx/` shows
`Source: import:gdrive:<fileId>` and the audit trail points back at the original
document.
