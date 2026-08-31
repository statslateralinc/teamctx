# Hosted MCP — deployment setup

What an operator has to do once to bring a hosted teamctx MCP online. After
this, end users just paste a URL into their AI client and click **Connect** —
no tokens, no PATs, no files.

---

## 1. Create a GitHub OAuth App

<https://github.com/settings/developers> → **OAuth Apps** → **New OAuth App**

| Field | Value |
| --- | --- |
| Application name | `teamctx` |
| Homepage URL | `https://<your-deployment>.vercel.app` |
| Authorization callback URL | `https://<your-deployment>.vercel.app/oauth/github/callback` |

Register, then **Generate a new client secret**. Keep the client ID and the
secret — the secret is shown once.

> Use an **OAuth App**, not a GitHub App. OAuth Apps issue the user-scoped
> `repo` token the MCP tools need, with no per-repo installation step.

teamctx asks for `repo read:user user:email`. There is nothing to configure —
an OAuth App grants whatever the flow requests — but `user:email` is worth
knowing about: it is what lets teamctx recognise you by the same email address
your clone and a Google sign-in use. Without it a GitHub session is only a
numeric id, and a manager gate pinned from a laptop would not recognise the
same person in a chat client.

> **If you deployed before this**, everyone signing in through the hosted
> connector needs to authorise once more, since a token already issued does not
> gain a scope. Until they do they are recognised by their numeric id, which
> still works — it is only the cross-surface matching that waits.

## 2. Create the Redis store

Use **Upstash directly** — <https://upstash.com>, sign in with GitHub →
**Create Database** → Redis → pick a region near your deployment.

From the database page, copy the two values under **REST API**.

Free tier at time of writing: 256 MB, 500k commands/month, no credit card.
teamctx stores a few hundred bytes per user, so this is ample.

> Vercel's **Storage → KV** tab is the same Upstash product behind a
> paid Vercel plan. Going to Upstash directly avoids that. The code accepts
> either naming (`UPSTASH_REDIS_REST_*` or `KV_REST_API_*`), so if you are
> already on a paid Vercel plan the Storage tab works too.

## Adding your team

Run `teamctx connect` to print the URL a member pastes into their client,
and send them [mcp-join.md](mcp-join.md) — the same steps written from
their side.

## 3. Set environment variables

Vercel project → **Settings** → **Environment Variables**. Apply to
**Production** (and Preview if you test there).

| Variable | Value |
| --- | --- |
| `GITHUB_OAUTH_CLIENT_ID` | from step 1 |
| `GITHUB_OAUTH_CLIENT_SECRET` | from step 1 |
| `UPSTASH_REDIS_REST_URL` | from step 2 |
| `UPSTASH_REDIS_REST_TOKEN` | from step 2 |
| `TEAMCTX_BASE_URL` | `https://<your-deployment>.vercel.app` — no trailing slash |
| `GOOGLE_OAUTH_CLIENT_ID` | optional — see below |
| `GOOGLE_OAUTH_CLIENT_SECRET` | optional — see below |

### Optional: let members join without a GitHub account

Skip this and teamctx behaves exactly as before: every member needs a GitHub
account. Set it and people invited by email can sign in with Google instead,
which is usually what a non-technical team member has.

