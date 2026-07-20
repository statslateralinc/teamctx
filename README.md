# teamctx

AI-native version control for team context. Every team member gets a continuously updated, role-specific context file for Claude, ChatGPT, or Gemini.

**No server. No seats. Bring your own API key.**

## Vision

As teams adopt AI tools, the context that makes those tools useful — *why* the
team is doing something, *what* it's building, *how* it works — lives scattered
across docs, chats, and people's heads, and goes stale immediately. teamctx
treats that shared context like source code: version-controlled, continuously
updated, and compiled into a role-specific file each person hands to Claude,
ChatGPT, or Gemini. No server, no seats, bring your own key.

---

## How it works

1. Manager runs `teamctx init` in any git repo
2. Contribute updates: `teamctx contribute "..."` — AI updates the shared Why/What/How context and regenerates every role's context file
3. Role files auto-push to GitHub — accessible at a stable URL
4. Non-technical team members go to `/contribute` to submit updates and `/context/<role>` to download their file

---

## Quickstart

```bash
# Prerequisites: Node 18+, git, and an Anthropic, OpenAI, or Gemini API key in .env.local

npx teamctx init

# Add context
teamctx contribute "We are building a Q3 product launch targeting enterprise customers"

# Add roles (AI-assisted)
teamctx role add
# → prints: Context URL: yourproject.vercel.app/context/cpo

# Check status
teamctx status

# Keep context evolving
teamctx contribute "We decided to use AWS (Why). API migration starts next sprint (What)." --decision
```

---

## Commands

| Command | Description |
|---|---|
| `teamctx init` | Set up `.teamctx/` in the current git repo |
| `teamctx contribute "<text>"` | Add context — AI proposes changes and enqueues for manager approval |
| `teamctx contribute "<text>" --decision` | Tag as a human decision (never pruned) |
| `teamctx contribute "<text>" --auto-approve` | Skip the y/n confirmation on the proposed diff |
| `teamctx contribute "<text>" --apply` | Apply immediately instead of enqueueing (solo mode) |
| `teamctx role add` | Add a role interactively (AI-assisted) |
| `teamctx role add --suggest` | AI suggests roles from current context |
| `teamctx role list` | List all roles and their context URLs |
| `teamctx context <role>` | Print role MD to stdout |
| `teamctx ask "<question>" [--role <slug>]` | Ask a question, answered from your team context |
| `teamctx pull` | Fetch and process web contributions |
| `teamctx reflect` | AI rewrites context for clarity (run weekly) |
| `teamctx review list` | List pending contributions awaiting manager approval |
| `teamctx review approve <id>` | Approve a pending contribution — applies to shared context |
| `teamctx review reject <id> [--reason "..."]` | Reject a pending contribution — archives with optional reason |
| `teamctx snapshot create [-m "..."]` | Freeze the current shared context as a pending snapshot |
| `teamctx snapshot list` | List all snapshots (marks the current-approved one) |
| `teamctx snapshot show <id>` | Print the snapshotted context to stdout (accepts a unique prefix) |
| `teamctx snapshot approve <id>` | Approve a pending snapshot — sets it as the current-approved state |
| `teamctx snapshot reject <id> [--reason "..."]` | Reject a pending snapshot |
| `teamctx snapshot current` | Show the current-approved snapshot |
| `teamctx config manager <name>` | Set the manager identity — only that identity may approve/reject |
| `teamctx config provider <anthropic\|openai\|gemini>` | Pick which LLM provider teamctx calls |
| `teamctx config model <id>` | Pick a model from the selected provider's list |
| `teamctx status` | Project summary |
| `teamctx mcp` | Start an MCP server over stdio so AI clients can call teamctx tools |

See [docs/providers.md](docs/providers.md) for the full provider guide.

---

## Use teamctx from your AI tool (MCP)

