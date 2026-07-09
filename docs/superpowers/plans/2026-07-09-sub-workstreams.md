# Implementation Plan: AI-suggested sub-workstreams

**Branch:** `feat/suggest-subworkstreams` · **Roadmap item:** ["AI-suggested sub-workstreams"](../../../ROADMAP.md) (Next) · **Status:** Draft

## Goal

Let a manager see, at a glance, when their `.teamctx/` tree has grown to hold
*multiple threads* (product vision vs. tech architecture, GTM vs. platform, etc.)
and split those threads into separate **workstreams** — each with its own
`Why/What/How` tree, its own compiled markdown, and its own assigned roles.

The AI proposes the split. The manager approves it, names each workstream, and
reassigns roles. teamctx does the file surgery and commits it.

## Why this matters (in one paragraph)

Today every contribution lands in one flat tree. As soon as a team is doing more
than one thing at once — the CPO is talking about pricing, the CTO is talking
about the migration — the tree turns into a mixed record where nobody's
role-context file is sharp. The role file for the CPO includes tech-migration
details and vice versa. The manager has no lever to fix this today short of
starting a second project. Sub-workstreams are that lever.

## Non-goals for this PR

Keep the PR focused. Explicitly out of scope:

- **Nested sub-sub-workstreams.** Workstreams are peers, not a tree. If nesting
  is genuinely needed later, add `parentId` to a workstream entry — cheap
  upgrade.
- **Merging workstreams back together.** Additive-only for now.
- **Deleting a workstream.** Destructive; defer until we know how contributions
  and role assignments should follow.
- **MCP tool argument changes** (`--workstream` on `submit_contribution`, etc.).
  Follow-up PR — this one ships the CLI and data-model change first.
- **Web layer changes** (`/context/<role>`, `/contribute`, `/ask`). Role files
  still resolve by slug; the web layer is unaware of workstreams. Follow-up.
- **Automatic re-splitting on every `contribute`.** The AI-suggest flow is a
  manager-invoked command, not a passive analyzer.

## Design

### Data model

Today: one file, `.teamctx/shared.json`, holds a single workstream `{ id: 'main', name, whys }`.

After this PR:

```
.teamctx/
  config.json                          # + workstreams: [{ id, name, createdAt }]
                                       # + roles[].workstream: '<id>'
  workstreams/
    main.json                          # was shared.json
    product.json                       # created by 'workstream split'
    tech.json
  context/
    workstreams/
      main.md                          # was context/shared.md
      product.md
      tech.md
    roles/
      <slug>.md                        # generated from that role's workstream
```

Each workstream file has the same shape it does today: `{ id, name, whys }`.
No node schema change — this is purely a horizontal split of one file into N.

### Back-compat and migration

Migration runs lazily on read, gated on a version marker in `config.json`.

- If `config.workstreamsMigrated` is absent AND `.teamctx/shared.json` exists:
  1. Create `.teamctx/workstreams/main.json` from `shared.json`.
  2. Add `{ id: 'main', name: <config.project>, createdAt: <shared.createdAt or now> }` to `config.workstreams`.
  3. Default every role's `workstream` field to `'main'`.
  4. Move `.teamctx/context/shared.md` → `.teamctx/context/workstreams/main.md`.
  5. Set `config.workstreamsMigrated = true` and write config.
  6. Delete the old `shared.json` and `shared.md`.
- All migration writes go into one commit with a clear message so the manager
  sees exactly what moved.

`readShared()` / `writeShared()` stay as thin wrappers over `readWorkstream('main')` /
`writeWorkstream('main', …)` so existing call sites (init, contribute, reflect,
role, mcp) keep working without an audit. New workstream-aware call sites use
the new API directly.

### Role ↔ workstream binding

Each role gets a `workstream: <id>` field. Role files are generated from that
workstream's tree only. This is the payoff of the whole feature — CPO's file
becomes sharp again.

- On migration, every existing role is assigned to `main`. No prompt.
- `role add` and `role add --suggest` accept `--workstream <id>` (defaults to
  the currently-active workstream, see below).
- New command `role assign <slug> --workstream <id>` moves a role and
  regenerates its file.

### "Active workstream" default

