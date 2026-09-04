# Proposal: repairing a broken manager gate

**Status:** Proposal (suggestion, not committed) · **Serves:** Managers in control ·
**Rough size:** Small — one flag, one better error

## Problem

[#71](https://github.com/StatsLateral/teamctx/issues/71) stopped web-created
projects pinning `managerKey` to `name:<display name>`. It did not migrate the
projects already carrying one. Two of the three real projects created during
onboarding testing had the broken key; both were hand-repaired, which is fine
for someone who knows the field exists and has a clone open, and no help at all
to anyone else ([#73](https://github.com/StatsLateral/teamctx/issues/73)).

What such a person sees is worse than nothing:

```
only the configured manager (name:Ada Lovelace) may approve or reject.
You are Ada Lovelace (github:123818561).
```

The gate names them and refuses them in the same sentence. Nothing says the
gate is broken, and there is no path from that message to a fix.

## The security question, first

Repairing a manager gate is granting manager rights, so this borders the
privilege escalation [#49](https://github.com/StatsLateral/teamctx/issues/49)
closed. It is worth settling before designing anything.

**A `name:` gate is already open.** `name:<x>` is the last resort of the actor
ladder (`src/actor.js:81`) — it is produced only when there is no ambient
identity and no git config, and its value comes from `config.me`, which is
committed and shared. So anyone with the repository and no local git identity
already presents that key and passes the gate. Repair does not open a door; the
door is open, and repair is what closes it.

### Which is not the whole story

"The gate is already open" justifies *passing* it. It does not justify *taking*
it. Repair converts "anyone may approve" into "only this person may" — so
without a check, the first person to run it takes the project and locks out the
one it was for, with no way back through the tool, because the gate is valid
afterwards and repair rightly refuses a valid gate.

So the caller has to be recognised as the creator. The repository answers that
better than the config does: the author of the commit that first added
`.teamctx/config.json` is whoever ran `init`, and unlike anything inside that
file, history cannot be rewritten without the push access repair already sits
behind. It also survives the case a display name cannot — somebody whose git
name is "Ada" repairing a gate that reads `name:Ada Lovelace` is the same
person, and the email says so.

A web-created project commits as `<id>+<login>@users.noreply.github.com`, so
that form is unpacked rather than compared whole; otherwise the creator coming
back as `github:<id>` fails to match a commit they authored themselves.

When history can be read it decides, and the display name is not consulted —
otherwise renaming yourself to the name on the gate walks past the stronger
signal, which is the whole reason the stronger one is there. The name is the
fallback for a shallow clone or a rewritten history, where refusing everybody
would be worse.

That gives the bar: **whoever can already change the gate by hand.** Editing
`.teamctx/config.json` needs push access to the repository. A repair command
gated on the same thing grants nothing new — it makes an existing capability
discoverable and correct instead of folkloric.

Two constraints follow, and they are the whole of the safety argument:

- **It fires only on a `name:` gate.** Against a valid `git:` or `github:` gate
  it must refuse outright. Otherwise it is exactly the "become manager" backdoor
  #49 removed.
- **It is not exposed over MCP.** A member signing in with Google acts on the
  project's *lent* credential, which has push access while the member is
  emphatically not the manager. Offering repair there would hand the gate to
  anyone on the roster. Repairing from a clone requires a clone, which requires
  the access the bar asks for.

## Design

### 1. Say what is wrong (worth doing alone)

`ManagerGateError` already has the config. When the gate is `name:`-prefixed,
it should say so and name the fix, rather than reporting a contradiction:

> This project's manager gate is `name:Ada Lovelace`, which is a display name
> rather than an identity — projects created on the web before the fix in #71
> carry these, and nobody can match one. Run `teamctx config manager --repair`
> from a clone to re-pin it to your own identity.

This half needs no new authority and helps even somebody who then chooses to
hand-edit. It is the conservative option the issue offers, and it should ship
whether or not the flag does.

### 2. `teamctx config manager --repair`

- Refuses unless `managerKeys(config)` is a single `name:`-prefixed entry.
- Resolves the caller the same way #71's fix does, and refuses if that
  resolution is itself a `name:` key — repairing one unusable gate into another
  helps nobody.
- Re-pins `managerKey` and reports both the old and new value, because a command
  that silently changes who may approve is the wrong kind of quiet.
- CLI only. No MCP tool, for the reason above.

### Deliberately not included

- **A "prove you are `config.me`" check.** The issue floats it; it is weaker
  than it sounds. `me` is a display name, settable with `teamctx config name`,
  which is the hole #49 closed. Push access is the honest bar.
- **Automatic repair on read.** A gate that fixes itself when someone looks at
  it is a gate that changes without anyone deciding to change it.
- **Repairing an empty gate.** No `managerKey` at all is the bootstrap case —
  `canApprove` already returns true and the first person to pin it wins. That is
  existing behaviour, not this.

## Verification

1. `npm test` — the manager-gate suite must stay green; this adds a branch, it
   does not change who passes an intact gate.
2. A project with `managerKey: "name:Ada"` — `--repair` re-pins it to the
   caller's `git:<email>`, and approval works afterwards.
3. A project with `managerKey: "git:someone@else.com"` — `--repair` refuses.
   This is the test that matters; it is the difference between a repair and a
   backdoor.
4. A caller with no git identity — `--repair` refuses rather than writing a
   second `name:` key.
5. `config manager` with a broken gate names the problem without being asked.

## Checked: nothing can write a `name:` key any more

Worth confirming before building, since if another route still produced one this
would be treating a symptom. It does not:

- `manager` and `managerKey` are off `WRITABLE` (`config.core.js:30`), so
  `config_set` refuses them — #49's fix.
- `teamctx config manager` is read-only (`cli/index.js:177`).
- `init` is the only remaining writer, and #71 made it refuse a `name:`
  identity outright.

So repair is a **one-time migration for projects created in a window that has
closed**, not an ongoing safety net. That is the right thing for it to be, and
it means the flag can be removed later without leaving a hole.

It also settles the shape: because `managerKey` is deliberately off `WRITABLE`,
`--repair` cannot go through `setConfig`'s normal path. It needs its own
function with its own precondition — which is better anyway, since the
precondition (*the gate is `name:`-prefixed*) is the entire safety argument and
belongs somewhere it can be read and tested on its own.
