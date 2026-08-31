/**
 * GitHub-backed storage session for hosted MCP.
 *
 * Model: prefetch + in-memory buffer + atomic batch commit.
 *
 *   1. Construct with { owner, repo, ref?, ghToken }.
 *   2. `await session.prefetch()` — loads every file under `.teamctx/` in
 *      the repo via the Git Trees API (recursive), then reads each blob.
 *      Stored in `session.files: Map<path, {content, sha}>`.
 *   3. Callers `read(path)` / `write(path, content)` / `del(path)`
 *      synchronously against the in-memory buffer. Writes are staged in
 *      `session.changes` — the source of truth for the commit.
 *   4. `await session.commit(message)` — builds a new tree from the
 *      current buffer state, creates a commit that points at that tree
 *      with the fetched HEAD as parent, and fast-forwards the ref.
 *      All buffered writes land as ONE git commit. Matches local
 *      `git add -A && git commit -m ...` behavior exactly.
 *
 * The dispatch layer in src/storage.js is what routes filesystem-style
 * calls (`readConfig(dir)` etc.) to a session when the current async
 * context has one; see src/session-context.js.
 */

const API = 'https://api.github.com';
const CONTEXT_ROOT = '.teamctx';

export function isGithubCtx(dir) {
  return typeof dir === 'object' && dir !== null && dir.__backend === 'github';
}

/**
 * Turns a human-typed project name into a GitHub-valid repo name. Never
 * empty — an all-punctuation or blank name still needs somewhere to land.
 */
export function slugifyProjectName(name) {
  const slug = String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}

/** Orgs the token's owner belongs to, for the "where should this repo live" picker. */
export async function listUserOrgs(token) {
  const res = await fetch(`${API}/user/orgs`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`github: could not list orgs (${res.status})`);
  const body = await res.json();
  return body.map(o => ({ login: o.login }));
}

export class GithubSession {
  constructor({ owner, repo, ref, ghToken }) {
    if (!owner || !repo) throw new Error('GithubSession requires owner + repo');
    if (!ghToken) throw new Error('GithubSession requires ghToken');
    this.owner = owner;
    this.repo = repo;
    this.ref = ref || null;         // resolved on prefetch when null
    this.ghToken = ghToken;
    /** @type {Map<string, {content: string, sha: string}>} */
    this.files = new Map();
    /** Staged writes/deletes keyed by path. `null` value = delete. */
    this.changes = new Map();
    this.baseCommitSha = null;      // parent for the flush commit
    this.baseTreeSha = null;
    this.prefetched = false;
  }

