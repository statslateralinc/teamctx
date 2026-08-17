import { ask, askSecret } from '../prompt.js';
import { awaitLoopbackCode } from '../oauth-loopback.js';
import { authorizeConnector, NoAuthorizeError, connectorsWithAuthorize } from './auth.core.js';
import { UnknownConnectorError, listConnectors } from '../../src/connectors/index.js';

export async function authCommand(from, opts = {}) {
  let result;
  try {
    result = await authorizeConnector({
      from, ask, askSecret, loopback: awaitLoopbackCode, log: console.log, envFile: opts.envFile,
    });
  } catch (err) {
    if (err instanceof UnknownConnectorError) {
      console.error(`\n${err.message}\n`);
      const supported = new Set(connectorsWithAuthorize());
      for (const c of listConnectors()) {
        console.error(`  ${c.name.padEnd(10)} ${c.describe}${supported.has(c.name) ? '' : '  (no login flow)'}`);
      }
      process.exitCode = 1;
      return;
    }
    if (err instanceof NoAuthorizeError) {
      console.error(`\n${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    console.error(`\n${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  // Names only. A refresh token printed here would live in scrollback and in
  // whatever the terminal logs, which defeats writing it to a 0600 file.
  console.log(`\n✓ Saved to ${result.path}:`);
  result.keys.forEach(k => console.log(`    ${k}${result.replaced.includes(k) ? ' (replaced)' : ''}`));
  console.log(`\nThat file is gitignored and stays on this machine.`);
  console.log(`Try it:  teamctx import --from ${result.connector} <path> --dry-run\n`);
}