`contribute`, `ask`, and interactive commands need to know which workstream to
target when the user doesn't say. Options considered:

- **A. Prompt every time.** Too noisy.
- **B. Config-level `activeWorkstream`.** Simple; manager sets it with
  `config active-workstream <id>` or the interactive `workstream use`. **Pick this.**
- **C. Per-shell state.** Ugly; doesn't fit the filesystem-tracked model.

Default `activeWorkstream = 'main'` at migration. `--workstream <id>` on
`contribute` and `ask` overrides.

### The AI proposal

New function `proposeSubworkstreams(workstream, config)` in
`src/context.js`. Returns:

```json
{
  "splits": [
    {
      "name": "Product",
      "rationale": "one-sentence why these belong together",
      "whyIds": ["...", "..."]
    },
    { "name": "Tech", "rationale": "...", "whyIds": ["..."] }
  ],
  "leftover": ["<why ids that fit neither>"]
}
```

Prompt outline:

- System: "You cluster distinct threads in a shared Why/What/How context tree.
  Threads are 'distinct' when the roles that care about them barely overlap
  (e.g. product-strategy vs. engineering-implementation). Return STRICT JSON."
- User: current workstream JSON (id + text only, via `stripWorkstreamForPrompt`)
  plus the list of role names / responsibilities as hints for what natural
  clusters look like in this org.
- Output rules: 2-4 splits, each with a 2-4 word name, a one-sentence rationale,
  and the `whyIds` that belong to it. `whyIds` must be disjoint across splits.
  Empty `splits` is valid — means "no clean split; leave it as one workstream."

### CLI surface

```
teamctx workstream suggest              # AI dry-run, prints proposal
teamctx workstream split                # interactive: accept splits, name them, move roles
teamctx workstream list                 # list workstreams + role counts + active
teamctx workstream use <id>             # set activeWorkstream
teamctx role assign <slug> --workstream <id>
teamctx contribute "..." --workstream <id>       # override active
teamctx ask "..." --workstream <id>              # override active
```

`workstream split` is the manager-facing atom. It internally calls
`proposeSubworkstreams`, then for each proposed split asks:

1. "Create workstream **Product** with these 4 Why nodes? (y/n/rename)"
2. If y: create the file, move nodes, ask "Move any roles to this workstream? [space to select]"
3. Commit each accepted split as one commit: `workstream: split "Product" from main`

Non-interactive `workstream split --accept-all` (for CI / power users) accepts
every proposed split with AI-suggested names.

### File surgery, atomically

When a split is accepted:

1. Read source workstream (usually `main`).
2. Compute two trees:
   - New workstream: all `whys` in `whyIds` (structural clone, ids preserved).
   - Source workstream (updated): source minus those whys.
3. Write both files.
4. Regenerate `context/workstreams/<id>.md` for both.
5. For roles that were reassigned: regenerate their `.md` from the new
   workstream.
6. Update `config.workstreams` and reassigned `roles[].workstream`. Write config.
7. Single `commitContext` for the whole split.

If step 3+ fails, we've written one JSON file — do the writes in a temp file
and rename, and write in an order (new file → config → source overwrite → md
regens) where a mid-flight failure leaves a coherent state. Manager can rerun
if the second half didn't complete.

## Files touched

New:

- `src/workstreams.js` — `readWorkstream`, `writeWorkstream`, `listWorkstreams`,
  `migrateIfNeeded`, `splitWorkstream`, `assignRole`.
- `src/workstreams.test.js`
- `cli/commands/workstream.js` — `suggest`, `split`, `list`, `use` subcommands.
- `src/subworkstreams-ai.js` — `proposeSubworkstreams`. (Or fold into
  `src/context.js` if the file stays short; decide at write time.)
- `docs/superpowers/plans/2026-07-09-sub-workstreams.md` — this file.

Modified:

- `src/storage.js` — add `readWorkstream(id, dir)`, `writeWorkstream(id, ws, dir)`,
  `listWorkstreamFiles(dir)`, `writeWorkstreamMd(id, md, dir)`. Keep
  `readShared` / `writeShared` as `main`-aliased wrappers.
