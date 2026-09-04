# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Asking who the manager is answered "nobody" for projects that had one.**
  `get_status` and `get_config` both read `config.manager`, the legacy
  display-name field, which is empty on every project created since the gate
  moved to `managerKey` — so an assistant asked "who can approve here?" reported
  `manager: null` while the gate was set and working. Both now report the gate,
  with the display name kept as `managerDisplayName`. They are fixed and tested
  together, because fixing one and not the other is how this survived being
  found twice.
- **A broken manager gate now says so.** The refusal named the caller and
  refused them in the same sentence — "only the configured manager
  (name:Ada Lovelace) may approve or reject. You are Ada Lovelace
  (github:123818561)" — which reads as a contradiction rather than a problem
  with the project. It now says the gate is a display name, that nobody can
  match one, and what to run. `teamctx config manager` says it unprompted too,
  since every approval on such a project is already failing.
- **A project created on the web was born with a gate its own creator could not
  pass.** `init` ran inside a session but with no ambient actor, so the caller
  resolved from `config.me` to `name:<display name>` — a key nobody can present
  again, since the hosted server knows people as `github:<id>` and a Google
  sign-in as `git:<email>`. Manager-gated commands were refused to the person
  who created the project. The web flow now passes the identity explicitly, as
  `git:<email>` so the same person is recognised whether they return through
  GitHub or Google, and `init` refuses a display-name identity outright rather
  than writing a gate that cannot be matched.
- **`get_config` answered "no manager" for a project that had one.** `manager`
  is the legacy display-name field and is usually empty; the identity lives in
  `managerKey`. It now answers the question that was asked, with the display
  name still available as `managerDisplayName`.
- **`/oauth/status` says whether Google sign-in is configured.** Without
  `GOOGLE_OAUTH_CLIENT_ID` the `/authorize` step skips the account chooser and
  goes straight to GitHub — correct, but silent, so it reads as the chooser
  being broken rather than switched off. Nothing reported it either way.
- **Naming a project something that already exists dead-ended on GitHub's API
  wording.** The manager asked for a project name, not a repository, and "name
  already exists on this account" is not something they can act on — yet it is
  the most reachable failure in new-project onboarding, because retrying the
  same name after any error is what people do. The page now says which account
  already has that project, and offers a name that is free for them to click.
  Nothing is suggested unless GitHub actually confirmed it is available: a rate
  limit is not a free name, and offering one would send the manager back into
  the same failure. Being unable to create in an organisation says that, and
  says to pick a personal account or ask an owner. Closes #58.
- **The settings page read as one long document.** Three sections, each a
  top-level heading separated by a horizontal rule, in a column narrow enough
  that they could only stack — and the first had no heading at all, so it looked
  like a continuation of the header. "Create a new project" sat above the
  settings, ahead of whatever you actually came to change. It is now one page
  heading with three cards that lay out side by side when there is room, the
  new-project link has moved into the header where the other navigation is, and
  there is a way back to the home page. The GitHub login in the header is
  escaped, which it was not.
  Four things found by looking at it: the project dropdown rendered its list
  white-on-white, because a transparent select opts out of the colour scheme and
  the popup is painted by the OS — the options were there, invisible, findable
  only by the scrollbar beside them. Three cards of different heights in a
  two-column grid left a hole under the short one, so they pack in columns now.
  The header spread its links across the full width. And the whole thing was
  black and white, with no focus ring on any control.
  The project field also lets you type to narrow it. A `select` only jumps to
  the first letter, so finding one repository among dozens meant scrolling —
  and it could not accept a name the capped listing had missed. Each picker
  gets its own list, since two sharing an id leaves the second empty. In the
  header, a link that goes somewhere, an action that makes something and the
  account you are signed in as no longer look identical, and the account sits at
  the edge of the column rather than in the middle of the actions.
  The home page's call to action was a `<button>` inside an `<a>`, which is
  invalid and renders as one stretched control with whatever follows jammed
  against it. Both are styled links now.
  All of which the pages now share: one navigation bar — Home, Settings, New
  project — on every page, marking the one you are looking at. Each page carried
  its own header before, so the links differed by page and none of them said
  where you were. Signed out it offers only what is reachable: Settings and New
  project both bounce to sign-in, and showing them is a dead end dressed as a
  choice. The sign-in, error, project-created and retry pages carry it too —
  each was a dead end with no way back to the page explaining what you were
  signing into. Part of #66.
- **The recipe guide asserted what a client can and cannot do.** "ChatGPT can't
  run `teamctx` for you" was scoped to the recipes, which are copy-paste by
  nature, but read as a blanket claim, and was never revisited when the hosted
  MCP server landed. The loop is agent-agnostic — nothing in it is specific to
  one client — so the page now describes what the recipe flow is, points at the
  connector as the route that needs no terminal, and leaves what a client
  supports to that client. Part of #46.
- **A team member could make themselves the manager.** `config_set` accepted
  `manager` and `managerKey`, and nothing checked who was asking — so someone
  invited with deliberately reduced, roster-gated access could grant themselves
  approval rights and then sign off their own submissions, which is the whole
  trust boundary the invite exists to draw. The gate is now pinned at `init` to
  whoever sets the project up and is not writable afterwards: both keys are off
  `config_set`'s writable surface and `teamctx config manager` is gone, so there
  is no reachable path rather than a gated one. `init` pins to the caller's
  identity rather than the name they type, since a display name is settable by
  its owner. A project with no manager recorded still accepts the first one,
  which is how an existing project adopts the gate.
- **One person is now recognised on every surface they connect from.** An actor
  key depended on how you arrived — `git:<email>` from a clone, `github:<id>`
  from the hosted server — so a manager gate pinned from a laptop refused the
  same person in a chat client, and would have refused them again signing in
  with Google. An email address is the one identity all three can agree on, so
  teamctx now asks GitHub for `user:email`, reads the account's *verified*
  primary address (an unverified one would let somebody claim a gate pinned to
  an address they do not own), and matches a `git:<email>` gate against it.
  A Google sign-in resolves into that same namespace, and the manager no longer
  needs a roster entry to use it — they were being turned away from their own
  project for signing in the way they tell everyone else to.
  **Existing hosted sessions must authorise once more** to pick up the new
  scope; until then they are matched by numeric id, which still works.
  `teamctx config manager --add <ref>` adds an identity other than the one in
  use, for a gate that predates this.
