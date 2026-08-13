# Proposal: Import connector contract (auth → list → fetch → normalize)

**Status:** Proposal (suggestion, not committed) · **Serves:** Bring your own tools ·
**Rough size:** Medium — the contract is small; each connector is an independent PR

## Problem

`teamctx import <paths…>` reads local files, but most teams' context does not
live on someone's laptop. It lives in Slack threads, Drive folders, Notion
pages — written for another purpose and never re-typed into a context tree.

Six connectors are wanted (Slack, Google Drive, Microsoft 365, Dropbox, Notion,
Coda). Built one at a time with no shared shape, they will drift: six auth
flows, six ways to page a list, six opinions about what a "document" is, and six
places for AI logic to leak in. The contract has to land first so each connector
becomes a well-scoped PR that no one has to redesign.

## What exists today

- **`src/import.js`** already produces the target shape. `readDocuments` turns
  local files into `{ id, title, text, bytes, source }` — deliberately not
  file-shaped, because a Slack thread has no path and no extension.
- **`cli/commands/import.core.js`** takes documents and enqueues one proposed
  contribution each, carrying forward what earlier documents proposed so a run
  does not queue near-duplicates.
- **`intent: 'document'`** distilling, so prose written for another purpose is
  read for durable context rather than treated as a deliberate update.
- Everything after "documents exist" is therefore already built and shared.
  A connector only has to produce documents.
- Nothing fetches from a remote source, and there is no place to register one.

## Design rules (the part worth agreeing on)

1. **A connector is a fetch adapter and nothing else.** It turns a remote source
   into documents. No AI calls, no distilling, no queue writes, no dedupe —
   those are shared and already exist. If a connector imports `src/ai.js`,
   something has gone wrong.
2. **Pull-based, user's own credentials, no server.** `teamctx import --from
   slack <channel>` runs locally with the user's token, consistent with the
   project's no-server / bring-your-own-key stance. No webhooks, no hosted
   component, nothing to operate.
3. **Credentials never enter the repo.** `.teamctx/` is committed; tokens live
   beside the AI key in `.env.local`, or in the gitignored local preference
   store — never in config.json.
4. **Explicit selection, not firehose.** A channel or a folder the user names,
   not "everything I can see". Import quality collapses if the selection is
   broad, and so does the review queue.
5. **Ids are stable and traceable.** `slack:C0421/p1699887` rather than a
   counter, so a contribution's `source` points back at the actual artifact.

## Suggested approach (one way to do it)

1. **The interface** — `src/connectors/index.js`:

   ```js
   {
     name: 'slack',                       // matches --from <name>
     describe: 'Slack channels and threads',
     auth(env)      → { ok, token?, help }   // read credentials, explain if missing
     list(auth, selector, opts)  → [{ id, title, updatedAt }]   // what is there
     fetch(auth, ref)            → { id, title, text, source }  // one document
   }
   ```

   `list` is separate from `fetch` so `--dry-run` can show what would be pulled
   without downloading everything, matching how local import already behaves.

2. **A registry** — connectors register by name; `--from <name>` resolves one and
   errors with the known list when it does not exist. Unknown-source typos should
   be as loud as unknown paths already are.

3. **Normalize once** — `normalizeDocument()` alongside `readDocuments`, applying
   the same rules to remote text that local files get today: strip whitespace-only
   documents, enforce the size cap, guarantee a non-empty title. A connector
   returning junk should fail the same way a junk file does.

4. **One reference connector in this PR** — a `folder` connector wrapping the
   existing local reader. It proves the contract end to end without adding an
   OAuth dependency, and gives connector authors a worked example that is 30
   lines rather than a Slack client.

5. **Then one PR per source.** Slack first: threads are where decisions get made
   and then lost, which makes it the highest-leverage and the hardest to keep
   signal-rich. Written up in [Slack import connector](import-slack.md) — note
   the 2025 rate-limit change there, which makes the user's-own-token model the
   only workable one.

## Where to start

- `src/import.js` — the document shape and the skip/normalize rules to reuse.
- `cli/commands/import.core.js` — where `--from` dispatches instead of reading paths.
- `cli/commands/import.core.test.js` — the mocking pattern; a fake connector is
  the natural test double, and no test should need a network.

## Open questions

- **Auth UX for CLI-only users** — device-code flow versus a pasted token.
  Pasted tokens are trivial to build and horrible to rotate; device-code is the
  opposite. Slack may answer this differently from Drive.
- **Incremental import** — re-importing a channel should not re-propose what it
  proposed last week. The run-scoped dedupe in `import.core.js` does not persist
  across runs. Does a connector remember a watermark, or does teamctx?
- **Rate limits and paging** — owned by each connector, or a shared helper?
  Six hand-rolled backoff loops is a smell, but so is a helper written against
  one API's quirks.
- **Should `--from` and paths compose?** `teamctx import docs --from slack #eng`
  in one run is tidy for the user and more surface for us.
