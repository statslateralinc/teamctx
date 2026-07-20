# Provider-Agnostic AI Layer Implementation Plan

**Goal:** Put teamctx's LLM calls behind a small provider interface so the same CLI can talk to Anthropic, OpenAI, or Gemini. Anthropic stays the default and existing users see no behavior change; new users can pick a provider at `init` time and set `OPENAI_API_KEY` or `GEMINI_API_KEY` instead of (or in addition to) `ANTHROPIC_API_KEY`.

**Architecture:** A tiny `complete({ system, prompt, model, max_tokens }) -> string` interface lives in `src/providers/index.js` alongside a per-provider file (`anthropic.js`, `openai.js`, `gemini.js`). `getProvider(config)` picks one based on `config.provider` (default `'anthropic'`). `callClaude` in `src/ai.js` becomes a thin router that calls the selected provider's `complete(...)` — so `context.js`, `roles.js`, and `api/ask.js` need no signature changes. A per-provider model registry replaces the single `MODELS` constant so `init` and `config model` show the right options.

**Tech Stack:** Node.js (ESM), Commander.js CLI, Vitest. Two new deps: `openai` and `@google/genai`. Reuses existing `.env.local` loading.

## Global Constraints

- Node >= 18, ESM only, follow existing code style (2-space indent, single quotes, arrow functions, `try { } catch { /* comment */ }` for swallowed errors).
- No breaking changes: `config.provider` absent = `'anthropic'`. Existing `.teamctx/config.json` files must continue to work with zero migration.
- No streaming, no tool-calling, no per-call provider overrides — YAGNI, per the proposal.
- Every commit signed off (`git commit -s`), single logical change, small message.
- All commits go to the `feat/provider-agnostic-ai` branch. Do not push or open a PR until separately asked.
- `npm test` must stay green after every commit.

---

## Task 1: Plan file (this commit)

**Files:** Add `docs/superpowers/plans/2026-07-10-provider-agnostic-ai.md` (this file).

Commit: `docs: plan for provider-agnostic AI layer`.

---

## Task 2: Extract `complete(...)` interface + Anthropic provider

**Files:**
- Add: `src/providers/anthropic.js` — exports `complete({ system, prompt, model, max_tokens })` with the exact body of today's `callClaude` (build `Anthropic` client, read `ANTHROPIC_API_KEY`, `messages.create`, join text blocks).
- Add: `src/providers/index.js` — exports `getProvider(config)` returning the anthropic provider when `config.provider` is `'anthropic'` or missing; throws `Unknown provider: <x>` otherwise (openai/gemini added in later tasks).
- Modify: `src/ai.js` — `callClaude(...)` becomes `getProvider(config).complete(...)`. Add optional `config` parameter, default to `{ provider: 'anthropic' }`. Keep `MODELS`, `DEFAULT_MODEL`, `extractJson`, `proposeDiff` in place for now.

**Behavior:** unchanged. `ai.test.js` continues to pass — the `@anthropic-ai/sdk` mock now runs through `providers/anthropic.js`.

Commit: `refactor(ai): move Claude call into providers/anthropic.js behind complete() interface`.

---

## Task 3: Route call sites through the selected provider

**Files:**
- Modify: `src/ai.js` — `proposeDiff` accepts `config` (not just `model`), forwards to `callClaude({ ..., config })`.
- Modify: `src/context.js` — `updateShared`, `generateRoleFile`, `generateReflection`, `answerQuestion` all pass `config` through instead of just `config.model`.
- Modify: `src/roles.js` — `suggestRoles` passes `config` through.
- Modify: `api/ask.js` — reads `config` and passes it to `answerQuestion`.

**Behavior:** still unchanged (only anthropic exists). This is the plumbing pass so later tasks don't need to touch every call site again.

Commit: `refactor(ai): thread config through all AI call sites`.

---

## Task 4: Per-provider model registry

**Files:**
- Modify: `src/ai.js` — `MODELS` becomes `MODELS_BY_PROVIDER = { anthropic: [...] }`. Add `getModelsFor(providerId)` and `getDefaultModelFor(providerId)`. Keep `MODELS` and `DEFAULT_MODEL` as deprecated re-exports of the anthropic entries for one release (backward-compat for anything importing them).
- Modify: `cli/commands/init.js` — uses `getModelsFor` / `getDefaultModelFor` (still anthropic only at this point).
- Modify: `cli/commands/config.js` — `configModelCommand` validates against the selected provider's model list (warn-only if unknown, so we don't break users on new model releases).

Commit: `refactor(ai): make model registry provider-keyed`.

