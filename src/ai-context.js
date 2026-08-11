import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request AI key store.
 *
 * On the local CLI, keys come from `.env.local` / `process.env` — this
 * store stays empty and callers fall back to `process.env.ANTHROPIC_API_KEY`.
 *
 * On the hosted MCP, each request may carry its own caller-supplied key via
 * URL / header. `runWithAiKey` puts the caller's key into an AsyncLocalStorage
 * context so `getRequestAiKey()` returns it for anything the request runs,
 * without ever mutating `process.env` (safe for concurrent requests).
 */
const store = new AsyncLocalStorage();

export function runWithAiKey(apiKey, fn, provider = null) {
  return store.run({ apiKey, provider }, fn);
}

export function getRequestAiKey() {
  return store.getStore()?.apiKey || null;
}

/**
 * The provider the caller's key belongs to, when known. A key is useless
 * against the wrong provider, so this has to travel with it rather than being
 * read from the project's shared config.
 */
export function getRequestAiProvider() {
  return store.getStore()?.provider || null;
}
