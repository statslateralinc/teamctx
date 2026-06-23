# OSS Communication Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build teamctx's open-source communication surface — the interlinked docs and GitHub features that publish vision/roadmap, the contribution workflow, and release/governance for future external contributors.

**Architecture:** Standard GitHub "community-health" layout. The README is the hub; ROADMAP/CONTRIBUTING/CHANGELOG/CoC/SECURITY are spokes that interlink. Two automated gates (CI + branch protection) plus CODEOWNERS make "approving a contribution" mean tests-green + maintainer review. Most deliverables are markdown/YAML files; one is a GitHub Actions workflow; the final step is manual GitHub repo settings.

**Tech Stack:** Markdown, GitHub Issue Forms (YAML), GitHub Actions, Node.js (`npm`/`vitest`), Contributor Covenant 2.1, Keep a Changelog, Developer Certificate of Origin (DCO).

## Global Constraints

- License is **MIT** (already present) — do not change it.
- Audience is **future external contributors**; keep machinery light (no CLA, no linter gate, exactly two issue templates).
- Maintainer contact email: **`shikhin@statslateral.com`** (used in CoC + SECURITY).
- Maintainer GitHub handle: substitute the real handle wherever `@MAINTAINER_HANDLE` appears. Find it with `gh api user --jq .login` (or use the personal handle that owns the StatsLateral org). Do **not** leave the literal `@MAINTAINER_HANDLE` in any committed file.
- SemVer single source of truth is `package.json` `version` (`0.1.0` now). No separate `VERSION` file.
- Node version floor: project `engines.node` is `>=18`; CI matrix tests Node 18 and 20.
- Test command is `npm test` (runs `vitest run`).
- All work happens on the current branch `docs/oss-communication-surface`. Commit after each task. Do not push or open a PR until the user asks.

---

## File Structure

Files created by this plan (all repo-root unless noted):

| File | Responsibility |
|------|----------------|
| `ROADMAP.md` | Public Now/Next/Later direction |
| `CONTRIBUTING.md` | Setup, tests, PR workflow, DCO, release process, governance |
| `CODE_OF_CONDUCT.md` | Community norms (Contributor Covenant 2.1) |
| `SECURITY.md` | Private vulnerability reporting |
| `CHANGELOG.md` | Per-release change log (Keep a Changelog) |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | Structured bug intake |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | Structured feature intake |
| `.github/ISSUE_TEMPLATE/config.yml` | Disable blank issues; Discussions link |
| `.github/pull_request_template.md` | PR checklist |
| `.github/workflows/test.yml` | CI: run vitest on Node 18 + 20 |
| `CODEOWNERS` | Auto-request maintainer review |
| `README.md` (modify) | Add Vision section + navigation block |

Task ordering creates all link targets **before** the README navigation block, so every link resolves by the time README is edited.

---

### Task 1: ROADMAP.md

**Files:**
- Create: `ROADMAP.md`

**Interfaces:**
- Produces: a repo-root `ROADMAP.md` that the README nav block (Task 11) links to.

- [ ] **Step 1: Create `ROADMAP.md`**

```markdown
# Roadmap

This is a living document. "Now" is roughly committed; "Next" is likely; "Later"
is directional. Want something prioritized? Open a [Discussion][d] or 👍 an issue.

[d]: https://github.com/StatsLateral/teamctx/discussions

## Now
- Wire up the `ask` endpoint + a minimal web UI

## Next
- Stable, versioned public HTTP API contract (so anyone can build their own UI)
- Plugin system for role context-file generation

## Later
- Self-host guide
- Non-git storage backends
```

- [ ] **Step 2: Verify the file renders and links are well-formed**

Run: `test -f ROADMAP.md && grep -c '^## ' ROADMAP.md`
Expected: prints `3` (three section headers: Now / Next / Later).

- [ ] **Step 3: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: add public roadmap (Now/Next/Later)"
```

---

### Task 2: CONTRIBUTING.md

**Files:**
- Create: `CONTRIBUTING.md`

**Interfaces:**
- Produces: repo-root `CONTRIBUTING.md`. README nav (Task 11) and the PR template (Task 8) reference it. Contains the DCO statement, release process, and governance note.

- [ ] **Step 1: Create `CONTRIBUTING.md`**

````markdown
# Contributing to teamctx

Thanks for your interest in improving teamctx! This guide covers everything you
need to propose a change.

## Setup

```bash
git clone https://github.com/StatsLateral/teamctx.git
cd teamctx
npm install
cp .env.example .env.local   # then add your ANTHROPIC_API_KEY
```

## Run the tests

```bash
npm test
```

teamctx uses [Vitest](https://vitest.dev). **Green tests are required to merge** —
CI runs the suite on every pull request.

## Workflow

1. Fork the repo and create a topic branch off `main`.
2. Make your change. Keep pull requests focused — one logical change per PR.
3. Add a line to `CHANGELOG.md` under `## [Unreleased]` describing your change.
4. Run `npm test` and make sure it passes.
5. Open a PR against `main`. Describe **what** changed and **why**.

