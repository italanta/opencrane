# Workflow, Planning & Review Gate

> Part of the OpenCrane agent guidance. See [`AGENTS.md`](../../AGENTS.md) for the index.

## Repo State Model

Three files track work, each with a distinct role — keep them from drifting:

- **`plan.md`** — the open backlog: phases/tracks not yet complete. Items carry status; completed tracks leave a one-line `✅ COMPLETE (see plan-done.md)` pointer.
- **`plan-done.md`** — the historical record of finished tracks (large; the detailed "what shipped and how" lives here, e.g. multi-instance Track MI, ClusterTenant CT.*).
- **`CHANGELOG.md`** — capability log; sections map to git tags, `## [Unreleased]` holds in-flight work. Written in functional terms, not commit restatement.

## Planning Discipline

- Keep `plan.md` updated as implementation progresses.
- When a roadmap item changes state due to code, validation, or a discovered blocker, update `plan.md` in the same work cycle.
- Do not leave completed or partially implemented backlog items stale in `plan.md` after landing the corresponding code.
- When a track or phase is **fully complete**, move it out of `plan.md` into `plan-done.md` (the historical record) and leave a one-line `✅ COMPLETE (see plan-done.md)` pointer in its place.
- **When a phase or track completes, update `CHANGELOG.md` in the same work cycle**, version by version (sections map to git tags; in-progress work goes under `## [Unreleased]`). Never let a release/tag land without a corresponding changelog entry.
  - Write entries in **functional, capability-first terms** — *what an operator/tenant/integrator can now do, or do differently, that they couldn't before* — never a restatement of commits. Name a mechanism (flag, endpoint, `oc` command) only when it helps the reader use the feature. Collapse many commits into the single capability they deliver.
  - Delegate this to the **`changelog` agent** (`.claude/agents/changelog.md`, runs on Sonnet), which encodes this style; or follow that file's rules if writing the entry inline.

## Commit Messages

- Always end each work cycle with a suggested commit message.
- **Every commit subject must start with an emoji** that matches the primary intent of the change.
  Use the table below — it is **derived from this repository's own commit history**, so following it
  keeps `git log` consistent with the convention already established here.
- Use imperative mood for the subject line (e.g. `add`, `fix`, `update`, not `added` or `adding`).
- Keep the subject line under 72 characters.
- If the change touches multiple concerns, list them as bullet points in the body. When a secondary
  concern is significant, you may append a second emoji after the first (history does this — e.g.
  `🎱✨`, `🚀 🔧`, `🔧 🔥`); lead with the emoji for the primary intent.
- **Do not add a Claude / AI co-author trailer** (no `Co-Authored-By: Claude …`). Commits are authored solely by the configured git user.

Emoji convention (derived from commit history; the count is how often it already appears):

| Intent | Emoji | Notes / what it has marked here |
|--------|-------|----------------------------------|
| Configuration / tooling / infra wiring (most common) | 🔧 | Helm scaffold, cluster/scope config, deploy plumbing (45×) |
| New feature / capability | ✨ | A new subsystem or API/CLI surface (19×) |
| Enhancement / extend an existing capability | ⚡ | Increment to a shipped capability — metrics, versioning, bindings (5×) |
| Bug fix / typing fix / address review findings | 🐛 | (7×) |
| Refactor — no behaviour change | ♻️ | Move shared code, align typing/signals (7×) |
| Move / rename / restructure files | 🚚 | Split `src/` into packages, relocate tests (4×) |
| Remove code, files, or infra | 🔥 | Delete dead infra (e.g. remove Crossplane) (13×) |
| Security / auth / RBAC / TLS / NetworkPolicy | 🔒️ | IAM-first changes (13×) |
| Documentation | 📝 | Docs + `plan.md` updates (14×) |
| Notes / progress / readmes | 📓 | Lighter-weight notes & progress (6×) |
| Architecture / plan / design updates | 🏡 | High-level design & phase planning (6×) |
| Agent / prompt / AI-loop / meta-config | 🎱 | `AGENTS.md`, agent defs, prompt/loop tuning (5×) |
| Cosmetic / UI polish | 🎨 | Visual-only tweaks (10×) |
| Deploy / launch | 🚀 | Launch scripts, local deploy fixes (2×) |
| Tests | 🧪 | Test-only additions |
| Work in progress | 🚧 | Incomplete checkpoint |

When an intent isn't covered above, pick the closest [gitmoji](https://gitmoji.dev/) and prefer
reusing an emoji already in this table over introducing a new one.

## Mandatory Independent Review (Policy-Driven Gate)

The [self-review compliance table](./typescript.md#self-review-before-finishing) is a self-check and
is not sufficient on its own. A policy-driven `Stop` gate decides — per change — whether an
independent review is required before the turn can end. When the gate asks for review you must:

1. Delegate to the **`@review` subagent** against the changed files.
2. Resolve every **Critical** and **High** finding it returns — fix it, or justify in
   your response why it is not applicable.
3. Only then finish the turn.

**How the gate decides** (two `Stop` hooks run in parallel):

- `.claude/hooks/require-review.sh` — a free shell pre-filter. It skips the obvious
  cases (no TypeScript change, trivial size, test/type-only/generated files,
  already-reviewed) and escalates the rest. It writes `.claude/.review-context.md`
  for the judge.
- A **Haiku agent hook** reads that context plus `.claude/review-policy.md` and judges
  whether the change carries real risk (auth, secrets, network, IAM, money, or
  non-trivial production control flow). It blocks (`ok:false`) only when warranted.

**`.claude/review-policy.md` is the single tunable surface.** If review fires too often
and burns tokens — or misses something — edit that file (threshold, `always-review`
keywords, `never-review-paths`, or the judgment guidance) and record it in its tuning log.

The gate blocks **at most once per stop sequence** (loop-safety via `stop_hook_active`),
so it can never trap a turn — but skipping the review when it fires defeats the purpose.
Treat a block as a hard requirement, not a suggestion.