- `src/context.js` — add `proposeSubworkstreams` (or import from new file).
  `generateRoleFile` takes the role's assigned workstream, not `readShared`.
- `cli/index.js` — register `workstream` command tree; add `--workstream` option
  to `contribute` and `ask`; add `role assign`.
- `cli/commands/contribute.js` — resolve target workstream from
  `--workstream` > `config.activeWorkstream` > `main`.
- `cli/commands/ask.js` — same resolution.
- `cli/commands/role.js` — accept `--workstream`; `assign` subcommand.
- `cli/commands/init.js` — write `config.workstreams = [{ id: 'main', name: <project>, createdAt }]`
  and `config.activeWorkstream = 'main'` on fresh init (no migration path
  needed).
- `cli/commands/reflect.js` — takes `--workstream <id>` (default: active).
  Reflection is per-workstream; running it on `main` after a split only touches
  `main`.
- `mcp/server.js` — **not touched in this PR** (see follow-up).
- `CHANGELOG.md` — one bullet under `[Unreleased]`.
- `README.md` — one short section on multi-workstream projects, pointing at the
  `workstream` command.

## Testing plan

- `src/workstreams.test.js`
  - `migrateIfNeeded`: pre-migration filesystem → post-migration filesystem,
    config diff, idempotent on second run.
  - `splitWorkstream`: whyIds moved, source shrinks, ids preserved, config
    updated, two files present.
  - `assignRole`: role's workstream updated, role file regenerated from the
    new workstream.
- `src/context.test.js`
  - `proposeSubworkstreams`: mock `callClaude` to return a canned proposal;
    assert the parsed shape and that disjoint-ids invariant is checked.
- `cli/commands/workstream.test.js` (if needed) — one happy-path integration
  test for `split` with a scripted stdin.
- Existing role, contribute, ask, reflect, mcp tests must still pass — the
  wrappers for `readShared` / `writeShared` are the seam that keeps them green.

## Commit strategy

Small, single-author, DCO-signed. Rough order:

1. `docs(plan): add sub-workstreams implementation plan` — this file.
2. `feat(storage): add workstream read/write primitives; keep shared aliases` —
   `src/storage.js` + tests. No behavior change; pure additive.
3. `feat(migration): lazily migrate shared.json → workstreams/main.json` —
   `migrateIfNeeded`, one-shot, idempotent. Ships behind normal load path.
4. `feat(ai): add proposeSubworkstreams to context.js` — prompt + parse + tests.
5. `feat(cli): teamctx workstream suggest|list|use` — read-only surface first.
6. `feat(cli): teamctx workstream split` — the interactive core.
7. `feat(cli): teamctx role assign; --workstream on contribute/ask/reflect` —
   role rebinding + active-workstream override.
8. `feat(init): write workstreams config on fresh init`.
9. `docs: README section on multi-workstream projects`.
10. `chore: CHANGELOG entry`.

Each commit passes `npm test`. No commit reintroduces the flat `shared.json`
world.

## Open questions to resolve while implementing

- **Should `contribute` be allowed to target a workstream you're not `use`d
  into?** Leaning yes — `--workstream` is an explicit override; the active
  workstream is a default, not a lock.
- **Should `proposeSubworkstreams` see role names as hints, or only the tree?**
  Leaning: see them. The whole point is to split along role-value lines. But
  make it robust to zero roles.
- **Migration commit message when there's a git remote and auto-push is on:**
  push? Leaning: yes, one-time migration is a normal auto-push event.
- **Naming: `activeWorkstream` vs. `defaultWorkstream`?** Leaning `activeWorkstream` —
  it changes with `workstream use`, which reads as "active" not "default."

## Follow-ups (not this PR)

- MCP: add optional `workstream` arg to `get_context`, `get_role_context`
  (via the role's assigned workstream — already implicit), `ask`,
  `submit_contribution`. `get_workstreams` as a new tool.
- Web `/context/<role>` unchanged (still keyed by role slug). Consider
  `/workstream/<id>` for public workstream tree pages — separate proposal.
- `workstream merge` and `workstream delete` when we've seen enough real usage
  to know the right ergonomics.
- Sub-sub-workstreams (nesting via `parentId`) if a real team asks.
