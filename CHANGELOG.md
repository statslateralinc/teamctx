# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-21

### Added
- Open-source communication surface: roadmap, contributing guide, code of
  conduct, security policy, issue/PR templates, CI, and CODEOWNERS.
- `/ask` endpoint, minimal web UI, and `teamctx ask "<question>" [--role <slug>]`
  CLI command for asking questions grounded in team context.
- Manager approval queue: `teamctx contribute` now enqueues by default;
  `teamctx review list / approve / reject` CLI to gate contributions; rejected
  items archived under `.teamctx/rejected/` with an optional reason.
  `teamctx config manager <name>` sets an identity gate (unset = solo mode).
  New `--apply` flag on `contribute` preserves the old immediate-apply behaviour.
- Decisions as first-class objects: contributions now record a `source`
  (`cli` or `web`), and nodes backed by a `--decision` contribution render
  inline provenance markers (`*[decision — author, date, via source]*`) in
  `shared.md`, in every compiled role file, and in `teamctx ask` answers.
- `teamctx mcp` — an MCP server over stdio exposing `get_context`,
  `get_role_context`, `ask`, and `submit_contribution` for Claude Code, Claude
  Desktop, Cursor, and other MCP-aware clients. See [docs/mcp.md](docs/mcp.md).
- Context snapshots: `teamctx snapshot create / list / show / approve / reject /
  current` — freeze the whole shared context as a versioned checkpoint that the
  manager signs off on. Snapshots live under `.teamctx/snapshots/` with a
  `current.json` pointer to the last approved state. Git-style ID prefixes
  supported on all id-taking commands. Reuses the manager identity gate.
- Provider-agnostic AI layer — teamctx now runs on Anthropic (default),
  OpenAI, or Google Gemini via a shared `complete()` interface. Each
  provider reads its own API key from the environment.
- `teamctx config provider <anthropic|openai|gemini>` sets the active
  provider on an existing project; `teamctx init` also asks for it on new
  projects and shows that provider's model list.
- Per-provider curated model registry and lax model validation, so newly
  released models work without a package update.
- `teamctx workstream suggest | split | list | use` — AI clusters a project's
  Why/What/How tree into distinct sub-workstreams (e.g. product vs. tech);
  the manager accepts splits interactively and reassigns roles.
- `teamctx role assign <slug> --workstream <id>` and `--workstream <id>` on
  `contribute`, `ask`, `reflect`, and `role add`.
- Automatic one-time migration of `.teamctx/shared.json` →
  `.teamctx/workstreams/main.json` (and `context/shared.md` →
  `context/workstreams/main.md`) on first run against an existing project.

### Changed
- `teamctx contribute` no longer applies to shared context on submission by
  default — it enqueues under `.teamctx/queue/` and prints the review command.
  Pass `--apply` to keep the old behaviour.

## [0.1.0] - 2026-06-14

### Added
- Initial release: `teamctx` CLI and Vercel API for AI-native team context.
