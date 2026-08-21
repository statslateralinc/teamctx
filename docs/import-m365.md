# Importing from Microsoft 365

Turn documents you already keep in OneDrive or a SharePoint library into
proposed contributions. Each document becomes one entry in the manager's review
queue — nothing enters shared context without approval.

```bash
teamctx auth m365                                                     # once
teamctx import --from m365 "https://contoso.sharepoint.com/sites/Eng/Shared Documents/Specs" --dry-run
teamctx import --from m365 /Documents/Specs                           # OneDrive
```

Word documents are supported. Microsoft Graph offers no conversion to text for
*any* file type, so teamctx unpacks `.docx` files itself.

## Setting up

### 1. Register an app

1. [entra.microsoft.com](https://entra.microsoft.com) → **Applications** →
   **App registrations** → **New registration**
2. **Supported account types:** choose **"Accounts in any organizational
   directory and personal Microsoft accounts"**. Anything narrower will lock out
   half the people who might use it.
3. **Redirect URI:** platform **"Mobile and desktop applications"**, value
   exactly `http://localhost` — no port, and **not** `http://127.0.0.1`.
   Entra ignores the port only for `localhost`, so a fresh port each login
   still matches. For any other host the port must match exactly, and the
   portal will not register the loopback IP without a manifest edit.
4. Copy the **Application (client) ID** from the Overview page.

You do not need a client secret. A desktop app is a *public client*, and leaving
the secret blank is the recommended shape. Only add one if your tenant requires
it.

### 2. Log in

```bash
teamctx auth m365
```

It asks whether the account is **work** or **personal**, and that answer matters
more than it looks:

| | Work or school | Personal |
| --- | --- | --- |
| Sign-in endpoint | `/organizations` | `/consumers` |
| Permissions requested | `Files.Read.All`, `Sites.Read.All` | `Files.Read.All` |
| OneDrive | ✅ | ✅ |
| SharePoint sites by URL | ✅ | ❌ not available |

A personal Microsoft account **cannot** hold `Sites.Read.All`. Asking for it
does not grant what it can — it fails the whole sign-in. So choosing the wrong
option here means the login simply will not complete.

Approve the consent screen in the browser and the command finishes on its own.
While it waits, teamctx runs a short-lived server on `127.0.0.1`, bound to
loopback so nothing off your machine can reach it.

The result lands in `.env.local`, which is gitignored:

```
M365_CLIENT_ID=…
M365_TENANT=organizations
M365_REFRESH_TOKEN=…
```

`M365_TENANT` is saved deliberately: a token issued by `/consumers` cannot be
refreshed against `/organizations`.

## Importing

```bash
# SharePoint document library
teamctx import --from m365 "https://contoso.sharepoint.com/sites/Eng/Shared Documents/Specs"

# a Teams site
teamctx import --from m365 "https://contoso.sharepoint.com/teams/Design/Docs"

# OneDrive, by path
teamctx import --from m365 /Documents/Specs
teamctx import --from m365 /                    # your whole OneDrive

# a sharing link
teamctx import --from m365 "https://1drv.ms/w/s!AbCdEf"
```

**Quote SharePoint URLs.** They contain spaces and `?`, which both PowerShell
and bash will mangle unquoted.

There is no default selector — a folder has to be named. `/` means your entire
OneDrive and is available, but only if you type it.

**Always dry-run first:**

```bash
teamctx import --from m365 /Documents/Specs --dry-run
```

### Other flags

| Flag | Effect |
| --- | --- |
| `--dry-run` | List what would be imported; change nothing |
| `--since <date>` | Only files modified since then |
| `--workstream <id>` | Queue against a specific workstream |

## What gets imported

| File | What happens |
| --- | --- |
| `.docx` | Text extracted locally, then imported |
| `.md`, `.txt` | Downloaded as they are |
| Folders | Read through, recursively |
| `.xlsx`, `.csv` | **Skipped** — a spreadsheet is records, not reasoning |
| `.pptx` | **Skipped** — slide text needs a reader that is not built yet |
| `.doc` (pre-2007) | **Skipped** — re-save it as `.docx` |
| PDFs, images, video, anything else | **Skipped** as an unsupported type |

Everything skipped is listed with a reason, decided from the file listing — so a
2GB video is never downloaded just to be rejected.

### What is *not* extracted from a Word document

Deliberately, and worth knowing:

- **Text deleted with track changes still on.** It remains in the file, and a
  naive reader would resurrect a sentence someone removed on purpose. Inserted
  text *is* kept — that is real content the author added.
- **Field codes** (`PAGEREF`, `HYPERLINK`) — instructions, not prose.
- **Comments, headers, footers, and images.**

If a document's meaning depends on unaccepted revisions, accept or reject them
in Word before importing.

## When something goes wrong

**`this account cannot grant one of the requested permissions`**
A personal account was asked for `Sites.Read.All`. Run `teamctx auth m365` again
and choose the personal option.

**`the refresh token is no longer valid`**
Access was revoked, or the app registration changed. Run `teamctx auth m365`
again.

**`no such file, folder or site`**
Check the URL, and that the signed-in account can open it in a browser. For
SharePoint, confirm the site path — `/sites/Eng` and `/teams/Eng` are different
places.

**SharePoint URLs do not work at all on a personal account**
Expected. `GET /sites/…` is not available to personal Microsoft accounts. Use
OneDrive paths or a sharing link instead.

**`a path may not contain ":"`**
Graph uses `:` structurally in paths. Import the parent folder instead.

**`The provided value for the input parameter 'redirect_uri' is not valid`**
The app registration has no `http://localhost` redirect URI, or it was added
under the wrong platform. In Entra: app → **Authentication** → **Add a
platform** → **Mobile and desktop applications** → tick or enter
`http://localhost`.

**`You can't sign in here with a personal account`**
The registration does not accept personal Microsoft accounts. In Entra: app →
**Authentication** → **Supported account types** → *"Accounts in any
organizational directory and personal Microsoft accounts"*. This can be changed
after registration.

**The login hangs and times out**
The browser never reached the listener. Check that the app registration has a
redirect URI under **"Mobile and desktop applications"**, and that you approved
the consent screen rather than closing the tab.

## What happens next

Imported documents are distilled and queued — they are *not* applied:

```bash
teamctx review list
teamctx review approve <id>
```

Each contribution records where it came from, so `git log .teamctx/` shows
`Source: import:m365:<id>`.
