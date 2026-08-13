import * as coda from './coda.js';
import * as folder from './folder.js';

/**
 * Import connectors.
 *
 * A connector turns a source into the documents `teamctx import` already knows
 * how to distill. That is all it does. Everything after "documents exist" —
 * distilling, deduplicating, queueing for review — is shared and already built,
 * so a connector contains no AI calls, writes nothing to the repo, and never
 * touches the review queue. If one imports src/ai.js, something has gone wrong.
 *
 * The shape, deliberately the same as src/providers/index.js so it reads as
 * familiar:
 *
 *   name                        matches `--from <name>`
 *   describe                    one line, shown when listing connectors
 *   auth(env)      → { ok, help? }
 *   list(auth, selector, opts)  → [{ ref, id, title? }]
 *   fetch(auth, ref)            → { id, title?, text }
 *
 * `list` is separate from `fetch` so `--dry-run` can report what *would* be
 * pulled without downloading it. That is dead weight for a folder and the whole
 * point for a Slack channel of ten thousand messages.
 *
 * `auth` returns a result rather than throwing, so a missing token becomes
 * "set SLACK_TOKEN in .env.local" instead of a stack trace. Credentials come
 * from the environment — never from config.json, which is committed.
 */

const CONNECTORS = { coda, folder };

export class UnknownConnectorError extends Error {
  constructor(name) {
    super(`unknown connector "${name}". Known: ${knownConnectorNames().join(', ')}.`);
    this.code = 'UNKNOWN_CONNECTOR';
    this.connector = name;
  }
}

export class ConnectorAuthError extends Error {
  constructor(name, help) {
    super(help ? `${name}: ${help}` : `${name}: missing credentials.`);
    this.code = 'CONNECTOR_AUTH';
    this.connector = name;
  }
}

export function getConnector(name) {
  const connector = CONNECTORS[String(name || '').toLowerCase()];
  if (!connector) throw new UnknownConnectorError(name);
  return connector;
}

export function knownConnectorNames() {
  return Object.keys(CONNECTORS).sort();
}

export function listConnectors() {
  return knownConnectorNames().map(n => ({ name: n, describe: CONNECTORS[n].describe || '' }));
}
