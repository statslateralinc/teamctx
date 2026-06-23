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