- **The manager could be locked out of their own project.** An actor key
  depends on how you connected — a clone resolves you from `git config` as
  `git:<email>`, the hosted server resolves you from GitHub OAuth as
  `github:<id>` — and the gate compared one stored key exactly. So pinning the
  gate from a laptop and then reaching the project from a chat client refused
  you your own project, which is now the ordinary way to work. The gate reads
  `managerKeys` as well as `managerKey`, and `teamctx config manager --add-me`
  adds the identity you are using now. `teamctx config manager` with no
  arguments says when the gate does not recognise you, instead of leaving it to
  be discovered at the moment of approving something.
- **Lending a project GitHub access asked for the wrong thing.** It required
  repository admin, a permission bit standing in for the question actually
  being asked, and every failure to answer it — including a session with no
  token, and a rate limit — reported "you need admin access", told to people who
  had it. Admin or being the project manager now qualifies, matched against
  every identity the gate knows, and each failure says what actually happened.
- **`init` over the hosted MCP server crashed instead of bootstrapping a
  project.** `initProject` was the one write path with no hosted branch: it ran
  `join(projectDir, '.teamctx')` first, and in hosted mode `projectDir` is the
  `{__backend:'github'}` context object, so it threw `The "path" argument must
  be of type string` before touching anything. It now branches on
  `getCurrentSession()` the way every other write path already does, writing
  through the GitHub adapter rather than `mkdirSync`/`writeFileSync`. You could
  not start a new project through the hosted surface at all before this.
  Fixes #32.
- Ten mutating MCP handlers passed `projectDir: projectRoot` rather than the
  hosted-safe `gitCwd`. Harmless in practice — everything they reach checks for
  an ambient session before using `cwd` — but that guard was the only thing
  keeping the context object away from git, which is the wrong place to rely on.
- The init commit made over MCP now reads `chore: initialize teamctx for "…"
  (via mcp)`, matching the `(via mcp)` note `contribute` already appends. A repo
  bootstrapped from a chat client has no local checkout and no shell, so the
  history was the only record of where the commit came from — and it did not say.

### Added
- **`teamctx config manager --repair`**, for projects created on the web before
  #71 pinned their manager gate to `name:<display name>` — a value nobody can
  match, so the creator was locked out of their own project with no way back
  short of knowing to hand-edit `.teamctx/config.json`. Two of the three real
  projects from onboarding testing carried one.
  It re-pins the gate to the caller's own identity, and refuses unless two things
  hold: the gate is a display name, and the caller is the project's creator. The
  second matters because "the gate is already open" justifies passing it, not
  taking it — repair turns "anyone may approve" into "only this person may", so
  unguarded the first to run it takes the project and locks out the one it was
  for. The creator is read from the repository rather than the config: the
  author of the commit that added `.teamctx/config.json` ran `init`, and
  history cannot be rewritten without the push access repair already needs. A
  display name is the fallback when that history cannot be read.
  Available from a chat client as well as the CLI, which is where it matters
  most — there is no clone there to fall back on and no file to edit by hand.
  Hosted callers read the creator from the commits API rather than `git log`.
  A token that cannot reveal its owner's email is treated as *unknown* rather
  than as a mismatch, since calling it one would refuse the creator on the one
  surface where they have no other way in.
  The repaired gate is pinned to the caller's **email**, not to whatever key
  their surface happens to use — a hosted GitHub caller resolves to
  `github:<id>`, and pinning that would rebuild the single-surface gate #71
  existed to remove, locking the same person out the moment they signed in with
  Google. Where only an id could be pinned, it says so rather than leaving a
  half-fix looking like a whole one. That refusal is the whole safety argument: against
  a working gate this would be the privilege escalation #49 removed. It is safe
  because a `name:` gate is *already* open — the value comes from `config.me`,
  which is committed and shared, so anyone with the repository and no local git
  identity already presents that key and passes. Repair does not open a door;
  the door is open, and repair closes it.
  CLI only, deliberately. Repairing needs a clone, which needs the push access
  hand-editing would need anyway, so it grants nothing new — whereas over MCP it
  would be reachable by a member acting on the project's *lent* credential,
  which has push access while the member is emphatically not the manager.
  Closes #73.
- **A project no longer starts out knowing nothing.** A workstream is created
  with no whys and nothing pushed it out of that state, so the rendered context
  read "No context yet" until somebody contributed — a manager finished setup,
  connected, and found a project that knew nothing about their work. The
  guidance now names the founding contribution: when `get_status` reports
  `totalWhys: 0`, the agent calls `contribute` with `apply: true` so the opening
  message lands rather than queueing for the manager to approve their own words,
  with nothing yet to review it against. Every later contribution still queues.
  The condition rather than "just after `init`", so it covers a manager seeding
  a project in the turn they made it and one returning to a project left empty.
  No new tool and no schema change: `contribute` already took `apply: true`,
  already gated it to the manager, and already distils free text into the tree.
  `contribute`'s own description carries a short version, because this trigger
  is a condition rather than a tool and so has no natural fallback in a client
  that ignores the server's instructions. Closes #70.
- **The MCP server now tells a connected agent when to reach for what.** It
  shipped 41 tools and an empty `instructions` field — the one place MCP gives a
  server to speak to the model before any tool call. A host had the whole
  surface and no way to sequence it, so walking a manager through setup it did
  what an agent does when it cannot tell what to do next: explained teamctx's
  data model — workstream, why-tree, compile — to somebody who had never asked
  to learn it. The server now sends the two sequences that actually occur (a
  manager setting a project up, somebody picking work up) and the rules that
  stop the common wrong turns: act rather than explain, keep the internal
  vocabulary out of the conversation, and say a contribution was *sent for
  review* rather than added. The tool descriptions carry the same guidance
  per-tool, because whether a host surfaces `instructions` to its model is that
  host's business and varies. Closes #59.
