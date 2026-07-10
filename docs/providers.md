# AI providers

teamctx sends every context-shaping call — distilling a `contribute`, generating
a role file, running `reflect`, answering `ask` — to a single LLM provider.
You pick which provider a project uses; teamctx does not lock you to one vendor.

Three providers ship out of the box:

| Provider  | Setting              | API key env var       |
|-----------|----------------------|-----------------------|
| Anthropic | `provider: anthropic` (default) | `ANTHROPIC_API_KEY` |
| OpenAI    | `provider: openai`   | `OPENAI_API_KEY`      |
| Gemini    | `provider: gemini`   | `GEMINI_API_KEY`      |

## Picking a provider on a new project

`teamctx init` asks for the provider. It then shows that provider's model
list and stores your choice in `.teamctx/config.json`:

```json
{
  "provider": "openai",
  "model": "gpt-4.1-mini"
}
```

If the matching key isn't in your environment yet, `init` prints a reminder
to add it to `.env.local`.

## Switching an existing project

```bash
teamctx config provider openai
teamctx config model gpt-4.1-mini
```

Order matters: pick the provider first, then set a model — `config model`
validates against the selected provider's known model list. Switching
providers never touches your Why/What/How tree.

## Bring your own key

Add whichever keys you use to `.env.local` (this file stays on your
machine — it's gitignored):

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
```

You only need the key that matches your selected provider. The self-hosted
web layer reads the same env var — set it in Vercel with `vercel env add`.

## Models

Each provider has a small curated model list (visible in `teamctx config
model`). teamctx is deliberately lax about validation: if you set a model
id that isn't in the list, teamctx warns but still writes it. That way a
new model release from any of the three providers works with teamctx
without waiting for a package update.

## What's not (yet) supported

- **Streaming responses.** All providers return the full response at
  once.
- **Tool-calling / structured output.** teamctx enforces JSON shape by
  prompting and repairing, not by relying on provider-side JSON mode.
- **Per-call provider overrides.** The provider is per-project, not
  per-command. Change it with `teamctx config provider`.
- **Local model runners** (Ollama, LM Studio, …) and hosted variants
  (Bedrock, Vertex) — track these as follow-ups on the roadmap.