---

## Task 5: `teamctx config provider` command

**Files:**
- Modify: `cli/commands/config.js` — add `configProviderCommand(value)` that reads/writes `config.provider`, validates against known provider ids (`anthropic|openai|gemini`), and warns if the corresponding API key env var is not set.
- Modify: `cli/index.js` — register `program.command('config provider [value]')`.

**Tests:** none needed — this mirrors the shape of `configModelCommand`, which is also untested.

Commit: `feat(config): add teamctx config provider <name>`.

---

## Task 6: `init` asks for provider

**Files:**
- Modify: `cli/commands/init.js` — after "Your name", prompt "AI provider" (choice: anthropic/openai/gemini, default anthropic). Store on config as `provider`. Model choice uses that provider's model list. If the provider's API key env var is not set, print a note pointing at `.env.local`.

Commit: `feat(init): prompt for AI provider on new projects`.

---

## Task 7: OpenAI provider

**Files:**
- Add: `src/providers/openai.js` — `complete({ system, prompt, model, max_tokens })` using `openai` SDK. Reads `OPENAI_API_KEY`. Uses `chat.completions.create` with `system`/`user` messages; returns `choices[0].message.content`.
- Modify: `src/providers/index.js` — wire `'openai'` case.
- Modify: `src/ai.js` — add openai entry to `MODELS_BY_PROVIDER` (e.g. `gpt-4.1-mini`, `gpt-4.1`, `gpt-4o`).
- Modify: `package.json` — add `openai` dependency.

Commit: `feat(providers): add OpenAI provider`.

---

## Task 8: Gemini provider

**Files:**
- Add: `src/providers/gemini.js` — `complete(...)` using `@google/genai`. Reads `GEMINI_API_KEY`. Uses `models.generateContent` with `systemInstruction` and user parts; returns `response.text`.
- Modify: `src/providers/index.js` — wire `'gemini'` case.
- Modify: `src/ai.js` — add gemini entry to `MODELS_BY_PROVIDER` (e.g. `gemini-2.5-flash`, `gemini-2.5-pro`).
- Modify: `package.json` — add `@google/genai` dependency.

Commit: `feat(providers): add Gemini provider`.

---

## Task 9: Provider selection tests

**Files:**
- Add: `src/providers/index.test.js`
  - Fake three providers, verify `getProvider({provider:'anthropic'|'openai'|'gemini'})` returns the right one.
  - Missing `config.provider` → anthropic.
  - Unknown provider → throws `Unknown provider: <x>`.
- Extend: `src/ai.test.js` — one test that `callClaude` calls the resolved provider's `complete(...)` with the same args.

**Do not** try to test the real OpenAI/Gemini SDKs — mock them the same way `@anthropic-ai/sdk` is mocked today.

Commit: `test: cover provider selection and routing`.

---

## Task 10: Docs

**Files:**
- Add: `docs/providers.md` — short guide: how to choose a provider, which env var each expects, how to switch (`teamctx config provider`), which models each provider supports out of the box, and how model validation is lax by design.
- Modify: `README.md` — Quickstart mentions "Anthropic, OpenAI, or Gemini — set the matching key in `.env.local`"; Commands table gets a row for `teamctx config provider`. Add one-line pointer to `docs/providers.md`.
- Modify: `.env.example` — add commented lines for `OPENAI_API_KEY` and `GEMINI_API_KEY`.

Commit: `docs: cover the provider-agnostic AI layer`.

---

## Task 11: Changelog

**Files:**
- Modify: `CHANGELOG.md` — under `## [Unreleased]`:
  - `Provider-agnostic AI layer — teamctx now supports Anthropic (default), OpenAI, and Gemini via a shared provider interface.`
  - `teamctx config provider <anthropic|openai|gemini>` and matching prompt during `init`.

Commit: `chore: changelog for provider-agnostic AI layer`.

---

## Testing plan

- After every commit: `npm test`. All existing tests must stay green.
- After Task 9: new tests cover provider selection.
- Manual smoke (after Task 8, before docs):
  - Fresh `teamctx init` in a sandbox with each provider selected in turn.
  - `teamctx contribute "..."` against each provider (skip whichever provider you don't have a key for).
  - `teamctx config provider <name>` on an existing project flips the provider without touching data.

## Out of scope (follow-ups)

- Streaming responses.
- Tool-calling / structured outputs beyond plain text.
- Per-call provider overrides (`--provider openai` on a single command).
- Local-model runners (Ollama, etc.).
- Bedrock / Vertex hosting variants of the same models.