- **Pick a project instead of spelling one, and share the key you already
  saved.** The share and lend forms asked for `owner/repo` as free text, so
  setting either meant remembering the exact spelling of a repository you had
  already chosen once — and a typo stored a setting against a project that does
  not exist, which fails silently later rather than at the point of the mistake.
  Both now offer the repositories your token can push to, read-only ones left
  out because offering a choice that gets refused a click later reads as a bug.
  Sharing also gained "share the key I already saved": a provider shows an API
  key once, so asking for it a second time assumes you kept it. The two forms
  stay separate on purpose — a personal key and a project key are how you tell
  your own spend from the team's. Part of #66.
- **Start from a repository you already have.** New-project onboarding could
  only create one, so somebody who already had a repo was made to make a second.
  It is the same path a failed-init retry already used — skip creation, run
  `init` — so picking one from the list is all that was missing. A repo that is
  already a teamctx project says so and names which, rather than reporting the
  failure from inside `init`.
- **The project-created page continues the flow instead of ending it.** It gave
  the connector URL and stopped, which read as finished. It now says what to do
  in that chat — describe the project, turn it into tasks, invite whoever is
  doing it, review what comes back — and that the last pair is the loop rather
  than the end of setup. Part of #66.
- **A front door.** It describes the whole tree — why a team decided something,
  what that requires, how it gets done — and the per-role slice, rather than
  only the top level. There was no `/` route at all — every path started at
  `/settings`, which assumes you already know what teamctx is and that you have
  a repository, so a manager sent the deployment URL had nowhere to arrive. The
  landing page says what teamctx is, lays out the five steps in order rather
  than revealing them one click at a time, and makes clear the work does not
  stop at setup: teams keep pulling context and sending work back, and the
  manager keeps reviewing. Signed in, the button continues where they left off.
  `vercel.json` routes `/` to the server, without which the route would have
  404'd in production while working locally.
  Signed in, it stops being an explainer and becomes a hallway: it lists the
  projects you have configured, deduplicated across the ones you share a key
  with and the ones you lend access to, and links to settings plainly rather
  than behind a vague "continue". One account can hold many projects — the
  per-project settings live as rows on the one settings page, so every project
  links to the same place. Part of #66.
- **"What are my tasks?"** — `list_tasks` and `teamctx task list` take `mine`
  / `--mine`. The task loop shipped in #47 worked from the second step onward;
  the first one needed the caller to already know the exact display name this
  project has for them, which an assistant can only guess at. Tasks now record
  an `ownerKey` when raised for the caller, so `mine` matches on identity as
  well as name: a display name changes with `teamctx config name` and differs
  between a clone and a chat client, either of which would quietly stop a
  member's own work being theirs. Existing tasks carry no key and still match by
  name. `mine` with `owner` is an error rather than an intersection. Part of #46.
- **Team members no longer need a GitHub account.** GitHub is where a teamctx
  project is stored, not who the people on it are, but joining one meant opening
  a GitHub account, being added as a collaborator, and authorising GitHub OAuth
  — which for a non-technical member was the whole onboarding blocker.
  A member invited by email can now sign in with Google. teamctx does not verify
  addresses itself: it reads `email_verified` from Google and refuses anything
  else, because a Google account can be created against an address its holder
  does not control. The verified address must then match a roster entry, or any
  Google account would be a member of every project.
  Such a member has no GitHub token, so the project lends one: the manager
  stores a credential from `/settings`, pinned to a single repository and usable
  only by people the roster names. Commits are attributed to the member, and
  their contributions still queue for the manager's review — `assertManager`
  compares the resolved actor against `managerKey`, which a member never is.
  Both halves are optional. Without `GOOGLE_OAUTH_CLIENT_ID` the sign-in flow
  goes straight to GitHub exactly as before. See `docs/mcp-hosted-setup.md`.
- **Project members.** `teamctx member add <username|email>`, `member list`,
  `member rm`, plus `list_members`, `member_add` and `member_rm` over MCP. A
  teamctx project knew its manager and, implicitly, anyone holding a clone — it
  had no idea who the team was, so contributions carried whatever
  `git config user.name` said and task owners were free text.
  Adding and removing are **manager-gated**. A member record reuses the actor
  key from `src/actor.js` rather than inventing an identity scheme, so a member
  joins up with contributions they have already made and with the `authorKey`
  grouping `teamctx stats` counts by. Members are project-wide: workstreams are
  a view over one repo, so per-workstream membership would enforce nothing.
  `--invite` / `invite: true` also invites a GitHub collaborator — via `gh`
  locally, or the caller's OAuth token when hosted, both of which already carry
  the `repo` scope that needs. Only a username can be invited; GitHub's
  collaborator endpoint takes no email address. The invitation is asynchronous
  and must be accepted, and a failed invite still leaves the member on the
  roster rather than discarding the manager's intent. `member rm` takes someone
  off the roster and deliberately does **not** revoke repository access.
- **Commits record an author separate from the committer.** The Git Data API
  has always accepted both; teamctx sent neither, so every hosted write was
  attributed to whoever's token made it and a whole team read as a single
  contributor in `git log`. The author is now the acting person, via the
  `<id>+<login>@users.noreply.github.com` form GitHub itself issues.
- **`get_connect_url`** over MCP, alongside `teamctx connect`. The manager is
  the one who hands the URL out and increasingly does it from a chat client,
  where the CLI is not reachable.

### Fixed
- **`config_set` reported success without persisting.** A hosted write lands in
  the session's in-memory copy of the repo, and this was the one mutating tool
  that never committed — so the request ended, the change was gone, and the tool
  said it had worked. Setting `deployUrl` from an assistant read back empty.
  Personal settings still do not commit: a display name is stored against the
  caller, and committing it would rename them for everyone.
  `reportBack` now says whether the change reached the repo, and `committed`
  reports the commit that was made rather than the one that was attempted. The
  tool description tells clients to read `reportBack` out verbatim, so a success
  string that did not depend on the write was a false success said aloud — which
  is how the missing commit went unnoticed in the first place.
