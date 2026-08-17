import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { getConnector, listConnectors } from '../../src/connectors/index.js';

/**
 * Obtain long-lived credentials for a connector.
 *
 * Every remote connector so far ends its `help` text with some version of
 * "…and keep the refresh token it returns", which quietly assumes the user will
 * run a token exchange by hand. That is a curl command, not a flow — the sort
 * of instruction that works for whoever wrote it and nobody else.
 *
 * `authorize` is optional on the contract, and additive: a connector that has
 * it owns only the provider-specific parts (where to send the user, how to
 * exchange what comes back). Prompting, writing the file, and never printing a
 * secret are handled here, once, for all of them.
 *
 * Credentials still land in `.env.local` and are still read from `env` by
 * `auth`. Nothing about the connector contract changes — this only removes the
 * step where the user was expected to be their own OAuth client.
 */

export class NoAuthorizeError extends Error {
  constructor(name) {
    const supported = connectorsWithAuthorize();
    super(`"${name}" has no login flow.`
      + (supported.length
        ? ` Connectors that do: ${supported.join(', ')}.`
        : ' Set its credentials in .env.local instead.'));
    this.code = 'NO_AUTHORIZE';
    this.connector = name;
  }
}

export function connectorsWithAuthorize() {
  return listConnectors()
    .map(c => getConnector(c.name))
    .filter(c => typeof c.authorize === 'function')
    .map(c => c.name);
}

/**
 * Merge values into a dotenv file, preserving everything already in it.
 *
 * Rewriting the file from the values alone would be a data-loss bug the first
 * time somebody keeps an API key next to a connector token — which is the
 * normal case, since `.env.local` is where this project already tells people to
 * put their provider key.
 */
export function upsertEnv(source, values) {
  const lines = source ? source.split(/\r?\n/) : [];
  const remaining = new Map(Object.entries(values));

  const merged = lines.map(line => {
    // `export KEY=` is legal in a dotenv file and people do write it.
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (!key || !remaining.has(key)) return line;
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${value}`;
  });

  if (remaining.size > 0) {
    // A blank line before the block, but only if there is something to
    // separate it from.
    if (merged.length > 0 && merged[merged.length - 1].trim() !== '') merged.push('');
    for (const [key, value] of remaining) merged.push(`${key}=${value}`);
  }

  const text = merged.join('\n');
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * Run a connector's login flow and record the result.
 *
 * Returns the *names* of the variables written, never their values — the caller
 * prints this, and a refresh token that reaches a terminal ends up in scrollback
 * and shell history.
 */
export async function authorizeConnector({
  from, ask, askSecret = ask, log = () => {}, env = process.env,
  cwd = process.cwd(), envFile = '.env.local',
} = {}) {
  const connector = getConnector(from);
  if (typeof connector.authorize !== 'function') throw new NoAuthorizeError(connector.name);

  const values = await connector.authorize({ ask, askSecret, env, log });
  const keys = Object.keys(values || {});
  if (keys.length === 0) throw new Error(`${connector.name}: the login flow returned no credentials`);

  const path = resolve(cwd, envFile);
  const before = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const replaced = keys.filter(k => new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=`, 'm').test(before));

  writeFileSync(path, upsertEnv(before, values), { encoding: 'utf-8', mode: 0o600 });

  return { connector: connector.name, path, keys, replaced };
}