  async #ghFetch(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.ghToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok && res.status !== 404 && res.status !== 409) {
      const body = await res.text().catch(() => '');
      throw new Error(`github ${opts.method || 'GET'} ${url} → ${res.status}: ${body.slice(0, 400)}`);
    }
    return res;
  }

  async #getDefaultBranch() {
    const res = await this.#ghFetch(`${API}/repos/${this.owner}/${this.repo}`);
    if (res.status === 404) throw new Error(`github: repo ${this.owner}/${this.repo} not found (or PAT lacks access)`);
    const body = await res.json();
    return body.default_branch;
  }

  async prefetch() {
    if (this.prefetched) return;

    if (!this.ref) this.ref = await this.#getDefaultBranch();

    // 1. Resolve the ref's HEAD commit + tree sha.
    const refRes = await this.#ghFetch(
      `${API}/repos/${this.owner}/${this.repo}/git/refs/heads/${encodeURIComponent(this.ref)}`,
    );
    if (refRes.status === 404) {
      // Empty repo or unknown branch — no baseline; nothing to prefetch.
      this.prefetched = true;
      return;
    }
    const refBody = await refRes.json();
    this.baseCommitSha = refBody.object.sha;
    const commitRes = await this.#ghFetch(
      `${API}/repos/${this.owner}/${this.repo}/git/commits/${this.baseCommitSha}`,
    );
    const commitBody = await commitRes.json();
    this.baseTreeSha = commitBody.tree.sha;

    // 2. Recursive tree listing — one API call, returns every blob path.
    const treeRes = await this.#ghFetch(
      `${API}/repos/${this.owner}/${this.repo}/git/trees/${this.baseTreeSha}?recursive=1`,
    );
    const treeBody = await treeRes.json();
    const entries = (treeBody.tree || []).filter(
      e => e.type === 'blob' && e.path.startsWith(`${CONTEXT_ROOT}/`),
    );

    // 3. Fetch each blob's content in parallel.
    await Promise.all(entries.map(async e => {
      const blobRes = await this.#ghFetch(
        `${API}/repos/${this.owner}/${this.repo}/git/blobs/${e.sha}`,
      );
      const blob = await blobRes.json();
      const content = blob.encoding === 'base64'
        ? Buffer.from(blob.content, 'base64').toString('utf8')
        : String(blob.content || '');
      this.files.set(e.path, { content, sha: e.sha });
    }));

    this.prefetched = true;
  }

  // ---- Synchronous read/write against the in-memory buffer ----

  read(path) {
    if (this.changes.has(path)) {
      const staged = this.changes.get(path);
      return staged === null ? null : { content: staged, sha: null };
    }
    return this.files.get(path) || null;
  }

  write(path, content) {
    this.changes.set(path, String(content));
  }

  del(path) {
    this.changes.set(path, null);
  }

  listDir(dirPath) {
    const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
    const names = new Set();
    for (const p of this.files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes('/')) continue;         // subdir, not direct child
      if (!this.changes.has(p) || this.changes.get(p) !== null) names.add(rest);
    }
    for (const [p, v] of this.changes) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes('/')) continue;
      if (v === null) names.delete(rest);
      else names.add(rest);
    }
    return [...names].sort();
  }

  hasStagedChanges() {
    return this.changes.size > 0;
  }

  // ---- Batch commit via the Git Data API ----

  /**
   * `author` names the person the change is *from*; the token supplies the
   * committer. Git has always separated the two, and the Git Data API exposes
   * both — which is what lets a write made on one credential still be recorded
   * against whoever actually made it.
   *
   * Without it every hosted commit is attributed to the token holder, so a
   * team sharing one project would show one contributor in `git log`.
   */
  async commit(message, { author } = {}) {
    if (this.changes.size === 0) return { committed: false };
    if (!this.prefetched) throw new Error('GithubSession.commit called before prefetch');

    // 1. Create blobs for every new/changed file.
    const blobEntries = [];
    for (const [path, content] of this.changes) {
      if (content === null) {
        blobEntries.push({ path, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const blobRes = await this.#ghFetch(`${API}/repos/${this.owner}/${this.repo}/git/blobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: Buffer.from(content, 'utf8').toString('base64'),
          encoding: 'base64',
        }),
      });
      const blob = await blobRes.json();
      blobEntries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    // 2. Create a new tree based on the current baseTreeSha with the deltas.
    const treeRes = await this.#ghFetch(`${API}/repos/${this.owner}/${this.repo}/git/trees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_tree: this.baseTreeSha || undefined,
        tree: blobEntries,
      }),
    });
    const tree = await treeRes.json();
    if (!tree.sha) throw new Error(`github: tree creation failed: ${JSON.stringify(tree).slice(0, 400)}`);

    // 3. Create the commit that points at the new tree.
    const commitRes = await this.#ghFetch(`${API}/repos/${this.owner}/${this.repo}/git/commits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        tree: tree.sha,
        parents: this.baseCommitSha ? [this.baseCommitSha] : [],
        // Omitted rather than guessed when unknown: GitHub then attributes to
        // the token, which is at least true.
        ...(author?.name && author?.email
          ? { author: { name: author.name, email: author.email, date: new Date().toISOString() } }
          : {}),
      }),
    });
    const commit = await commitRes.json();
    if (!commit.sha) throw new Error(`github: commit creation failed: ${JSON.stringify(commit).slice(0, 400)}`);

    // 4. Fast-forward the ref. On 422 (non-fast-forward: someone else pushed
    //    since our prefetch) refetch base and retry once — same protection
    //    the fs `commitContext` gets from git itself.
    const refUrl = `${API}/repos/${this.owner}/${this.repo}/git/refs/heads/${encodeURIComponent(this.ref)}`;
    const patchBody = JSON.stringify({ sha: commit.sha });
    const patchRes = await this.#ghFetch(refUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: patchBody,
    });

    if (patchRes.status === 422) {
      // Someone else pushed. Refresh base, rebuild, retry once.
      const refRes = await this.#ghFetch(refUrl);
      const refBody = await refRes.json();
      this.baseCommitSha = refBody.object.sha;
      const commitBody = await (await this.#ghFetch(
        `${API}/repos/${this.owner}/${this.repo}/git/commits/${this.baseCommitSha}`,
      )).json();
      this.baseTreeSha = commitBody.tree.sha;
      // Not re-uploading blobs (they're content-addressed and reusable) —
      // just build a new tree + commit on top of the fresh base.
      const retryTreeRes = await this.#ghFetch(`${API}/repos/${this.owner}/${this.repo}/git/trees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_tree: this.baseTreeSha, tree: blobEntries }),
      });
      const retryTree = await retryTreeRes.json();
      const retryCommitRes = await this.#ghFetch(`${API}/repos/${this.owner}/${this.repo}/git/commits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, tree: retryTree.sha, parents: [this.baseCommitSha] }),
      });
      const retryCommit = await retryCommitRes.json();
      const retryPatchRes = await this.#ghFetch(refUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: retryCommit.sha }),
      });
      if (!retryPatchRes.ok) {
        const t = await retryPatchRes.text().catch(() => '');
        throw new Error(`github: ref update failed after retry: ${retryPatchRes.status} ${t.slice(0, 400)}`);
      }
      this.#applyChangesToBaseline(retryCommit.sha, retryTree.sha, blobEntries);
      return { committed: true, sha: retryCommit.sha };
    }

    if (!patchRes.ok) {
      const t = await patchRes.text().catch(() => '');
      throw new Error(`github: ref update failed: ${patchRes.status} ${t.slice(0, 400)}`);
    }

    this.#applyChangesToBaseline(commit.sha, tree.sha, blobEntries);
    return { committed: true, sha: commit.sha };
  }

  #applyChangesToBaseline(newCommitSha, newTreeSha, blobEntries) {
    // Advance the session's baseline so subsequent writes in the same
    // session (rare, but possible) stack on this commit rather than the
    // pre-flush one.
    this.baseCommitSha = newCommitSha;
    this.baseTreeSha = newTreeSha;
    for (const entry of blobEntries) {
      if (entry.sha === null) {
        this.files.delete(entry.path);
      } else {
        const staged = this.changes.get(entry.path);
        this.files.set(entry.path, { content: staged, sha: entry.sha });
      }
    }
    this.changes.clear();
  }
}