- **`teamctx connect`** prints the URL a team member pastes into their AI
  client. Both halves of it already existed and nothing joined them: the
  deployment origin sits in `config.json`, the owner and repo in the git
  remote. Assembling them was left to whoever was handing the URL over, from
  memory — which is how it went the first time an invited member was walked
  through joining, live on a call. The repo is read from the remote rather than
  config so it stays right through a rename, and a trailing slash on the deploy
  URL is tolerated because it is pasted out of a browser as often as typed.
  New: `docs/mcp-join.md`, the same path written from the joining member's side.
  Part of #44.
- **Tasks over MCP.** All eight task commands are now tools: `list_tasks`,
  `get_task`, `task_add`, `task_done`, `task_reopen`, `task_assign`, `task_rm`
  and `task_compile`. The server described itself as covering the full CLI and
  omitted every one of them — which mattered because `task compile` is the
  command that turns shared context into something a person can act on, so a
  manager could run everything from their assistant right up to the point of
  doing the work.
  Only `task_rm` and `task_compile` are marked risky: one deletes with no undo
  short of a git revert, the other spends an AI call and overwrites an existing
  prompt. The rest are field updates on a small JSON file. **None are
  manager-gated** — tasks are work tracking rather than shared context, and
  gating them would stop someone managing their own work from their own
  assistant.
  `task_compile` returns the **compiled markdown**, not just a file path: an MCP
  caller is usually not on the machine holding the file, and the hosted server
  has no working copy at all. It skips the AI call and returns the cached prompt
  with `alreadyCompiled: true` when the workstream's Whys have not moved.
  `task_add` accepts `compile: true` so raising a task and compiling its prompt
  is one call rather than two — the common case in practice, kept opt-in because
  the second half is not free.
  Task operations moved to `cli/commands/task.core.js`, matching
  `contribute.core.js` and `review.core.js`, so the CLI and the server run the
  same code rather than two implementations.
- **A key the manager can share with everyone on a project.** The model-backed
  tools (`ask`, `contribute`, `reflect`, `role_add`, `suggest_*`) needed an AI
  provider key stored against the caller's own GitHub account. Most people on a
  project have neither: they reach it through an agent, and GitHub is where the
  project is *stored*, not who they are. Those tools therefore worked for
  whoever ran `init` and for nobody else. A key shared with `owner/repo` from
  the settings page is now used for any caller who has not brought one of their
  own — it never overrides a key that did arrive with the request, so a member
  paying their own way keeps paying their own way. Sharing needs write access to
  the repo, and only the person who shared a key can replace or remove it.
- **Per-user settings.** Identity and the active workstream are now resolved
  per person instead of being read from the committed `.teamctx/config.json`.
  A new actor context (`src/actor.js`) resolves who is calling — the GitHub
  account that completed OAuth on the hosted server, `git config user.name`
  on the CLI and stdio MCP, falling back to `config.me` — and a preference
  store (`src/prefs.js`) keeps their choices out of the repo: KV when hosted,
  a gitignored `.teamctx/.local/prefs.json` locally.
- `teamctx config manager --me` pins the approval gate to your own identity
  (`managerKey`), which no one else can claim. `@login` and a raw actor key
  also work. A project still holding a display name in `config.manager` keeps
  working, with a warning on every gated action — that form is advisory only,
  since anyone can set that name as their own.
- `config_set name` / `teamctx config name` sets the display name used on your
  own contributions. Personal: it is stored against you and never written to
  the repo. `teamctx config name --clear` drops the override so the name is
  derived from your identity again — and keeps following it if that identity
  changes. (A flag rather than an empty string: PowerShell discards `""`
  before the process sees it.)
- Contributions now carry an `authorKey` alongside `author`, so one person is
  counted once in the `## Contributors` roll-up even when their display name
  differs between the CLI (git name) and the hosted server (GitHub name).
- **`teamctx import <paths…>`** — turn a team's existing `.md` / `.txt` files
  into proposed contributions, so a new project does not start from a blank
  context tree. Each document becomes one contribution, distilled by the
  existing pipeline and left in the manager's review queue — import is not a
  second way into shared context, and nothing is ever applied directly. The
  contribution records which file it came from (`source: import:docs/plan.md`),
  so the audit trail points back at the artifact.
  `--dry-run` lists what would be imported without spending an AI call;
  `--workstream <id>` targets a specific workstream.
  Files that cannot be used (too large, empty, unsupported type) are reported
  with a reason before any distilling starts; a path that does not exist is an
  error rather than a silent no-op.
  Imported files are distilled as *documents* — asked for the whys, decisions
  and constraints that outlive the file, and told to ignore its structure — so
  headings and meeting dates do not become Why nodes. A document carrying no
  durable context adds nothing rather than being padded into a contribution.
  Within one run, each document is told what earlier ones already proposed, so
  three files describing the same decision produce one contribution rather than
  three near-duplicates for the manager to reject. Closes #20.
- **Import connectors.** `teamctx import --from <connector> <selector…>` — a
  connector turns a source into the documents import already knows how to
  distill, and nothing else: no AI calls, no queue writes, no dedupe, all of
  which are shared and already built. `auth → list → fetch`, with `list`
  separate so `--dry-run` can report what would be pulled without downloading
  it. Credentials come from the environment, never from the committed
  `config.json`.
  Local paths resolve to the built-in `folder` connector, so every import
  exercises the contract rather than leaving it to drift until the first remote
  source is written. Whatever a connector returns goes through the same
  document rules a local file does.
  `--since` bounds how far back a connector looks. Meaningless for a folder and
  the difference between a usable import and a drowned review queue for a chat
  or wiki source, so it sits on the shared surface rather than inside one
  connector.
  Individual sources (Slack, Drive, Microsoft 365, Dropbox, Notion, Coda) land
  one PR each on top of this. Design notes:
  [docs/proposals/import-connectors.md](docs/proposals/import-connectors.md).
  Closes #21.
