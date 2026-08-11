import { readConfig } from '../src/storage.js';
import { resolveActor } from '../src/actor.js';
import { resolveActiveWorkstream, resolveDisplayName } from '../src/prefs.js';

/**
 * Who is running this command, and where they are working.
 *
 * The CLI commands used to read `config.me` and `config.activeWorkstream`
 * straight off the shared config. Both are per-person, so this resolves them
 * for the caller instead — see src/actor.js and src/prefs.js.
 */
export async function currentIdentity(config = readConfig()) {
  const actor = await resolveActor({ config });
  return {
    actor,
    /** Display name for contributions and commit messages. Never empty. */
    me: await resolveDisplayName({ actor, config }),
    /** Stable key recorded alongside the display name. */
    authorKey: actor.key,
    activeWorkstream: await resolveActiveWorkstream({ actor, config }),
  };
}
