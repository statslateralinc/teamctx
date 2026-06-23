# Design: teamctx Open-Source Communication Surface

**Date:** 2026-06-22
**Status:** Approved (design), pending implementation plan
**Author:** Brainstormed with Claude Code

---

## Purpose

Establish the **communication surface** of the teamctx open-source project: the set
of documents and GitHub features that publish the project's **vision/roadmap**,
**contribution workflow**, and **release/governance** as one coherent, navigable
whole.

This design doubles as an OSS-management primer — each artifact below is explained
with *why it exists*, not just *what it contains*, because a goal of this work is to
learn how to manage an open-source product.

### Audience & guiding principle

Primary audience: **future external contributors.** The project is at `v0.1.0` with a
single maintainer and no contributors yet.

Guiding principle: **set the structure now, keep the machinery light.** No CLA bot, no
linter gate invented from nothing, two issue templates rather than ten. The surface
should make the project read as coherent and welcoming the day the first contributor
arrives, without imposing upkeep that a solo maintainer can't sustain (YAGNI).

### Out of scope

The **developer-extensible UI / stable public API contract** workstream (letting third
parties build their own frontends against teamctx endpoints) is real and valuable but
is *separate code work*. It is intentionally deferred to its own spec. It appears here
only as a roadmap item.

---

## Current state (facts verified 2026-06-22)

- License: **MIT** (Copyright 2026 StatsLateral). ✓ already present.
- Repo: `github.com/StatsLateral/teamctx`, **public**.
- Tests: `vitest` suite via `npm test`. ✓ exists.
- **No `.github/` directory** — no CI, no templates.
- **No `CHANGELOG.md`, no `VERSION` file.**
- **Not published on npm** — README's `npx teamctx` is currently aspirational.
- API endpoints exist (`api/contribute.js`, `api/context/[role].js`, untracked
  `api/ask.js`) but are not the subject of this spec.

---

## Architecture: the information surface

**Core idea: the README is the hub; every other doc is a spoke that links back.**
A newcomer should reach any answer in one hop.

```
README.md  <- the hub
|- Vision (a section in README -- the "why we exist")
|- -> ROADMAP.md ......... where we're going (Now / Next / Later)
|- -> CONTRIBUTING.md .... how to propose changes
|- -> CHANGELOG.md ....... what changed, per release
`- GitHub auto-surfaces:
   |- CODE_OF_CONDUCT.md ...... community norms (Contributor Covenant 2.1)
   |- SECURITY.md ............. how to report vulnerabilities privately
   |- .github/ISSUE_TEMPLATE/ . bug report + feature request pickers
   |- .github/pull_request_template.md . the PR checklist
   `- CODEOWNERS .............. auto-requests maintainer review on PRs
```

Plus two **invisible-but-essential** pieces that make "approve a contribution"
actually mean something:

- **CI** — `.github/workflows/test.yml` running the `vitest` suite on every PR.
- **Branch protection** on `main` requiring that CI to pass + maintainer review
  before merge. (A GitHub repo setting, not a file.)

Total: ~10 short files plus two GitHub settings, all interlinking.

### Why this shape (vs. alternatives)

- **Chosen — Standard GitHub "community health" layout.** GitHub auto-surfaces these
  conventionally-named files: a "Contributing" link appears on the issue/PR screens, a
  template picker appears when opening an issue, etc. Contributors instantly know where
  to look.
- **Rejected — Minimal (README does everything).** Folding everything into README
  sections loses GitHub's auto-detection (no template picker, no Contributing prompt) —
  exactly the affordances that help *external* contributors.
- **Rejected — Full docs site / wiki.** Premature for `v0.1`. YAGNI.

---

## Component 1: Vision & Roadmap

### Vision

Lives as a **section near the top of the README**, not a standalone `VISION.md` (for an
early project a separate vision file tends to go unread). It answers *why teamctx
exists*, above any feature.

