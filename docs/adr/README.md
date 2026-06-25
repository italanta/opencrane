# Architecture Decision Records

Long-lived design decisions for the OpenCrane platform. An ADR captures **why** a
decision was made, the alternatives that were weighed, and the consequences we accepted —
so a later reader (or a later agent) does not relitigate a settled question.

These records are engineering history: they sit next to the agent guidance in
[`docs/agents/`](../agents/) and complement the forward plans at the repo root
(`plan.md`, `silo-multi-tenant-plan.md`). Reader-facing operator and integrator docs live
in [`website/`](../../website); an ADR may be the source a website page summarises, but it
is not itself published.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-cluster-tenant-virtual-network-isolation.md) | ClusterTenant-as-virtual-network strict isolation (substrate) | Accepted |

## Writing a new ADR

- Number sequentially (`NNNN-short-slug.md`); never reuse or renumber.
- Keep the shape: **Status · Context · Decision · Alternatives considered · Consequences**.
- Record the **decided** outcome. Open questions belong in a plan file, not an ADR.
- When a decision changes, write a new ADR that supersedes the old one and flip the old
  one's status to `Superseded by NNNN` — never rewrite history in place.
- Reference the originating task ID (e.g. `task_5164276f`) so the record traces back to the
  roadmap that requested it.
