# Agent Instructions — Merchant

## How this project works

One human (Alex) plus AI agents. Alex describes changes in plain language; agents plan, implement, and verify them. **Alex reviews work through the beads tracker and the running result — not the code.** He only opens the code when something is badly broken.

That has one big consequence: **the tracker is the system of record.** If a decision, change, or finding isn't captured in a bead, Alex will never see it. Write every bead as if it's the only artifact the reviewer gets — because it is.

TypeScript on Cloudflare Workers (wrangler). Tests are vitest, lint/format is biome, types via tsc.

Issue tracking is **bd (beads)**, Dolt-backed, prefix `merchant`. The `bd prime` hook injects the full beads command reference and project memories at session start, so this file covers the *contract*, not command syntax. Run `bd prime` manually after compaction or if context seems missing.

## The loop

Every request from Alex goes through this cycle:

### 1. Intake — beads before code

Turn the request into beads **before writing any code**:

- **Small change** (one sitting, one concern) → one `task`/`bug`/`feature` bead.
- **Large change** → an epic with child beads (`--parent`), wired with `bd dep add` so `bd ready` reflects real ordering. Size children so one agent session can finish one child.
- **Passing thought from Alex** ("we should probably…") → `bd q "title"` to capture it, priority 4, move on.

If the request is ambiguous in a way that changes the design, ask Alex *before* creating the epic — one round of questions up front beats a wrongly-shaped dependency tree.

### 2. Write beads Alex can review without reading code

Every non-trivial bead needs:

- **Description**: why this exists and what should change, in *user-visible terms*, not implementation jargon.
- **`--acceptance`**: a checklist of observable behaviors. This is what Alex reviews against. If you can't phrase acceptance criteria as something visible in the running app/CLI/test output, the bead is too vague — split or rethink it.
- **`--design`**: the decisions you made and the alternatives you rejected. Alex delegates design to agents; this field is where he audits it.
- **`bd note <id>`** as you work: surprises, dead ends, scope changes. This is the work diary.

On close, **`--reason` is mandatory** and must say: what changed (files/components in plain terms), how it was verified (which builds, which tests, what you observed), and a pointer to evidence (screenshot path, test names). "Done" or "Completed" is not a close reason.

### 3. Verify before closing — never "should work"

Alex won't catch breakage in review because he isn't reading the diff. Before closing any code bead:

- `npm run typecheck`, `npm test`, and `npm run lint` must all pass.
- For user-visible behavior, exercise it against `npm run dev` (wrangler dev) and describe what you observed in the close reason.
- **Never `npm run deploy`** unless Alex explicitly asks — deploying to Cloudflare is publishing.
- If verification can't be done by an agent, do **not** close the bead. Note exactly what manual step remains and flag it: `bd human <id>`.

### 4. Discovered work

Anything you find that's out of scope for the current bead — a bug, a smell, a missing test — gets its own bead with `--deps discovered-from:<current-id>`, and you **leave it alone**. Never silently fix unrelated things: an unrecorded fix is invisible to Alex, and an unrecorded change is how regressions sneak in.

### 5. Decisions that belong to Alex

When you hit a genuine product decision (behavior tradeoff, visual choice, anything irreversible like a data-model migration shape), flag the bead with `bd human <id>` and say in a note exactly what you need decided, with your recommendation. Don't stall the whole session on it — pick up other ready work.

### 6. Close & commit

- Close beads with proper `--reason` (see §2); use `bd close <id> --suggest-next` to find unblocked follow-ups.
- **One commit per completed bead**, with the bead ID in the commit message (`fix: short description (merchant-abc)`). This keeps `git log` and `bd list --status=closed` aligned, which is how Alex cross-references work.

### 7. Landing the plane (session end)

Before declaring a session done:

1. File beads for any loose ends — nothing lives only in the conversation.
2. Quality gates: builds + tests for whatever changed.
3. Close finished beads, note status on in-progress ones.
4. Sync and push: `git pull --rebase`, `bd dolt pull`, `bd dolt push`, `git push`. (There is no `bd sync` in bd 1.0.5.) Work that exists only on this machine doesn't exist.
5. Hand off: a short summary of what shipped, what's blocked, and what `bd ready` will offer next session.

## How Alex reviews (what your writing lands on)

Optimize bead text for these queries — they're his entire review surface:

```bash
bd list --status=closed --sort=updated   # what got done lately
bd show <id>                             # acceptance + design + notes + close reason
bd human list                            # decisions waiting on him
bd ready / bd blocked                    # what's next, what's stuck
```

## Memory

- Durable insights — gotchas, platform constraints, "we tried X and it failed because Y" — go in `bd remember "insight"`. Search first with `bd memories <keyword>`; update an existing key rather than duplicating.
- **No MEMORY.md, no markdown TODO lists, no TodoWrite for cross-session tracking.** Beads and bd memories only. (Ephemeral within-turn checklists are fine.)

## What we deliberately don't use

Solo project — skip the fleet machinery: **swarm, federation, gates, merge-slots, Dolt server mode, formulas/molecules/wisps**. Assignee/claim ceremony is optional noise with one operator; setting a bead `in_progress` is enough. And never `bd edit` — it opens `$EDITOR` and hangs agents; use `bd update <id> --title/--description/--notes/--design` instead.
