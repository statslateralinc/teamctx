# Sub-workstreams

A single teamctx project can hold multiple **workstreams** — independent
Why / What / How trees for distinct threads of work. Each role is bound to
one workstream, so a role's compiled context file stays sharp instead of
mixing unrelated threads.

New projects start with a single workstream, `main`. When the tree grows to
mix threads (e.g. product strategy vs. technical architecture), the AI can
propose a split, and you keep the manager in the loop for every decision.

- [When to use them](#when-to-use-them)
- [End-to-end example](#end-to-end-example)
- [Command reference](#command-reference)
- [How workstreams change `.teamctx/` on disk](#how-workstreams-change-teamctx-on-disk)
- [Migrating an existing project](#migrating-an-existing-project)
- [Notes and limits](#notes-and-limits)

## When to use them

Split into sub-workstreams when both of the following are true:

- The current tree mixes two or more threads that don't share stakeholders
  (e.g. a CPO and a Staff Engineer would each ignore ~half of the tree).
- The role-specific context files have started to feel diluted — a role's
  `.md` includes lines that role would never act on.

If neither is true, one workstream is fine. Splitting too early adds
overhead without sharpening any single role's context.

## End-to-end example

Assume you already have a `main` workstream with a mix of product and
technical Why nodes.

```bash
# 1. Dry-run — the AI proposes splits without touching anything.
teamctx workstream suggest

# 2. Accept them interactively. For each proposed split you'll be asked
#    to accept as-is, rename, or skip; then whether to move any roles.
teamctx workstream split

# 3. Confirm the result.
teamctx workstream list

# 4. New contributions and questions can target a specific workstream.
teamctx workstream use product              # change the default target
teamctx contribute "Signed Acme as a design partner" --workstream product
teamctx ask "What's the migration plan?" --workstream tech
```

Each accepted split lands as its own git commit
(`workstream: split "Product" from main`), so you can revert a single
split without undoing the others.

## Command reference

### `teamctx workstream suggest`

Analyzes the active workstream and prints candidate splits with a short
rationale for each. Does not modify anything.

```bash
teamctx workstream suggest
```

The AI proposes 0-4 splits. If no clean split exists, you'll see
`No clean split proposed. The current workstream reads as one thread.`

### `teamctx workstream split`

Runs the same analysis and then interactively applies the accepted splits.

```bash
teamctx workstream split
teamctx workstream split --accept-all       # non-interactive
```

For each proposal:

1. **Accept?** — `y` accepts as-is, `rename` prompts for a new name, `n`
   skips the split entirely.
2. **Move any roles?** — comma-separated slugs of roles currently on the
   source workstream. Leave blank to keep every role in place.

Each accepted split:

- Creates `.teamctx/workstreams/<id>.json` with the moved Why nodes
  (their ids and history preserved).
- Removes those nodes from the source workstream.
- Regenerates markdown for both the new and source workstreams.
- Regenerates role files for every role that could have been affected
  (moved to the new workstream, or still on the source).
- Commits as one git commit named `workstream: split "<Name>" from <source>`.

`--accept-all` accepts every proposal with the AI-suggested names and
skips the role-move prompt — useful for scripted setups.

### `teamctx workstream list`

Lists every workstream with its Why count and assigned roles. The active
workstream is marked with `*`.

```bash
teamctx workstream list
```

Sample output:

```
Workstreams for "Acme":

  * main             Acme
      3 Why nodes · roles: (none)
    product          Product
      4 Why nodes · roles: cpo, head-of-design
    tech             Tech Platform
      2 Why nodes · roles: staff-engineer
```

### `teamctx workstream use <id>`

Sets the active workstream — the default target for `contribute`, `ask`,
`reflect`, and `role add`.

```bash
teamctx workstream use tech
```

### `teamctx role assign <slug> --workstream <id>`

Moves a role to a different workstream and regenerates its role file from
the new workstream's tree.

```bash
teamctx role assign cpo --workstream product
```

### `--workstream <id>` on other commands

Any command that reads or writes a Why/What/How tree accepts an explicit
target that overrides the active workstream for that single invocation:

```bash
teamctx contribute "..." --workstream product
teamctx ask       "..." --workstream tech
teamctx reflect         --workstream tech
teamctx role add        --workstream product
```

`teamctx ask --role <slug>` — with no `--workstream` — uses the role's
assigned workstream automatically. This is usually what you want: the
role file was generated from that workstream, so the answer stays
consistent with the file.

## How workstreams change `.teamctx/` on disk

Before you split, a project has:

```
.teamctx/
  config.json
  workstreams/
    main.json
  context/
    workstreams/
      main.md
    roles/
      <slug>.md
  contributions.jsonl
```

After a split creates a `product` workstream:

```
.teamctx/
  config.json                       # +workstreams entry, +active, updated role bindings
  workstreams/
    main.json                       # source, minus the moved Whys
    product.json                    # new
  context/
    workstreams/
      main.md                       # regenerated
      product.md                    # new
    roles/
      <slug>.md                     # regenerated for affected roles
  contributions.jsonl               # unchanged (append-only log)
```

`config.json` gains three fields:

```json
{
  "workstreams": [
    { "id": "main",    "name": "Acme",    "createdAt": "..." },
    { "id": "product", "name": "Product", "createdAt": "..." }
  ],
  "activeWorkstream": "main",
  "roles": [
    { "slug": "cpo", "name": "CPO", "workstream": "product", ... }
  ]
}
```

Every role has a `workstream` field. Role files are generated from that
workstream's tree only, so a change to `tech` never rewrites the CPO's
file, and vice versa.

## Migrating an existing project

Projects created before workstreams shipped are migrated automatically
the first time you run any command in them. The migration is idempotent
and safe to re-run.

What happens on first run:

- `.teamctx/shared.json` → `.teamctx/workstreams/main.json`.
- `.teamctx/context/shared.md` → `.teamctx/context/workstreams/main.md`.
- `config.json` gains
  `workstreams: [{ id: "main", name: <project>, createdAt: ... }]`,
  `activeWorkstream: "main"`, and `workstreamsMigrated: true`.
- Every existing role is bound to `main` unless it already has an explicit
  `workstream` field.
- The old `shared.json` and `context/shared.md` are removed.

There is nothing manual to do. Your next `teamctx contribute` (or any
other command) will run against the new layout transparently.

## Notes and limits

- **Ids** are auto-derived from workstream names (e.g. `Product Strategy`
  → `product-strategy`). If a proposed name collides with an existing id,
  the split is skipped with an error — rerun `workstream split` and
  choose `rename`.
- **Contributions** always target one workstream at a time. Cross-cutting
  updates should be split into per-workstream contributions.
- **Reflect** is per-workstream. Running `teamctx reflect --workstream
  tech` never touches `product` or its role files.
- **Web layer** (`/context/<role>`, `/contribute`, `/ask`) is unchanged
  and still keyed by role slug — non-technical teammates don't need to
  know workstreams exist.
- **Deleting or merging** workstreams is not yet supported. If you accept
  a split you regret, `git revert` the split commit.
- **Nested sub-workstreams** are not supported. Workstreams are peers.
