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
# Prerequisites: Node 18+, git, Anthropic API key in .env.local

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
| `teamctx contribute "<text>"` | Add context — AI updates everything and pushes |
| `teamctx contribute "<text>" --decision` | Tag as a human decision (never pruned) |
| `teamctx contribute "<text>" --auto-approve` | Skip diff review |
| `teamctx role add` | Add a role interactively (AI-assisted) |
| `teamctx role add --suggest` | AI suggests roles from current context |
| `teamctx role list` | List all roles and their context URLs |
| `teamctx context <role>` | Print role MD to stdout |
| `teamctx pull` | Fetch and process web contributions |
| `teamctx reflect` | AI rewrites context for clarity (run weekly) |
| `teamctx status` | Project summary |

---

## Self-hosting (web layer)

Deploy to Vercel to give non-technical team members two routes:

- **`/context/<role>`** — downloads their role context file
- **`/contribute`** — a plain HTML form to submit updates

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

---

## File layout

```
.teamctx/
  config.json              # project name, roles, model, auto-push
  shared.json              # full Why/What/How tree (source of truth)
  context/
    shared.md              # human-readable, auto-regenerated
    roles/
      <slug>.md            # role-specific context file — this is what gets shared
  contributions.jsonl      # append-only audit log
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
