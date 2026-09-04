import { managerKeys } from './review.js';
import { isCreator } from './project-creator.js';

/**
 * May this gate be repaired, and to what?
 *
 * Separated from the command because the precondition *is* the safety argument:
 * repairing a manager gate grants manager rights, so the one thing standing
 * between a repair and a "become manager" backdoor is that it only ever fires
 * on a gate nobody could pass anyway.
 *
 * A `name:` key is that gate. It is the last resort of the actor ladder
 * (src/actor.js), produced only when there is no ambient identity and no git
 * config, and its value comes from `config.me` — which is committed and shared.
 * So anyone with the repository and no local git identity already presents that
 * key and passes. Repair does not open a door; the door is open, and repair is
 * what closes it.
 *
 * Which is why it must refuse a gate that works. Against a real `git:` or
 * `github:` key this would be the escalation #49 removed.
 */
export const BROKEN_PREFIX = 'name:';

export function isBrokenGate(config) {
  const keys = managerKeys(config);
  return keys.length > 0 && keys.every(k => k.startsWith(BROKEN_PREFIX));
}

export function repairDecision({ config, actor, displayName, creatorEmail = null } = {}) {
  const keys = managerKeys(config);

  if (keys.length === 0) {
    // No gate at all is the bootstrap case — `canApprove` already lets anyone
    // through and the first to pin it wins. Not this command's business.
    return { ok: false, why: 'This project has no manager gate to repair.' };
  }
  if (!isBrokenGate(config)) {
    return {
      ok: false,
      why: `The manager gate is ${keys.join(', ')}, which is a real identity. `
        + 'Repair only replaces a display-name gate that nobody can match.',
    };
  }
  // Whose gate is it? "The gate is already open" justifies passing it, not
  // taking it: repair converts "anyone may approve" into "only this person
  // may", so without a check the first to run it takes the project and locks
  // out the person it was for, with no way back through the tool.
  //
  // Two ways to be recognised, and the caller needs either. The repository's own
  // history is the stronger one and is tried first — the author of the commit
  // that created `.teamctx/config.json` is the person who ran `init`, and unlike
  // anything in that file, history cannot be edited without the push access
  // repair already sits behind. The display name is the weaker fallback, for
  // when the history cannot be read at all.
  const named = keys[0].slice(BROKEN_PREFIX.length);
  const byHistory = creatorEmail ? isCreator(creatorEmail, actor) : null;
  const byName = String(displayName || actor?.name || '').trim().toLowerCase()
    === named.trim().toLowerCase();

  // When the history can be read it decides, and the name is not consulted:
  // otherwise somebody renaming themselves to the name on the gate walks past
  // the stronger signal, which is the whole reason the stronger one is there.
  if (byHistory === false) {
    return {
      ok: false,
      why: `${creatorEmail} created this project, and you are `
        + `${actor?.email || actor?.key || 'unidentified'}. Repair re-pins the gate to whoever `
        + 'runs it, so only its creator may. Ask them to run it, or edit '
        + '`.teamctx/config.json` directly if you have agreed to take it over.',
    };
  }
  if (byHistory === null && !byName) {
    // No history to consult, so the name is all there is.
    return {
      ok: false,
      why: `That gate belongs to "${named}", and this repository's history does not say who `
        + `created it, so that name is all there is to go on. You are "${displayName || actor?.name || 'unidentified'}". `
        + 'Set your name to match with `teamctx config name`, or edit `.teamctx/config.json` directly.',
    };
  }

  // The email, not `actor.key`. A hosted GitHub caller resolves to
  // `github:<id>`, which only that one surface can present — pinning it would
  // rebuild the single-surface gate #71 existed to remove, and the same person
  // signing in with Google would be locked out all over again.
  const email = String(actor?.email || '').toLowerCase();
  const key = email ? `git:${email}` : String(actor?.key || '');
  if (!key || key.startsWith(BROKEN_PREFIX)) {
    // Rewriting one unusable gate as another helps nobody, and would look like
    // it had worked.
    return {
      ok: false,
      why: 'You have no stable identity here either, so repairing would write '
        + 'another gate nobody can match. Set `git config user.email` in this '
        + 'clone, or run this where you are signed in.',
    };
  }
  return {
    ok: true, from: keys[0], to: key,
    // Honest about a half-fix: an id-shaped gate works where it was set and
    // nowhere else, so the caller should know to come back once their token can
    // say what their address is.
    ...(email ? {} : {
      warning: 'Your session did not reveal an email address, so the gate is pinned to your '
        + 'GitHub id. That works from GitHub but not from a Google sign-in. Re-authorise the '
        + 'connector to pick up the email scope, then run this again to widen it.',
    }),
  };
}
