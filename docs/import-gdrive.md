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

### 1. Create a project and enable the Drive API

1. [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate)
   — name it anything
2. Enable the Drive API:
   [console.cloud.google.com/apis/library/drive.googleapis.com](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   → **Enable**

Do this before the next step. The Google Auth Platform section does not appear
until at least one API is enabled on the project.

### 2. Configure Google Auth Platform

Google reorganised this area — what older guides call the "OAuth consent
screen" is now **Google Auth Platform**, split into Branding, Audience, Data
Access and Clients.

Go to [console.cloud.google.com/auth/branding](https://console.cloud.google.com/auth/branding)
and click **Get Started** if it says the platform is not configured yet.

| Step | What to enter |
| --- | --- |
| **App Information** | App name (anything) and your own email as support contact |
| **Audience** | See the warning below |
| **Contact Information** | Your email |
| **Finish** | Accept the policy, click **Create** |

> ⚠️ **Audience: choose "Internal" if you are on Google Workspace.**
>
> **External** leaves the app in "Testing", and Google then expires your refresh
> token after **seven days** — the connector works all week and fails the
> following Monday with `invalid_grant`. Publishing an External app to escape
> that needs verification *and* a security assessment, because `drive.readonly`
> is a restricted scope.
>
> On a personal Gmail account Internal is not offered. The connector still
> works; you just re-run `teamctx auth gdrive` weekly.

**If you chose External**, add yourself as a test user:
[console.cloud.google.com/auth/audience](https://console.cloud.google.com/auth/audience)
→ **Test users** → **Add users** → your own Gmail address. Skip this and Google
refuses the login later.

### 3. Add the scope, then create a client

**Data Access** ([console.cloud.google.com/auth/scopes](https://console.cloud.google.com/auth/scopes))
→ **Add or remove scopes** → filter for `drive.readonly`, tick
`https://www.googleapis.com/auth/drive.readonly` → **Update** → **Save**.

**Clients** ([console.cloud.google.com/auth/clients](https://console.cloud.google.com/auth/clients))
→ **Create client** → Application type **Desktop app** → **Create**.

Copy the **Client ID** and **Client secret** from the dialog.

You do not configure a redirect URI. A desktop client accepts loopback
redirects, and teamctx picks a free port each time it runs.

### 4. Log in

```bash
teamctx auth gdrive
```

It asks for the client ID and secret, then opens Google's consent screen. You
will see an **unverified app** warning — expected for a client you created
yourself — so click **Advanced** → **Go to (unsafe)**. Approve it in the browser and the command finishes on
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