## Code style

Match the surrounding code — naming, structure, and comment density. There is no
automated linter yet; readability and consistency with neighboring files is the
bar.

## Sign your commits (DCO)

teamctx uses the [Developer Certificate of Origin](https://developercertificate.org/).
By signing off, you certify you wrote the patch (or have the right to submit it)
under the project's MIT license. Add a sign-off line to each commit:

```bash
git commit -s -m "your message"
```

This appends `Signed-off-by: Your Name <your@email>` to the commit message. No
CLA is required.

## How contributions are approved

A pull request can merge only when **both** are true:

1. **CI is green** — the Vitest suite passes on Node 18 and 20.
2. **A maintainer approves** — you'll be auto-requested via `CODEOWNERS`.

Branch protection on `main` enforces this; there are no direct pushes to `main`.

## Governance

teamctx is currently maintained by a single maintainer (StatsLateral), who is the
final decision-maker. Decisions happen in the open, in issues and pull requests.
As the project grows, this model may evolve — proposals to change it are welcome
in Discussions.

## Releasing (maintainers)

teamctx follows [Semantic Versioning](https://semver.org). While on `0.x`,
anything may change; the bump to `1.0.0` signals a stable public API/CLI.

To cut a release:

1. In `CHANGELOG.md`, move entries from `## [Unreleased]` into a new
   `## [x.y.z] - YYYY-MM-DD` section.
2. `npm version <patch|minor|major>` (updates `package.json` and creates a git tag).
3. `git push && git push --tags`.
4. `npm publish --access public`.

**First publish (one-time):** the `teamctx` package is not yet on npm. Before the
first `npm publish`, confirm the name is available/owned, run `npm login`, then
`npm publish --access public`. Until this is done, the README's `npx teamctx` will
not work.
````

- [ ] **Step 2: Verify required sections exist**

Run: `for h in "## Setup" "## Sign your commits (DCO)" "## How contributions are approved" "## Governance" "## Releasing (maintainers)"; do grep -qF "$h" CONTRIBUTING.md && echo "ok: $h" || echo "MISSING: $h"; done`
Expected: five `ok:` lines, no `MISSING`.

- [ ] **Step 3: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs: add CONTRIBUTING guide (setup, DCO, release, governance)"
```

---

### Task 3: CODE_OF_CONDUCT.md

**Files:**
- Create: `CODE_OF_CONDUCT.md`

**Interfaces:**
- Produces: repo-root `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) with the maintainer email filled in. CONTRIBUTING and README reference it implicitly via GitHub auto-surfacing.

- [ ] **Step 1: Download the canonical Contributor Covenant 2.1**

Use the official text rather than retyping it (accuracy matters for a legal/community doc).

Run:
```bash
curl -fsSL https://raw.githubusercontent.com/EthicalSource/contributor_covenant/release/content/version/2/1/code_of_conduct.md -o CODE_OF_CONDUCT.md
```

- [ ] **Step 2: Insert the maintainer contact email**

The template contains the placeholder token `[INSERT CONTACT METHOD]`. Replace it:

```bash
sed -i '' 's/\[INSERT CONTACT METHOD\]/shikhin@statslateral.com/g' CODE_OF_CONDUCT.md
```

(On Linux, use `sed -i` without the empty-string argument.)

- [ ] **Step 3: Verify the download succeeded and the placeholder is gone**

Run: `grep -q "Contributor Covenant" CODE_OF_CONDUCT.md && ! grep -q "INSERT CONTACT METHOD" CODE_OF_CONDUCT.md && echo OK`
Expected: prints `OK`.

- [ ] **Step 4: Commit**

```bash
git add CODE_OF_CONDUCT.md
git commit -m "docs: add Contributor Covenant 2.1 code of conduct"
```

---

### Task 4: SECURITY.md

**Files:**
- Create: `SECURITY.md`

**Interfaces:**
- Produces: repo-root `SECURITY.md`. GitHub auto-surfaces it as the "Security policy."

- [ ] **Step 1: Create `SECURITY.md`**

```markdown
# Security Policy

## Supported versions

teamctx is pre-1.0. Security fixes are applied to the latest release only.

## Reporting a vulnerability

**Please do not report security issues in public GitHub issues.**

teamctx handles API keys (e.g. `ANTHROPIC_API_KEY`), so we take disclosure
seriously. Email **shikhin@statslateral.com** with:

- a description of the issue and its impact, and
- steps to reproduce, if available.

You can expect an acknowledgement within **3 business days** and a status update
within **7 days**. We'll coordinate a fix and disclosure timeline with you.
```

- [ ] **Step 2: Verify**

Run: `grep -q "shikhin@statslateral.com" SECURITY.md && echo OK`
Expected: prints `OK`.

- [ ] **Step 3: Commit**

```bash
git add SECURITY.md
git commit -m "docs: add security policy with private reporting"
```

---

### Task 5: CHANGELOG.md

**Files:**
- Create: `CHANGELOG.md`

**Interfaces:**
- Produces: repo-root `CHANGELOG.md` with an `## [Unreleased]` section. CONTRIBUTING (Task 2) instructs contributors to add lines here; the release process promotes `[Unreleased]` to a versioned section.

- [ ] **Step 1: Create `CHANGELOG.md`**

```markdown
# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Open-source communication surface: roadmap, contributing guide, code of
  conduct, security policy, issue/PR templates, CI, and CODEOWNERS.

## [0.1.0] - 2026-06-14

### Added
- Initial release: `teamctx` CLI and Vercel API for AI-native team context.
```

> Note: confirm the `0.1.0` date against `git log` for the first tagged/initial commit; adjust if needed.

- [ ] **Step 2: Verify the Unreleased section exists**

Run: `grep -q '## \[Unreleased\]' CHANGELOG.md && echo OK`
Expected: prints `OK`.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add changelog (Keep a Changelog format)"
```

---

### Task 6: Issue templates (bug + feature + config)

**Files:**
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Create: `.github/ISSUE_TEMPLATE/feature_request.yml`
- Create: `.github/ISSUE_TEMPLATE/config.yml`

**Interfaces:**
- Produces: three GitHub Issue Form files. GitHub renders the template picker from them. `config.yml` disables blank issues and links to Discussions.

- [ ] **Step 1: Create `.github/ISSUE_TEMPLATE/bug_report.yml`**

```yaml
name: Bug report
description: Report something that isn't working as expected
labels: ["bug"]
body:
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: A clear description of the bug.
    validations:
      required: true
  - type: textarea
    id: expected
    attributes:
      label: What did you expect to happen?
    validations:
      required: true
  - type: textarea
    id: repro
    attributes:
      label: Steps to reproduce
      description: Commands you ran and what you observed.
      placeholder: |
        1. teamctx init
        2. teamctx contribute "..."
        3. ...
    validations:
      required: true
  - type: input
    id: version
    attributes:
      label: teamctx version
      description: Output of `teamctx --version` (or the npm/commit version).
    validations:
      required: true
```

- [ ] **Step 2: Create `.github/ISSUE_TEMPLATE/feature_request.yml`**

```yaml
name: Feature request
description: Suggest an idea or improvement
labels: ["enhancement"]
body:
  - type: textarea
    id: problem
    attributes:
      label: What problem does this solve?
      description: Describe the need, not just the solution.
    validations:
      required: true
  - type: textarea
    id: solution
    attributes:
      label: Proposed solution
    validations:
      required: true
  - type: textarea
    id: alternatives
    attributes:
      label: Alternatives considered
    validations:
      required: false
```

- [ ] **Step 3: Create `.github/ISSUE_TEMPLATE/config.yml`**

```yaml
blank_issues_enabled: false
contact_links:
  - name: 💬 Questions & ideas
    url: https://github.com/StatsLateral/teamctx/discussions
    about: Ask questions or float ideas in Discussions instead of opening an issue.
```

- [ ] **Step 4: Validate all three YAML files parse**

Run:
```bash
for f in .github/ISSUE_TEMPLATE/bug_report.yml .github/ISSUE_TEMPLATE/feature_request.yml .github/ISSUE_TEMPLATE/config.yml; do ruby -ryaml -e 'YAML.load_file(ARGV[0])' "$f" && echo "ok: $f"; done
```
Expected: three `ok:` lines, no Ruby parse errors. (`ruby` ships with macOS; if unavailable, use `python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" <file>`.)

- [ ] **Step 5: Commit**

```bash
git add .github/ISSUE_TEMPLATE
git commit -m "feat: add bug + feature issue forms and Discussions link"
```

---

### Task 7: Pull request template

**Files:**
- Create: `.github/pull_request_template.md`

**Interfaces:**
- Produces: the body auto-loaded into every new PR. References CONTRIBUTING's DCO and CHANGELOG conventions.

- [ ] **Step 1: Create `.github/pull_request_template.md`**

```markdown
## What & why

<!-- What does this change do, and why is it needed? -->

## Linked issue

<!-- e.g. Closes #123 -->

## Checklist

- [ ] Tests pass locally (`npm test`)
- [ ] Added a `CHANGELOG.md` entry under `## [Unreleased]`
- [ ] Commits are signed off (`git commit -s`) per the [DCO](../CONTRIBUTING.md#sign-your-commits-dco)
- [ ] PR is focused on a single logical change
```

- [ ] **Step 2: Verify**

Run: `test -f .github/pull_request_template.md && grep -q 'npm test' .github/pull_request_template.md && echo OK`
Expected: prints `OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/pull_request_template.md
git commit -m "feat: add pull request template with DCO + changelog checklist"
```

---

### Task 8: CI workflow

**Files:**
- Create: `.github/workflows/test.yml`

**Interfaces:**
- Produces: a GitHub Actions workflow named `test` that runs `npm test` on Node 18 and 20. The status check `test` is what branch protection (Task 10) requires.

- [ ] **Step 1: Create `.github/workflows/test.yml`**

```yaml
name: test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18, 20]
    steps:
      - uses: actions/checkout@v4
      - name: Use Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm
      - run: npm ci
      - run: npm test
        env:
          # Tests must not require a live key; this dummy prevents import-time
          # crashes in code that reads the variable.
          ANTHROPIC_API_KEY: test-key-not-used
```

- [ ] **Step 2: Validate the workflow YAML parses**

Run: `ruby -ryaml -e 'YAML.load_file(ARGV[0])' .github/workflows/test.yml && echo OK`
Expected: prints `OK`.

- [ ] **Step 3: Confirm the test suite passes locally on this machine first**

Run: `npm test`
Expected: Vitest reports all test files passing (matches the suite in `src/*.test.js`). If any test genuinely needs a real API key, that is a finding to surface — CI tests should be mockable; do not paper over it with a real secret.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: run vitest on Node 18 and 20 for pushes and PRs"
```

> The workflow only truly executes once the branch is pushed to GitHub. After pushing (when the user is ready), verify the `test` check appears green on the PR before relying on it in branch protection.

---

### Task 9: CODEOWNERS

**Files:**
- Create: `CODEOWNERS`

**Interfaces:**
- Produces: a CODEOWNERS file that auto-requests the maintainer on every PR. Branch protection's "require review from Code Owners" (optional) builds on this.

- [ ] **Step 1: Determine the maintainer handle**

Run: `gh api user --jq .login`
Expected: prints your GitHub login (e.g. `someuser`). Use it in the next step in place of `MAINTAINER_HANDLE`.

- [ ] **Step 2: Create `CODEOWNERS`** (replace `MAINTAINER_HANDLE` with the value from Step 1)

```
# Default owner for everything in this repo.
# A PR touching any file auto-requests this owner's review.
*       @MAINTAINER_HANDLE
```

- [ ] **Step 3: Verify the placeholder was replaced**

Run: `! grep -q 'MAINTAINER_HANDLE' CODEOWNERS && grep -q '^\*' CODEOWNERS && echo OK`
Expected: prints `OK` (fails loudly if the literal placeholder is still present).

- [ ] **Step 4: Commit**

```bash
git add CODEOWNERS
git commit -m "chore: add CODEOWNERS to auto-request maintainer review"
```

---

### Task 10: README — Vision section + navigation block

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `ROADMAP.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` (all created in Tasks 1–9, so every link now resolves).
- Produces: a hub README with a Vision section and a project-navigation block.

- [ ] **Step 1: Read the current README top**

Run: `sed -n '1,12p' README.md`
Expected: shows the `# teamctx` title and the existing tagline / "No server. No seats." lines, so you can place the new content directly after them.

- [ ] **Step 2: Insert the Vision section immediately after the tagline block**

Add this block right after the existing `**No server. No seats. Bring your own API key.**` line (and before the first `---`):

```markdown

## Vision

As teams adopt AI tools, the context that makes those tools useful — *why* the
team is doing something, *what* it's building, *how* it works — lives scattered
across docs, chats, and people's heads, and goes stale immediately. teamctx
treats that shared context like source code: version-controlled, continuously
updated, and compiled into a role-specific file each person hands to Claude,
ChatGPT, or Gemini. No server, no seats, bring your own key.
```

- [ ] **Step 3: Append a navigation block at the end of the README**

Add this section at the bottom of `README.md`:

```markdown

## Project

- [Roadmap](ROADMAP.md) — where teamctx is going
- [Contributing](CONTRIBUTING.md) — how to propose changes (DCO sign-off required)
- [Changelog](CHANGELOG.md) — what changed, per release
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)

Licensed under the [MIT License](LICENSE).
```

- [ ] **Step 4: Verify every linked file in the nav block exists**

Run:
```bash
for f in ROADMAP.md CONTRIBUTING.md CHANGELOG.md CODE_OF_CONDUCT.md SECURITY.md LICENSE; do test -f "$f" && echo "ok: $f" || echo "MISSING: $f"; done
```
Expected: six `ok:` lines, no `MISSING` (confirms no broken nav links).

- [ ] **Step 5: Verify the Vision section is present**

Run: `grep -q '^## Vision' README.md && echo OK`
Expected: prints `OK`.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: add Vision section and project navigation to README"
```

---

### Task 11: GitHub repository settings (manual, maintainer-run)

This task is **not committable code** — it configures the GitHub repo. It must be done by someone with admin rights on `StatsLateral/teamctx`, and only fully verified after the branch is pushed and CI has run once (so the `test` check is selectable). Do not skip it: without branch protection, the "two automated gates" are advisory only.

- [ ] **Step 1: Enable GitHub Discussions**

In GitHub → repo **Settings → General → Features**, check **Discussions**. (The ROADMAP and issue-template `config.yml` link to it.)

- [ ] **Step 2: Add a branch protection rule for `main`**

GitHub → **Settings → Branches → Add branch ruleset** (or "Add rule") targeting `main`:

- [ ] Require a pull request before merging → **Require approvals: 1**
- [ ] Require status checks to pass before merging → select the **`test`** check
- [ ] Require branches to be up to date before merging
- [ ] (Optional) Require review from Code Owners
- [ ] (Optional) Do not allow bypassing the above settings

- [ ] **Step 3: Confirm the gates work**

Open a throwaway test PR (or use the real PR for this work) and confirm: the `test` check runs, the maintainer is auto-requested for review, and **Merge** is blocked until both pass. Then proceed.

---

## Self-Review

**Spec coverage** (each spec deliverable → task):

- Vision (README section) → Task 10 ✓
- ROADMAP.md (Now/Next/Later, seeded) → Task 1 ✓
- CONTRIBUTING.md (setup, tests, DCO, code style, release process, governance) → Task 2 ✓
- CODE_OF_CONDUCT.md (Contributor Covenant 2.1) → Task 3 ✓
- SECURITY.md → Task 4 ✓
- CHANGELOG.md (Keep a Changelog, [Unreleased]) → Task 5 ✓
- Issue templates (bug + feature) + config.yml → Task 6 ✓
- pull_request_template.md → Task 7 ✓
- CI workflow (vitest, Node 18+20) → Task 8 ✓
- CODEOWNERS → Task 9 ✓
- README nav block → Task 10 ✓
- Branch protection + Discussions (+ first-publish noted in Task 2) → Task 11 ✓

No spec requirement is unmapped. The deferred API-extensibility workstream is intentionally absent (separate spec).

**Placeholder scan:** The only intentional token is `@MAINTAINER_HANDLE`, resolved in Task 9 Step 1 with a verification step (Task 9 Step 3) that fails if it's left in. CoC uses the upstream `[INSERT CONTACT METHOD]` token, resolved and verified in Task 3. No vague "add error handling"-style steps; every file step shows complete content.

**Type/name consistency:** The CI job/check is named `test` consistently in Task 8 and referenced as `test` in Task 11's branch protection. CONTRIBUTING's DCO anchor `#sign-your-commits-dco` matches the heading "Sign your commits (DCO)" in Task 2 (GitHub slugifies to that anchor), and the PR template (Task 7) links to it. Nav links in Task 10 match the exact filenames created in Tasks 1–9.
