import { promisify } from 'util';
import { execFile } from 'child_process';
import { getCurrentSession } from './session-context.js';

const execFileAsync = promisify(execFile);

/**
 * The same answer, over the API, for a hosted caller with no clone to read.
 *
 * Without this the hosted surface has no history to consult and falls back to
 * comparing display names — the weaker signal, in exactly the place where the
 * caller is most likely to be somebody other than the creator.
 */
async function creatorViaApi(session) {
  const { owner, repo, ghToken } = session;
  if (!owner || !repo || !ghToken) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits?path=.teamctx/config.json&per_page=100`,
      { headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) return null;
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) return null;
    // Newest first, so the last entry is the commit that created the file.
    const email = list[list.length - 1]?.commit?.author?.email;
    return email ? String(email).toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Who created this project, according to the repository itself.
 *
 * The commit that first added `.teamctx/config.json` is the `init` commit, and
 * its author is the person who ran it. That is a better answer than anything in
 * `config.json`, because the file is editable by anyone with the repo while the
 * history is not — forging it needs push access, which is the bar repair
 * already sits behind.
 *
 * It also survives the case a display name cannot: somebody whose git name is
 * "Ada" repairing a gate that reads `name:Ada Lovelace`. The email is the same
 * either way.
 *
 * Returns null when the history cannot be read — a shallow clone, a hosted
 * session with no git binary, a repo whose history was rewritten. Callers fall
 * back rather than treating absence as a refusal.
 */
export async function projectCreator(cwd) {
  const session = getCurrentSession();
  if (session) return creatorViaApi(session);
  try {
    const { stdout } = await execFileAsync('git', [
      'log', '--diff-filter=A', '--format=%ae', '--', '.teamctx/config.json',
    ], cwd ? { cwd } : undefined);
    const lines = stdout.trim().split('\n').filter(Boolean);
    // The *last* line is the oldest commit — the one that created the file.
    return lines.length ? lines[lines.length - 1].trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Is this actor the person that email names?
 *
 * GitHub's noreply form, `<id>+<login>@users.noreply.github.com`, is what a
 * commit made through the web flow carries — so it has to be unpacked rather
 * than compared whole, otherwise the creator returning as `github:<id>` fails
 * to match the commit they themselves authored.
 */
export function isCreator(creatorEmail, actor) {
  if (!creatorEmail || !actor) return null;
  const email = String(creatorEmail).toLowerCase();
  const mine = String(actor.email || '').toLowerCase();

  if (mine && mine === email) return true;
  if (String(actor.key || '').toLowerCase() === `git:${email}`) return true;

  const noreply = /^(?:(\d+)\+)?([^@]+)@users\.noreply\.github\.com$/.exec(email);
  if (noreply) {
    const [, id, login] = noreply;
    if (id && String(actor.key || '') === `github:${id}`) return true;
    if (login && String(actor.login || '').toLowerCase() === login.toLowerCase()) return true;
    // A noreply address names an account outright, so not matching it is a real
    // answer rather than a gap.
    return false;
  }

  // A plain address can only be compared against an address. A hosted caller
  // whose token predates the `user:email` scope has none — and calling that a
  // mismatch would lock the creator out of their own project over MCP, which is
  // the failure this whole command exists to undo. Not knowing is not "no".
  return mine ? false : null;
}
