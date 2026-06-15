---
description: Execute scoped roadmap items from plan.md into validated, committed changes while keeping plan.md accurate.
argument-hint: "[target plan section / phase] [constraints]"
---

You are executing the OpenCrane roadmap. Turn roadmap items in `plan.md` into
implemented, validated code changes while keeping the plan document accurate.

Target / constraints from the caller: **$ARGUMENTS**
(If empty, ask which plan section or phase to target before implementing anything.)

## First — load the rules

Read `AGENTS.md` at the repository root before writing any code. It is the canonical
rule set (coding conventions, IAM-first policy, planning discipline, commit format).

## Efficiency rules (follow these to avoid slow sessions)

- **Do not re-read the full plan.md.** Read only the "Open Backlog (Execute Next)"
  section (grep for the section header, then read that block). The rest is history.
- **Act at the first clear signal.** Do not spend multiple rounds investigating before
  touching files. If the item has acceptance criteria and file anchors, start immediately.
- **One build + test cycle per slice.** Do not run redundant validation rounds.
  If build passes and tests pass, that is the evidence — move on.
- **Report blockers immediately.** If an item is blocked (missing decision, missing
  tooling, BLOCKED annotation in plan), record it and skip to the next item.
  Do not investigate the blocker further unless explicitly asked.

## Scope

- Execute concrete implementation tasks from `plan.md` that fit in the current cycle.
- Default to completing all unchecked items in the selected target phase, unless an
  item is blocked by a missing decision or external dependency.
- Update `plan.md` status/checklists in the **same cycle** as the code and validation.

## Parallelisation (maximise it)

- Before implementing, decompose the target into a **dependency DAG + waves**. Dependencies are
  *compile-time type coupling* and *file/package contention* only — logical affinity is **not** a
  dependency. Items with no unmet dependency form a wave and run concurrently.
- Land a small **keystone** first (shared types/contracts/interfaces) to open the widest wave.
- **Dispatch one `general-purpose` subagent per independent lane in a single message** so lanes run
  concurrently; reserve a lane per package to avoid edit contention. Never serialise work that has
  no dependency between lanes.
- If `plan.md` already encodes an execution chain / waves for the track (e.g. Track CT), follow it.
- Each lane still obeys the efficiency rules: act at first signal, one build + test cycle per slice.

## Constraints

- Do not treat strategic roadmap statements as automatically implementable. Only
  implement scoped items with clear acceptance criteria.
- Treat unresolved architecture-checkpoint questions in `plan.md` as **blockers** —
  do not guess hidden product decisions.
- Do not mark items complete in `plan.md` without code **and** validation evidence.
- **Commit at every gate** (see Commit cadence) — do not leave finished, green slices uncommitted.
- Never commit to the default branch (branch first), and **never push or open a PR unless explicitly asked**.
- Never rewrite shared history.
- Never revert unrelated user changes.

## Commit cadence (commit at every gate)

- A *gate* is any checkpoint the work clears: the per-slice/per-wave **build + test** gate and the
  **independent review** gate. Commit *during* (when a slice's gate goes green) and *after* (once review
  passes) so each commit is a coherent, green, bisectable checkpoint.
- On a feature branch only — if on the default branch, branch first.
- Messages follow `AGENTS.md` → Commit Messages (gitmoji + imperative subject under 72 chars).
  **Do not add a Claude / AI co-author trailer** (`Co-Authored-By: Claude …`) — the commit is authored
  solely by the configured git user.
- Committing is local. Pushing / opening a PR is a separate, outward-facing action — only on explicit request.

## Procedure

1. Read only the "Open Backlog (Execute Next)" section of `plan.md`. Extract the
   first N unblocked items with clear acceptance criteria.
2. Pick the smallest high-impact slice. State what you are going to implement in
   one sentence, then implement it without further discussion.
3. Implement the selected slice(s), including tests and any required docs/config
   updates, following AGENTS.md conventions as you write — not as a cleanup pass.
4. Run `pnpm build` and the relevant test filter(s). One cycle. Summarise pass/fail.
5. If a blocker is hit, record it in plan.md and move to the next unblocked item.
6. Update the `plan.md` checklist/state to reflect exactly what changed this cycle.
7. **Commit each slice once its build + test gate is green** — feature branch only, gitmoji +
   imperative subject, **no Claude/AI co-author trailer** (see Commit cadence).
8. **Delegate a review pass to the `review` subagent** against the changed files. Resolve
   Critical/High findings, then **commit the resolution as a separate post-gate checkpoint**.
   Do not push or open a PR unless explicitly asked.

## Output (return in this order)

1. **Implemented items** — one bullet per completed item with acceptance criterion met
2. **Validation** — build and test pass/fail evidence (commands + result)
3. **plan.md updates** — exactly which items changed state
4. **Blockers** — items skipped and why (BLOCKED annotation, missing tooling, etc.)
5. **Review findings summary** — from the review subagent, with resolution status
6. **Commits** — the gate commits made this cycle (branch + subject line per commit)

If fully blocked: **Blocker**, **Evidence**, **Proposed unblocking options**, **Minimal fallback slice**.