1. [Google Cloud console](https://console.cloud.google.com/) → create or pick a
   project → **APIs & Services** → **Credentials**.
2. **Configure consent screen** if you have not: *External*, fill in the app
   name and support email. No scopes need adding — teamctx asks only for
   `openid email profile`, which are non-sensitive and need no verification.
3. **Create credentials** → **OAuth client ID** → *Web application*.
4. Under **Authorised redirect URIs** add exactly:
   `https://<your-deployment>.vercel.app/oauth/google/callback`
5. Copy the client ID and secret into the two variables above.

While the consent screen is in *Testing*, only accounts listed under **Test
users** can sign in. Publish it once you are past trying it out.

Two more things are needed before an email member can actually do anything, both
from `/settings` on your deployment: **share an AI key** with the project, and
**lend it GitHub access**. Without the first, model-backed tools have no key;
without the second, there is no credential to read the repo with.

**Do not set** `TEAMCTX_ALLOW_URL_TOKENS`. It re-enables reading credentials
from the query string, which is for local development only — the MCP spec
prohibits it and Claude ignores such tokens anyway.

`TEAMCTX_BASE_URL` must match the host users actually type. If it disagrees
with the connector URL, the `resource` field in the metadata won't match and
the client will refuse to start the flow.

## 4. Redeploy and verify

Redeploy so the new environment variables are picked up, then:

```bash
curl https://<your-deployment>.vercel.app/oauth/status
```

Expected:

```json
{ "oauthConfigured": true, "kvConfigured": true, "missing": [] }
```

Anything in `missing` names an environment variable that didn't arrive.

Then confirm the handshake starts correctly:

```bash
curl -i -X POST https://<your-deployment>.vercel.app/api/mcp/<owner>/<repo> \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Expected: `401`, plus a header of the form

```
WWW-Authenticate: Bearer realm="teamctx", resource_metadata="https://…/.well-known/oauth-protected-resource/api/mcp/<owner>/<repo>", scope="mcp:tools"
```

That 401 is not a failure — it is what tells the client where to authenticate.

---

## Using it (what an end user does)

1. Claude → **Settings → Connectors → Add custom connector**
2. URL: `https://<your-deployment>.vercel.app/api/mcp/<owner>/<repo>`
3. **Connect** → GitHub consent screen → approve
4. Tools appear. Reads and writes work immediately.

For the seven tools that call a model — `ask`, `contribute`,
`submit_contribution`, `reflect`, `role_add`, `suggest_roles`,
`suggest_workstream_splits` — the user visits
`https://<your-deployment>.vercel.app/settings` once, signs in with GitHub,
and saves an API key. The other 21 tools never need it.

### Don't have a repo yet?

A manager with no existing GitHub repo doesn't need to create one by hand —
`https://<your-deployment>.vercel.app/settings/new-project` does step 2 for
them. Sign in with GitHub, name the project, pick where it should live
(personal account or an org), and teamctx creates a private repo and runs
`init` on it in one step. The page then hands back the connector URL for step
1. It's linked from `/settings` as "Create a new project" for anyone already
signed in.

---

## How it fits together

```
Claude ──POST /api/mcp/<owner>/<repo>──────► 401 + WWW-Authenticate
       ──GET  /.well-known/oauth-protected-resource/…─► { authorization_servers }
       ──GET  /.well-known/oauth-authorization-server─► { endpoints, S256, DCR }
       ──POST /register───────────────────► client_id                    [KV]
       ──GET  /authorize──────────────────► redirect to GitHub           [KV: pending]
User   ──approves at GitHub────────────────►
GitHub ──GET /oauth/github/callback────────► swap for GitHub token       [KV: code]
                                             redirect back with our code
       ──POST /token (PKCE)───────────────► access + refresh             [KV: token]
       ──POST /api/mcp/… + Bearer─────────► KV lookup → user's GitHub
                                             token → their repo
```

What lives in KV, and for how long:

| Key | Contents | TTL |
| --- | --- | --- |
| `oauth:client:<id>` | DCR registration | none |
| `oauth:pending:<state>` | in-flight authorization | 10 min, one-shot |
| `oauth:code:<code>` | authorization code + GitHub token | 10 min, one-shot |
| `oauth:token:<token>` | GitHub token + profile | 1 hour |
| `oauth:refresh:<token>` | same, rotated on use | 90 days |
| `teamctx:aikey:<githubUserId>` | AI provider key | none |

The GitHub token never reaches the client, and never appears in a URL.

---

## Troubleshooting

**`/oauth/status` reports `oauthConfigured: false`** — an environment
variable is missing or the deploy predates it. Check `missing`, then redeploy.

**"Couldn't register with teamctx's sign-in service"** — the client couldn't
reach the metadata. Confirm `/.well-known/oauth-authorization-server` returns
JSON (not a 404 from a missing `vercel.json` rewrite), and that
`TEAMCTX_BASE_URL` matches the host in the connector URL.

**GitHub says "redirect_uri mismatch"** — the callback in the OAuth App must
be exactly `<TEAMCTX_BASE_URL>/oauth/github/callback`.

**Tools appear, but `ask`/`contribute` fail** — no AI key saved yet. Visit
`/settings`.

**Connection drops after about an hour** — expected; access tokens live one
hour and Claude refreshes on the 401. If refresh fails, check that `/token`
returns `error: "invalid_grant"` (not `invalid_request`) for an expired
refresh token — Claude branches on that code.

---

## Self-hosted alternative

If you'd rather not run OAuth at all, the same codebase works single-tenant:
deploy privately, put a GitHub token and AI key in environment variables, and
skip this document. One deployment then serves one repo with one set of
credentials. OAuth exists for the multi-tenant case — one URL, many users,
each with their own repo and their own keys.