Draft content:

> **Vision** — As teams adopt AI tools, the context that makes those tools useful —
> *why* the team is doing something, *what* it's building, *how* it works — lives
> scattered across docs, chats, and people's heads, and goes stale immediately. teamctx
> treats that shared context like source code: version-controlled, continuously
> updated, and compiled into a role-specific file each person hands to Claude, ChatGPT,
> or Gemini. No server, no seats, bring your own key.

Principle: the vision describes the **problem and the bet** ("context deserves version
control"), not the roadmap. Features change; the bet shouldn't.

### Roadmap

`ROADMAP.md` at repo root — **Now / Next / Later** — seeded with approved items. Opens
with a one-line note on what the buckets mean and an invitation to contributors.

```markdown
# Roadmap

This is a living document. "Now" is roughly committed; "Next" is likely;
"Later" is directional. Want something prioritized? Open a Discussion or thumbs-up an issue.

## Now
- Wire up the `ask` endpoint + a minimal web UI

## Next
- Stable, versioned public HTTP API contract (so anyone can build their own UI)
- Plugin system for role context-file generation

## Later
- Self-host guide
- Non-git storage backends
```

Two deliberate choices:

1. The disclaimer ("Now is *roughly* committed") protects the maintainer from being
   held to a roadmap — standard OSS practice.
2. The "want something prioritized?" line turns the roadmap into an **invitation to
   contribute**, serving the target audience.

---

## Component 2: Contribution workflow (intake & approval)

### `CONTRIBUTING.md`

The first doc every contributor reads. Sections:

- **Setup**: clone, `npm install`, set `ANTHROPIC_API_KEY` in `.env.local` (reference
  `.env.example`).
- **Run the tests**: `npm test` (vitest). State explicitly that **green tests are
  required to merge**.
- **Workflow**: fork -> branch -> PR against `main`; keep PRs focused; describe the *why*.
- **Code style**: "match the surrounding code." No linter exists yet — do **not** invent
  one now; note it as a possible future addition rather than a blocking gate.
- **DCO**: contributions accepted under a `Signed-off-by` line (`git commit -s`).
  Lightweight, no CLA.
- **Governance** note (see Component 3).

### Issue templates — `.github/ISSUE_TEMPLATE/`

Two YAML form templates (structured fields) + a config:

- `bug_report.yml` — what happened / expected / repro steps / version.
- `feature_request.yml` — problem / proposed solution / alternatives.
- `config.yml` — adds a "Ask in Discussions" contact link; disables blank issues.

### `pull_request_template.md`

Short checklist auto-filled into every PR: *what & why*, *tests pass*, *linked issue*,
*signed off (DCO)*.

### `CODE_OF_CONDUCT.md`

Contributor Covenant 2.1, verbatim, with the maintainer contact email. Standard,
expected, signals a safe project.

### `SECURITY.md`

Short: report vulnerabilities **privately** to the maintainer email (not public
issues); expected response time. Relevant because teamctx handles API keys.

### The approval mechanism (three gates, two automated)

"Approving a contribution" = three gates:

1. **CI gate** — `.github/workflows/test.yml` runs `npm test` on every PR via GitHub
   Actions (Node 18 + 20 matrix). Red = cannot merge.
2. **Maintainer review** — `CODEOWNERS` (`* @<maintainer-handle>`) auto-requests review
   on every PR.
3. **Branch protection** on `main` — require CI passing + 1 approving review before
   merge; no direct pushes. *GitHub setting, not a file.*

A PR can land only when tests are green **and** the maintainer approves.

#### Branch protection — exact settings

In GitHub repo Settings -> Branches -> add rule for `main`:

- [x] Require a pull request before merging -> Require approvals: **1**
- [x] Require status checks to pass before merging -> select the `test` workflow check
- [x] Require branches to be up to date before merging
- [x] Do not allow bypassing the above settings (optional; maintainer may keep bypass)

### Why DCO over CLA, and two templates

- **DCO is best practice at this stage.** A CLA exists mainly so a company can later
  relicense or legally defend contributions; it adds signup friction that deters casual
  contributors. DCO — the `Signed-off-by` certification — is what the Linux kernel,
  GitLab, and most CNCF projects use. For a solo MIT project, CLA is unneeded overhead.
- **Two templates is the right baseline.** Bug + feature covers ~95% of issues. Add
  more only when volume proves the need; the `config.yml` Discussions link absorbs
  question-shaped issues.

---

## Component 3: Release & governance

### Release artifacts

- **`CHANGELOG.md`** in [Keep a Changelog](https://keepachangelog.com) format, with an
  `## [Unreleased]` section at the top. **Every PR adds a line here** — the changelog is
  built continuously, not reconstructed at release time.
- **SemVer** via `package.json` `version` (currently `0.1.0`). Rule: `0.x` = anything
  can change; bump to `1.0.0` when the public API/CLI is stable. **No separate `VERSION`
  file** — `package.json` is the single source of truth.
- **Release process** (documented in CONTRIBUTING under "Maintainers"): move
  `[Unreleased]` -> `[x.y.z]` + date, `npm version`, tag, push, `npm publish`.
- **First-publish checklist** (one-time, because teamctx isn't on npm yet): confirm the
  `teamctx` package name is available/owned, `npm login`, `npm publish --access
  public`. Without this, the README's `npx teamctx` cannot work.

### Governance

A short `## Governance` note in `CONTRIBUTING.md`, honest for a solo project: the
maintainer is the decision-maker today; decisions happen in issues/PRs in the open; the
model can evolve as the project grows. No invented committees.

---

## End-to-end walkthrough (proves the pieces interlock)

```
1. Newcomer reads README -> Vision -> ROADMAP (sees "Plugin system" in Next)
2. Opens an issue via feature_request.yml template
3. Reads CONTRIBUTING.md -> forks, branches, codes, `npm test` green
4. Opens PR -> pull_request_template checklist auto-loads
       -> CI runs vitest          (gate 1)
       -> CODEOWNERS requests maintainer (gate 2)
       -> contributor adds a CHANGELOG line + `git commit -s` (DCO)
5. Maintainer reviews; branch protection blocks merge until CI green + approval (gate 3)
6. Merge -> line sits in CHANGELOG [Unreleased]
7. At release: [Unreleased] -> [0.2.0], npm version, tag, npm publish
```

Every artifact from this design appears exactly once in that path — no gaps, no
orphans.

---

## Deliverables checklist

Files to create:

- [ ] `README.md` — add **Vision** section + a navigation block linking the docs below
- [ ] `ROADMAP.md`
- [ ] `CONTRIBUTING.md` (incl. DCO, release process, governance note)
- [ ] `CHANGELOG.md` (Keep a Changelog, `[Unreleased]` seeded)
- [ ] `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1)
- [ ] `SECURITY.md`
- [ ] `.github/ISSUE_TEMPLATE/bug_report.yml`
- [ ] `.github/ISSUE_TEMPLATE/feature_request.yml`
- [ ] `.github/ISSUE_TEMPLATE/config.yml`
- [ ] `.github/pull_request_template.md`
- [ ] `CODEOWNERS` (root or `.github/`)
- [ ] `.github/workflows/test.yml` (vitest, Node 18 + 20)

GitHub settings to configure (manual, documented for the maintainer):

- [ ] Branch protection rule on `main` (settings listed above)
- [ ] Enable GitHub Discussions
- [ ] (Later, one-time) npm first publish

---

## Open decisions deferred to implementation

- Exact `<maintainer-handle>` for CODEOWNERS and contact email for CoC/SECURITY
  (use the maintainer's GitHub handle and `shikhin@statslateral.com` unless changed).
- Whether to enable GitHub Discussions now or at first external interest.