- **Microsoft 365 connector.** `teamctx import --from m365 <sharepoint-url|onedrive-path>`
  — every document beneath a folder becomes one proposed contribution.
  Markdown and text are downloaded; Word documents are unpacked locally,
  because Microsoft Graph offers no conversion to text for any file type.
  Spreadsheets, decks, PDFs and binaries are skipped with a reason, decided
  from listing metadata so nothing unimportable is downloaded.
  `teamctx auth m365` asks whether the account is work or personal and requests
  the matching scopes. This matters: a personal Microsoft account cannot hold
  `Sites.Read.All`, and asking for it fails the whole consent rather than
  granting the rest — so a single hardcoded scope set would lock every consumer
  account out. The tenant that issued the token is saved so refreshes go back to
  the same endpoint, and the rotated refresh token Microsoft returns is kept.
  SharePoint URLs are decomposed into `/sites/{host}:/{path}` rather than sent
  through `/shares`, whose documented least-privileged permission is a *write*
  scope; `/shares` is used only for short links that carry no parseable
  structure. `--since` filters in memory, since `children` supports no
  `$filter`. Setup: [docs/import-m365.md](docs/import-m365.md). Design notes:
  [docs/proposals/import-m365.md](docs/proposals/import-m365.md). Closes #24.
- **Word documents can be read.** `src/formats/docx.js` extracts the text from a
  `.docx` with no new dependency — Node ships `zlib`, and the ZIP central
  directory is walked directly. Text deleted with track changes still on is
  dropped rather than stripped along with its tags: it remains in the file, and
  resurrecting a sentence someone removed on purpose would be worse than
  importing nothing. Field codes go too; inserted text is kept. Used by the
  Microsoft 365 connector, and available to the others.
- **`teamctx auth <connector>`** — log in to an import connector once and keep
  working. It runs the connector's login flow and saves the resulting long-lived
  credentials to `.env.local`.
  Without it, a connector's help can only end with some version of "exchange it
  once for a refresh token", which in practice means "write your own curl
  command" — so the contract gains an optional `authorize` alongside `auth`.
  Optional because it makes no sense for `folder`, and purely additive because
  `auth(env)` still reads the environment: credentials set by hand keep working
  and no existing connector changes. A connector supplies only the
  provider-specific parts; prompting, merging the env file and never printing a
  secret are shared.
  The env file is merged rather than rewritten, so a provider key already living
  there survives; it is written `0600`, only variable *names* are ever printed,
  and a failed login writes nothing. An existing value offered back as a prompt
  default is masked (`sl.u********TAIL`), so re-running the command never echoes
  a live credential into scrollback.
- **Slack connector.** `teamctx import --from slack <channel-id|message-link>`
  — a thread becomes one proposed contribution, because a thread has a topic
  and an ending and is where the reasoning lives. Standalone messages, joins,
  leaves and bot subtypes never reach the distiller; mentions and links are
  rendered as prose so it reads what a human would. Threads are imported
  oldest-first, so a decision is proposed by the thread where it was argued out
  and a later reminder of it adds only what is new.
  A pasted Slack "Copy link" works as a selector, which is how you import the
  one conversation you already know mattered. `--since` bounds the window
  (default 30 days).
  Credentials are the user's own token from `SLACK_TOKEN`, never a shipped app:
  since 29 May 2025 Slack limits distributed non-Marketplace apps to 1 request
  per minute on `conversations.history`, against 50+ for an app the user
  created themselves. Setup is in
  [docs/proposals/import-slack.md](docs/proposals/import-slack.md). Closes #22.