teamctx ships a [Model Context Protocol](https://modelcontextprotocol.io)
server so any MCP-aware AI client can read your team's shared context and
write new contributions as native tools — no more copy-pasting between a
terminal and your AI.

The client uses whatever chat model you already run there; teamctx uses its
own Anthropic API key for the four tools it exposes (`get_context`,
`get_role_context`, `ask`, `submit_contribution`).

### Prerequisites

- Node 18+ and `teamctx` on your PATH (`npm i -g teamctx`).
- A teamctx project on disk (run `teamctx init` in a git repo first).
- An Anthropic API key at [console.anthropic.com](https://console.anthropic.com)
  — either exported in your shell, in `.env.local` next to your project,
  or in the `env` block of your MCP config (shown below).

### Configuring your client

Every MCP client uses the same JSON block, only the file location differs.
teamctx resolves *which* project to use in this order:

1. `--project <path>` argument on the command
2. `TEAMCTX_PROJECT_DIR` environment variable
3. The working directory the client spawned the server from (unreliable on
   Windows — prefer #1 or #2)

**The paste-in block** (adjust the path to your project):

```json
{
  "mcpServers": {
    "teamctx": {
      "command": "teamctx",
      "args": ["mcp", "--project", "C:\\path\\to\\your\\teamctx\\project"],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

> On Windows, use double backslashes in JSON paths. On macOS/Linux, forward
> slashes are fine.

#### Claude Desktop

1. Open Claude Desktop.
2. Click the Claude icon in the system tray (bottom-right on Windows) →
   **Settings** → **Developer** → **Edit Config**. This creates and opens
   `claude_desktop_config.json` in the right location, regardless of
   which install you have.
3. Merge the paste-in block above into the file. If `mcpServers` isn't
   there yet, add it as a new top-level key alongside anything else in
   the file — don't replace the file.
4. Fully quit Claude Desktop (system tray → Quit) and reopen it.
5. Verify: click the tools/hammer icon near the chat input — you should
   see four `teamctx` tools listed. Then prompt "Use the teamctx
   get_context tool to summarize my project."

#### Claude Code

Replace the two placeholders with your project path (**forward slashes
even on Windows** — claude's JSON validator rejects backslashes) and
API key.

macOS / Linux:

```bash
claude mcp add-json teamctx --scope user \
  '{"command":"teamctx","args":["mcp","--project","/path/to/your/project"],"env":{"ANTHROPIC_API_KEY":"sk-ant-..."}}'
```

Windows PowerShell (double quotes need `\"`):

```powershell
claude mcp add-json teamctx --scope user `
  '{\"command\":\"teamctx\",\"args\":[\"mcp\",\"--project\",\"D:/path/to/your/project\"],\"env\":{\"ANTHROPIC_API_KEY\":\"sk-ant-...\"}}'
```

`--scope user` makes it available from every `claude` session regardless
of the launch directory. Verify with `claude mcp list` — you should see
`teamctx: ... ✔ Connected`.

#### Cursor / Cline / Antigravity / other MCP clients

Same JSON shape. Add the paste-in block under whichever setting the
client uses for MCP servers (usually a settings pane or a config file
labeled "MCP" or "External tools"). Restart the client.

### Multiple projects

Register one entry per project with a distinct server name so the AI
sees them as separate tool groups:

```json
{
  "mcpServers": {
    "teamctx-webapp":  { "command": "teamctx", "args": ["mcp", "--project", "C:\\work\\webapp"],  "env": { "ANTHROPIC_API_KEY": "sk-ant-..." } },
    "teamctx-mobile":  { "command": "teamctx", "args": ["mcp", "--project", "C:\\work\\mobile"],  "env": { "ANTHROPIC_API_KEY": "sk-ant-..." } }
  }
}
```

### Troubleshooting

- **"Not in a teamctx project"** when calling a tool → the `--project`
  path is wrong or `.teamctx/` doesn't exist there. Run `teamctx status`
  in that folder to confirm.
- **Tools don't appear in the client** → check the client's MCP log (in
  Claude Desktop: `%APPDATA%\Claude\logs\mcp-server-teamctx.log`). The
  most common causes are `teamctx` not on PATH and JSON syntax errors.
- **`submit_contribution` fails with an API error** → the Anthropic key
  isn't reaching the server process. Move it into the `env` block of
  the MCP config rather than relying on shell exports.

See [`docs/mcp.md`](docs/mcp.md) for the full reference.

---

## Self-hosting (web layer)

Deploy to Vercel to give non-technical team members two routes:

- **`/context/<role>`** — downloads their role context file
- **`/contribute`** — a plain HTML form to submit updates
- **`/ask`** — a plain HTML form to ask a question, answered from the shared (and optional role) context

Manager runs `teamctx pull` to process web submissions.

### Setup

**Prerequisites:** Node 18+, git, [Vercel CLI](https://vercel.com/docs/cli), Anthropic API key, GitHub account.

**1. Create a private GitHub repo**

Go to [github.com/new](https://github.com/new) and create a new **private** repository (e.g. `team-context`). Leave "Add a README" and "Add .gitignore" unchecked — the repo must be empty.

Then clone teamctx and point it at your new private repo:

```bash
git clone https://github.com/StatsLateral/teamctx team-context
cd team-context
git remote set-url origin https://github.com/YOUR_USERNAME/team-context
git push -u origin main
```

Replace `YOUR_USERNAME/team-context` with your actual GitHub username and repo name.

**2. Install and configure locally**

```bash
npm install
npm install -g .          # makes `teamctx` available in your shell
```

Add your Anthropic API key ([get one here](https://console.anthropic.com)) by running this in your terminal — replace the placeholder with your real key:

```bash
echo "ANTHROPIC_API_KEY=sk-ant-your-key-here" > .env.local
```

This file is gitignored and stays on your machine only.

**3. Initialize teamctx**

```bash
teamctx init
# Prompts: project name, your name, model, auto-push, Vercel URL (leave blank for now)
```

This creates `.teamctx/` and commits it to your private repo.

**4. Deploy to Vercel**

Connect your private repo to a new Vercel project:

```bash
vercel link      # follow prompts — create a new project linked to your private repo
```

Set the required env var:

```bash
vercel env add ANTHROPIC_API_KEY production
```

Deploy:

```bash
vercel --prod
```

Copy the production URL (e.g. `https://team-context-xyz.vercel.app`).

**5. Update your config with the deploy URL**

```bash
teamctx config deploy-url https://team-context-xyz.vercel.app
```

**6. Enable web contributions** (optional — only needed for `/contribute` and `teamctx pull`)

The contribution form writes directly to your private GitHub repo. Add two env vars to your Vercel project:

```bash
vercel env add GITHUB_TOKEN production   # fine-grained PAT, Contents: read+write on your private repo
vercel env add GITHUB_REPO production    # e.g. StatsLateral/myaccount
```

Then pull them to your local `.env.local` so `teamctx pull` can read them:

```bash
vercel env pull .env.local
```

### Keeping context current

Every `teamctx contribute` commits and pushes to your private repo. Vercel's git integration auto-deploys on push — role files at `/context/<role>` are always up to date within seconds.

### Security model

- **Source + data** (`.teamctx/`) live in your private GitHub repo — only visible to you
- **Role files** are served publicly at `/context/<role>` — share URLs directly with teammates
- `contributions.jsonl` and `config.json` are never served; they stay on the Vercel filesystem only
- The `/contribute` form is public (no login required) — manager reviews and approves all submissions via `teamctx pull` before anything is committed
- The `/ask` form is public too (no login required) — it only reads context to answer questions, it never writes to your repo

---

## File layout

```
.teamctx/
  config.json              # project name, roles, model, auto-push, manager
  shared.json              # full Why/What/How tree (source of truth)
  context/
    shared.md              # human-readable, auto-regenerated
    roles/
      <slug>.md            # role-specific context file — this is what gets shared
  contributions.jsonl      # append-only audit log
  queue/                   # pending contributions awaiting manager approval
  rejected/                # archived rejected contributions (with reason)
  snapshots/               # versioned context checkpoints; current.json points to the last approved
  pending/                 # raw web submissions inbox (processed by `teamctx pull`)
```

---

## License

MIT

## Project

- [Roadmap](ROADMAP.md) — where teamctx is going
- [Contributing](CONTRIBUTING.md) — how to propose changes (DCO sign-off required)
- [Changelog](CHANGELOG.md) — what changed, per release
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)

Licensed under the [MIT License](LICENSE).
