# Proposal: Slack import connector

**Status:** Proposal (suggestion, not committed) · **Serves:** Bring your own tools ·
**Rough size:** Medium — the first connector on the contract, so it also proves it

## Problem

Threads are where decisions get made and then lost. A team argues through a
migration in `#eng`, lands on an answer, and three months later nobody can say
why — the reasoning is forty messages deep in a channel no one scrolls.

That makes Slack the highest-leverage import source and the hardest to keep
signal-rich. A channel is mostly not context: standups, links, "thanks", deploy
bots. Import the firehose and the review queue becomes unusable, which is worse
than importing nothing — a manager who rejects forty proposals in a row stops
reading them.

## What exists today

- **The connector contract** (#21) — `auth → list → fetch`, with a registry and
  the `folder` reference implementation. A connector produces documents and
  nothing else: no AI calls, no queue writes, no dedupe.
- **`normalizeDocument`** (`src/import.js`) applies the shared rules — size cap,
  empty check, title fallback — to whatever a connector returns.
- **The whole downstream pipeline**: distill with `intent: 'document'`, carry
  forward what earlier documents proposed, queue one contribution each for
  manager review. All built, all shared.
- Nothing talks to Slack, and there is no HTTP client in the project — the AI
  providers each bring their own SDK, and the GitHub adapter uses bare `fetch`.

## The constraint that decides the architecture

Slack changed its rate limits on **29 May 2025**. For `conversations.history`
and `conversations.replies`:

| App type | Limit | Objects per request |
| --- | --- | --- |
| New **distributed** app outside the Marketplace | **1 request/minute** | **15** |
| Internal, customer-built app | Tier 3 — **50+/minute** | **1000** |

A shipped teamctx Slack app that users install would be a distributed app: one
request a minute, fifteen messages at a time. Importing a single busy channel
would take hours.

The project's existing stance — the user creates their own Slack app in their
own workspace and pastes their own token — puts every install in the second row.
That was a philosophical position about not running a server. It is now also the
only version of this feature that works, which is worth stating plainly in the
docs so nobody "simplifies" it later by publishing a shared app.

## Suggested approach (one way to do it)

1. **A thread is a document.** Not a channel, not a day. A thread has a topic, a
   beginning and an end, and it is where the reasoning lives. One thread becomes
   one proposed contribution, which keeps review tractable and rejection
   granular.

2. **Explicit selection, two selectors:**
   - `teamctx import --from slack C0421` — threads in a channel, defaulting to a
     recent window (`--since`), not all history.
   - `teamctx import --from slack https://team.slack.com/archives/C0421/p1699…`
     — one thread, pasted straight from Slack's "Copy link".

   The permalink form matters more than it looks: it is how someone imports the
   one conversation they already know was important, which is the highest-signal
   thing this connector can do.

3. **`list` returns threads, `fetch` returns one.** `conversations.history` for
   the window; keep messages where `reply_count > 0`; each becomes
   `{ ref: { channel, ts }, id, title }`. `fetch` then calls
   `conversations.replies` for that thread. This is exactly why the contract
   splits the two — `--dry-run` shows which threads would be imported without
   pulling a single reply.

4. **Render a thread as readable text**, because the distiller reads prose, not
   Slack's wire format:
   - `<@U0421>` → `@alice`, resolved once via `users.list` and cached per run
   - `<https://x|label>` → `label (https://x)`
   - drop `subtype` messages — joins, leaves, channel renames, most bots
   - one line per message: `@alice: we should move billing off Stripe`

5. **Ids are permalinks.** `slack:C0421/p1699887654123456` matches Slack's own
   permalink shape, so a contribution's `source` points at something a human can
   open. Provenance that cannot be followed is decoration.

## Where to start

- `src/connectors/folder.js` — the shape to copy; it is deliberately small.
- `src/connectors/index.test.js` — the conformance suite runs against every
  registered connector automatically, including the rule that none may import
  the AI layer.
- `src/adapters/github.js` — the house pattern for talking to an HTTP API with
  bare `fetch`, cursor pagination and error handling. No new dependency needed;
  Slack's Web API is form-encoded POSTs returning JSON.
- Tests: fixture JSON captured from the API shape, mocked at `fetch`. No test
  should touch the network.

## Open questions

- **How wide is the default window?** Thirty days of a busy channel is hundreds
  of threads. Too narrow and the first import feels empty; too wide and the queue
  drowns. Possibly there is no good default and `--since` should be required.
- **Standalone messages.** A decision announced without a thread is invisible to
  a threads-only rule. Do we import high-reaction messages? That is a heuristic,
  and heuristics are how firehoses start.
- **Token UX.** Creating a Slack app to get a token is a real barrier — five
  screens before the first import. A device-code or OAuth flow is friendlier but
  needs a redirect target, which means a server, which the rate limits now
  actively punish. The barrier may be the correct trade.
- **Private channels** need `groups:history` and only see what the token's owner
  is in. Silent partial results are worse than a refusal — probably worth
  reporting "3 of 5 channels not accessible" rather than quietly importing three.
- **Re-import.** Importing `#eng` next month re-proposes the same threads; the
  run-scoped dedupe does not persist. A watermark per channel would fix it, but
  where does it live — the connector, or teamctx?