- **Notion connector.** `teamctx import --from notion <page-link|page-id>` — a
  page becomes one proposed contribution, and a *child* page becomes a separate
  one rather than being folded into its parent, so importing a handbook gives a
  manager one reviewable item per page instead of one the size of the handbook.
  Run it with no selector to import everything shared with your integration.
  (The connector honours a `since` window; the `--since` flag that reaches it
  from the command line lands with the Slack connector, #22.)
  Page content is a block tree rather than a body: `blocks/{id}/children`
  returns one level at a time, so blocks, nested toggles, lists, callouts,
  quotes, code and tables are walked and rendered as markdown for the distiller.
  Blocks carrying no text — images, embeds, breadcrumbs — are dropped the way an
  unsupported file inside a directory already is.
  Credentials are your own integration token from `NOTION_TOKEN`. A new
  integration can see nothing until you open a page in Notion and use
  ••• → Add connections; access then cascades to child pages, which means the
  explicit selection the connector contract asks for has already happened in
  Notion's own UI. Requests are paced to Notion's ~3/second and honour
  `Retry-After` on 429 and 529. Databases are reported as skipped rather than
  imported. Design notes:
  [docs/proposals/import-notion.md](docs/proposals/import-notion.md). Closes #26.
- **Coda connector.** `teamctx import --from coda <doc-link|page-link>` — a page
  becomes one proposed contribution. A pasted Coda URL carries both ids, so a
  doc link imports every page in the doc and a page link imports that page plus
  everything nested beneath it, however deep;
  with no selector it walks the docs your token can see. (The connector honours
  a `since` window; the `--since` flag that reaches it from the command line
  lands with the Slack connector, #22.)
  Coda exports markdown itself, so there is no rendering to get wrong — the
  connector runs the export job (begin, poll, download) and hands the result
  straight to the distiller. An export that fails or never finishes fails that
  one document rather than stalling the run, and pages with no exportable
  content (embeds, sync pages) are reported with a reason instead of arriving
  empty.
  Credentials are your own token from `CODA_TOKEN`, generated under Account
  settings → API settings. The export download lands on signed storage rather
  than `coda.io`, and that request deliberately carries no `Authorization`
  header. Requests are paced per rate-limit bucket, since Coda allows ~100 reads
  per 6 seconds against ~10 writes and beginning an export is a write. Design
  notes: [docs/proposals/import-coda.md](docs/proposals/import-coda.md).
  Closes #27.
- **Dropbox connector.** `teamctx import --from dropbox <path|file-id|shared-link>`
  — every document beneath a path becomes one proposed contribution. Markdown
  and text files are downloaded; Dropbox Paper docs are exported as markdown.
  Word documents are reported as skipped rather than half-imported: Dropbox has
  no text conversion, and `files/export` returns `docx` even for a Google Doc
  kept in Dropbox, so both routes need an OOXML reader that does not exist yet.
  Spreadsheets, decks, images and other binaries are skipped with a reason.
  Which files can be fetched, and how, comes from the listing itself —
  `is_downloadable` and `export_info.export_as` — rather than from a table of
  types this project would have to keep current.
  The whole tree arrives in one request (`recursive: true`), so there is no
  folder walk, and `--since` filters on `server_modified` in memory without
  costing an extra call. Oversized files are skipped from the listing, before
  anything is transferred.
  Shared links work, including listing inside a shared folder that is not in
  your own Dropbox. A Paper doc reached that way is reported as unexportable
  while listing rather than failing mid-import.
  Credentials come from `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET` and
  `DROPBOX_REFRESH_TOKEN` (or a short-lived `DROPBOX_ACCESS_TOKEN` on its own),
  exchanged lazily on the first request. `teamctx auth dropbox` obtains them:
  Dropbox's code flow needs no redirect URI, so it shows you a code to paste
  back and nothing on your machine listens on a port. Setup and troubleshooting:
  [docs/import-dropbox.md](docs/import-dropbox.md). Design notes:
  [docs/proposals/import-dropbox.md](docs/proposals/import-dropbox.md).
  Closes #25.
- **`teamctx stats`** — honest team numbers computed entirely from the repo's
  own history. No AI call, no network, no telemetry: contribution cadence by
  author and per week, approval flow with median review wait, days since the
  last contribution per workstream, and task flow. `--since` sets the window
  (default 28 days), `--workstream` narrows every metric rather than only the
  freshness rows, and `--json` prints the raw numbers. Also exposed read-only
  over MCP as `get_stats`, so a manager can ask their AI how the team's context
  habit looks and get grounded numbers instead of a guess.
  One person is counted once even when their display name differs between the
  CLI (git name) and the hosted server (GitHub name) — that is what `authorKey`
  was for.
  Approval latency comes from git rather than the audit log, because approving
  a contribution deletes its queue item and records nothing: there is no
  `approvedAt` anywhere, and `contributions.jsonl` never leaves `logged`. The
  commit that removed the queue file *is* the decision, so one
  `git log --diff-filter=AD` over `.teamctx/queue` yields queued-at and
  decided-at per item with no commit-message parsing. Where that history is
  unreachable — hosted mode has no working copy — those numbers come back
  `null` rather than `0`, since a zero would read as "nothing was ever
  approved". Design notes:
  [docs/proposals/local-metrics.md](docs/proposals/local-metrics.md).
  Closes #28.
  `--waits` lists every review wait, slowest first, marking which ended in a
  rejection; the default view shows the fastest-to-slowest range beside the
  median. A median alone cannot tell "everything reviewed within a day" apart
  from "everything reviewed in an hour except one that sat for a fortnight",
  and the second is the one worth acting on. `get_stats` returns the same list.
- **Google Drive connector.** `teamctx import --from gdrive <folder-link|file-link>`
  — every document beneath a folder becomes one proposed contribution. Google
  Docs are exported as markdown and Slides as text; uploaded `.md` and `.txt`
  are downloaded as they are. Drive has no recursive query, so subfolders are
  walked, and a file that lives in two folders at once is imported once.
  Everything else in a real Drive — photos, video, installers, PDFs, and
  spreadsheets, which Drive can only export as CSV — is reported as skipped with
  a reason. That decision is made from listing metadata, so nothing unimportable
  is ever downloaded and `--dry-run` costs one request for a whole folder.
  `--since` filters server-side on `modifiedTime`, and deliberately never
  filters folders: a folder's own timestamp does not move when a document inside
  it changes, so filtering them would hide the new work being asked for.
  There is no "import everything" form. Notion has one because a Notion
  integration only sees pages you connected by hand; `drive.readonly` sees your
  entire Drive, so the folder or file has to be named.
  Credentials come from `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET` and
  `GDRIVE_REFRESH_TOKEN` (or a bare `GDRIVE_ACCESS_TOKEN` for an hour); the
  `GOOGLE_`-prefixed names are accepted as aliases, and the
  access token is exchanged lazily on the first request rather than in `auth`.
  `teamctx auth gdrive` obtains them: it prints the Cloud project and OAuth
  client setup, opens Google's consent screen against a listener bound to
  `127.0.0.1`, and exchanges the code. Google
  [removed the paste-a-code flow in 2023](https://developers.google.com/identity/protocols/oauth2/resources/oob-migration),
  so a loopback listener is the only supported desktop route — unlike Dropbox,
  which needs no redirect at all. The consent request asks for `access_type=offline`
  *and* `prompt=consent`: without the second, Google omits the refresh token on
  every authorization after the first, so re-running the command to repair a
  broken login would appear to work and change nothing.
  Drive is the one source with no token to copy, and the help warns that a
  consent screen left in "Testing" expires refresh tokens after seven days —
  which is what an `invalid_grant` a week later actually means.
  Setup and troubleshooting: [docs/import-gdrive.md](docs/import-gdrive.md).
  Design notes:
  [docs/proposals/import-gdrive.md](docs/proposals/import-gdrive.md). Closes #23.

### Changed
- **Contributions record where they came from in the git history.** The commit
  body carries `Source: import:docs/plan.md` (or `web`, `mcp`, and
  `import:<id>` for whatever a connector returns) on the queue commit and again
  when a manager approves it. Previously only `mcp` was named, and only on the
  applied path, so an imported contribution was indistinguishable from a typed
  one in `git log .teamctx/` — which is the audit trail, and what `teamctx
  stats` will walk. In the body rather than the subject: a remote id can run to
  `import:slack:C0421/p1699887654123456`, and truncating it to fit a subject
  destroys the one property worth recording, that you can follow it back to the
  artifact. A typed contribution still says nothing.
- `workstream_use` / `teamctx workstream use` now records a personal
  preference. It no longer writes `activeWorkstream` to the shared config, and
  no longer creates a commit — switching workstream stopped moving everyone
  else's default. `config.activeWorkstream` remains the project default for
  anyone who has not switched, so existing projects behave as before.
- `get_status` and `get_config` return `me` and `activeWorkstream` resolved
  for the calling user, with the repo's values under `projectDefaults`.
  `get_status.meSource` reports where the *name* came from (`override` when the
  user set their own), and `actorSource` where the caller was authenticated.
- `teamctx init` pre-fills the name prompt from the git identity and records
  the chosen handle as the initializer's own preference.

### Fixed
- `reflect` now rejects unknown workstream ids instead of creating empty
  workstream stubs.
- `teamctx pull` threw a `ReferenceError` when applying a contribution from
  another author — it compared against an undefined `me`.
- A saved AI provider key was applied against the provider named in the
  project's shared config rather than the one it belongs to — an OpenAI key
  was handed to the Anthropic client. The stored provider now travels with
  the key, and the model follows it.
- **The approval gate is now bound to an identity, not a display name.**
  `canApprove` compared `config.me` against `config.manager` — two strings from
  the same shared file — so on a multi-user deployment it let everyone through
  or nobody, depending on who ran `init`. It now compares the authenticated
  caller's actor key against `config.managerKey`.
- **`review_approve` / `review_reject` / `snapshot_approve` / `snapshot_reject`
  no longer accept an `author` argument.** It was a caller-supplied claim used
  as the identity for the gate check, so any hosted caller could pass
  `author: "<manager's name>"` and through. The gate now reads the
  authenticated actor and nothing else; `author` remains on `contribute` for
  attribution only, where it grants no authority.

## [0.3.0] - 2026-08-07

### Added
- **Hosted, multi-tenant MCP server.** Deploy once to Vercel and any number
  of users connect over `https://<deployment>/api/mcp/<owner>/<repo>` with
  zero local install — no tokens, no PATs, no files on their machine. Full
  OAuth 2.1 authorization server (`api/oauth-server.js`) proxying GitHub as
  identity provider, with dynamic client registration, PKCE, one-shot
  authorization codes, and rotating refresh tokens. A GitHub-backed storage
  adapter (`src/adapters/github.js`) reads and writes `.teamctx/` via the
  Git Data API for atomic, attributed commits — no server-side git clone.
  Per-request `AsyncLocalStorage` isolation for both the caller's GitHub
  session and their saved AI provider key, safe under Vercel Fluid Compute's
  instance reuse. Setup guide: [docs/mcp-hosted-setup.md](docs/mcp-hosted-setup.md).
  Self-hosting single-tenant (one deployment, one repo, env-var credentials)
  remains supported with no OAuth required.
- **Per-answer contribution attribution on `ask`.** Every
  `teamctx ask "..."` answer ends with a one-line summary of the
  contributors whose material the AI actually cited for this specific
  answer (capped at top 5). The tree passed to the AI is annotated with
  inline `[sources: c-x]` tags, and the AI is asked to end its answer with
  a `## Citations: c-x, c-y` block that teamctx parses and strips. No
  second API call.
- **`ask --audit`** expands the footer into the full source list for the
  contributions the AI cited — author, date, source system, decision tag,
  and text snippet, uncapped. Same one-call flow, richer rendering.
- **Compiled workstream markdown** gains a `## Contributors` section at
  the bottom, listing distinct authors with counts. Same source of truth
  as the `ask` footer.
- **MCP `ask` tool** gains an optional `audit: boolean` argument that
  mirrors the CLI flag.
- **Web `/ask` endpoint** accepts an `audit` field on the POST body
  (`true`/`1`/`on`/`yes` all count).
- **`teamctx reflect` preserves provenance.** When the AI-rewritten tree
  keeps a node id, the original `sourceContributionIds` are merged into
  the new node — reflection no longer loses the trail.
- **Docs**: `docs/audit.md` — end-user explainer with examples.
- **MCP full-surface**: the MCP server now exposes every mutating CLI command
  as a tool, so managers can drive teamctx from Claude Desktop / Code / Cursor
  with no terminal after the initial install + API key. New tools include
  `init`, `role_add`, `role_assign`, `workstream_split`, `workstream_use`,
  `review_approve`, `review_reject`, `snapshot_create`, `snapshot_approve`,
  `snapshot_reject`, `reflect`, `config_set`, plus read-only helpers
  `list_roles`, `list_snapshots`, `get_snapshot`, `get_current_snapshot`,
  `list_pending_reviews`, `get_status`, `get_config`, `suggest_roles`,
  `suggest_workstream_splits`.
- **Safety model** for MCP mutations: `⚠ RISKY:` preamble on every Tier 2
  tool description (so the client model warns the user before calling),
  manager-identity gate at the MCP boundary (`author` param must match
  `config.manager` when set), and a `reportBack` string on every mutating
  response the client is expected to relay to the user after the call.
- **Refactor**: every mutating CLI command extracted into a `.core.js` pure
  function that MCP and the CLI both call — same behavior, one code path.
- **Manager guide** `docs/mcp-manager-guide.md` — zero-terminal walkthrough
  with copy-paste prompts for the common flows (init, add role, contribute,
  review, snapshot, split).
- Bring-your-own-agent recipes: new `recipes/` folder with two tool-agnostic
  prompt templates (`author-contribution.md`, `cleanup-context.md`) and per-tool
  guides for Claude Code, Cursor, and ChatGPT. Copy-paste prompts that shape
  rough notes into well-formed contributions and clean up the shared tree
  before running `teamctx reflect`.
- **Tasks as first-class objects**: track units of work alongside Whys, Roles,
  and Decisions. `teamctx task add / list / show / done / reopen / assign / rm`
  are all cheap local file ops (no AI). Tasks live inline on their workstream
  file at `.teamctx/workstreams/<ws>.json` under a `tasks` array. A
  workstream without the field is treated as empty — no migration required.
- **On-demand task prompt compile**: `teamctx task compile <id> [--role <slug>]
  [--force]` generates an AI-ready markdown prompt file at
  `.teamctx/context/tasks/<task-id>.md`. Compile is the one command that
  costs an AI call. Skips re-compile if the workstream is unchanged since
  the last `compiledAt`; `--force` overrides.
- **`teamctx status`** now shows a `Tasks: N open, M done (K compiled)`
  line so the count is visible without opening any file.
- **`teamctx ask`** grounds against open tasks in the target workstream, so
  answers can reference in-flight work.
- **Docs**: `docs/tasks.md` — end-to-end explainer with the compiled file
  shape and command reference.

### Not shipping (deliberate)
- No MCP surface for tasks in this release — the CLI shape should settle
  first. A follow-up PR will expose `list_tasks`, `task_add`, `task_done`,
  `task_compile`, etc.
- No auto-regeneration of compiled task files on tree changes.
- No due dates, priorities, dependencies, or cross-workstream tasks.
- Per-sentence citation ("this claim came from contribution X"). Attribution
  is at the node level.
- Backfill of provenance on nodes that predate this feature — they simply
  show no contributors and audit-flags them as "unknown."
- A diff view of what each contribution changed in the tree.

### Changed
- **MCP `contribute` supersedes `submit_contribution`**: the new `contribute`
  tool accepts `apply` (default false = enqueue, true = write immediately),
  `decision`, and `workstream`. `submit_contribution` is kept as a deprecated
  alias with `apply: true` (matching the old immediate-apply behavior) and
  will be removed in a future release.
- **`get_context` response shape** stays as `{workstreams: [{id, tree}, ...]}`
  from the previous release; documented in
  [docs/mcp.md](docs/mcp.md#breaking-change--get_context-response-shape).

### Fixed
- **Citation anchoring**: `ask`'s citation parser now anchors on the last
  `## Citations:`-style block in the AI's response instead of the first,
  closing a truncation/forgery path where a cited contribution's own text
  quoting that heading could otherwise cut off the real answer or inject
  fake citations.
- **OAuth `redirect_uri` validation**: the token endpoint now checks the
  `redirect_uri` at code exchange against the one used at `/authorize`,
  rejecting mismatches. Defense-in-depth alongside the PKCE check that was
  already enforced end-to-end.
- **Atomic one-shot OAuth codes**: `kvTake` (used for authorization codes
  and pending-auth state) now does a single atomic `GETDEL` against the KV
  store instead of a get-then-delete, closing a narrow replay window under
  concurrent requests.

## [0.2.0] - 2026-07-21

### Added
- Open-source communication surface: roadmap, contributing guide, code of
  conduct, security policy, issue/PR templates, CI, and CODEOWNERS.
- `/ask` endpoint, minimal web UI, and `teamctx ask "<question>" [--role <slug>]`
  CLI command for asking questions grounded in team context.
- Manager approval queue: `teamctx contribute` now enqueues by default;
  `teamctx review list / approve / reject` CLI to gate contributions; rejected
  items archived under `.teamctx/rejected/` with an optional reason.
  `teamctx config manager <name>` sets an identity gate (unset = solo mode).
  New `--apply` flag on `contribute` preserves the old immediate-apply behaviour.
- Decisions as first-class objects: contributions now record a `source`
  (`cli` or `web`), and nodes backed by a `--decision` contribution render
  inline provenance markers (`*[decision — author, date, via source]*`) in
  `shared.md`, in every compiled role file, and in `teamctx ask` answers.
- `teamctx mcp` — an MCP server over stdio exposing `get_context`,
  `get_role_context`, `ask`, and `submit_contribution` for Claude Code, Claude
  Desktop, Cursor, and other MCP-aware clients. See [docs/mcp.md](docs/mcp.md).
- Context snapshots: `teamctx snapshot create / list / show / approve / reject /
  current` — freeze the whole shared context as a versioned checkpoint that the
  manager signs off on. Snapshots live under `.teamctx/snapshots/` with a
  `current.json` pointer to the last approved state. Git-style ID prefixes
  supported on all id-taking commands. Reuses the manager identity gate.
- Provider-agnostic AI layer — teamctx now runs on Anthropic (default),
  OpenAI, or Google Gemini via a shared `complete()` interface. Each
  provider reads its own API key from the environment.
- `teamctx config provider <anthropic|openai|gemini>` sets the active
  provider on an existing project; `teamctx init` also asks for it on new
  projects and shows that provider's model list.
- Per-provider curated model registry and lax model validation, so newly
  released models work without a package update.
- `teamctx workstream suggest | split | list | use` — AI clusters a project's
  Why/What/How tree into distinct sub-workstreams (e.g. product vs. tech);
  the manager accepts splits interactively and reassigns roles.
- `teamctx role assign <slug> --workstream <id>` and `--workstream <id>` on
  `contribute`, `ask`, `reflect`, and `role add`.
- Automatic one-time migration of `.teamctx/shared.json` →
  `.teamctx/workstreams/main.json` (and `context/shared.md` →
  `context/workstreams/main.md`) on first run against an existing project.

### Fixed
- **Queue + workstream:** `contribute --workstream <id>` now persists the target
  workstream on the queue item (and on the contribution audit log). Previously
  the target was silently lost between enqueue and approve.
- **Review approve + workstream:** `review approve <id>` now applies operations
  to the queue item's target workstream (defaulting to `main` for legacy queue
  items), regenerates only the role files bound to that workstream, and threads
  contributions into `serializeToMd` / `generateRoleFile` so decision markers
  render on approved contributions. Previously it always wrote to `main` and
  overwrote every role file — corrupting role files bound to other workstreams.
- **Snapshots + workstream:** `snapshot create` now captures every workstream
  in the project as an array on the snapshot object. Legacy snapshots with the
  old `shared` field still load and display as a single-workstream snapshot on
  `main`. Previously only `main` was captured — post-split projects produced
  empty snapshots.
- **MCP + workstream:** `submit_contribution` gained an optional `workstream`
  arg (defaulting to active workstream, then `main`); it now filters role-file
  regeneration to roles bound to the target and records `workstream` +
  `source: mcp` on the audit log. Two new read-only tools added for discovery:
  `list_workstreams` and `get_workstream({id})`. `teamctx status` now shows a
  per-workstream Why-node breakdown after migration and the active provider.

### Changed
- `teamctx contribute` no longer applies to shared context on submission by
  default — it enqueues under `.teamctx/queue/` and prints the review command.
  Pass `--apply` to keep the old behaviour.
- **MCP `get_context` response shape** is now `{workstreams: [{id, tree}, ...]}`
  (whole-workspace) instead of a single tree. This is an intentional breaking
  change for MCP callers — keeping the main-only response would silently
  mislead callers in workstream-migrated projects. Adapt: read
  `data.workstreams[0].tree.whys` instead of `data.whys`, or call
  `get_workstream({id: 'main'})` for the single-tree shape.

## [0.1.0] - 2026-06-14

### Added
- Initial release: `teamctx` CLI and Vercel API for AI-native team context.
