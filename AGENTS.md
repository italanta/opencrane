# OpenCrane Agent Guidance

## Source Of Truth

This file is the canonical agent instruction file for the repository.

- Read this file first when working in the repo.
- Treat legacy guidance in `CLAUDE.md` as redirected here.
- Detailed rules are split into focused files under [`docs/agents/`](docs/agents/). This file is the
  index and the agent roster; load the topic file that matches the work in front of you.

## Guidance Map

| Topic | File | Read it when you are… |
|-------|------|------------------------|
| **TypeScript** | [`docs/agents/typescript.md`](docs/agents/typescript.md) | writing or editing any `.ts` file — bracket placement, arrow functions, JSDoc, naming, imports, type-file separation, self-review table. |
| **Angular / Frontend** | [`docs/agents/angular.md`](docs/agents/angular.md) | working in the WeOwnAI Angular frontend — PrimeNG, layering, signals/resources, standalone components. |
| **Architecture & Identity** | [`docs/agents/architecture.md`](docs/agents/architecture.md) | making IAM, identity, auth, or token-policy decisions (the IAM-first philosophy). |
| **Kubernetes** | [`docs/agents/k8s.md`](docs/agents/k8s.md) | touching service accounts, RBAC, NetworkPolicy, or routes excluded from auth middleware. |
| **Cluster topology** | [`docs/agents/cluster-architecture.md`](docs/agents/cluster-architecture.md) | you need the whole-cluster picture — planes, namespaces, Helm templates, isolation tiers, multi-instance, Workload Identity. |
| **Build, Test & Infra** | [`docs/agents/infra.md`](docs/agents/infra.md) | building/testing, or editing Terraform/Helm/deploy under `platform/`. |
| **Workflow & Review Gate** | [`docs/agents/workflow.md`](docs/agents/workflow.md) | planning (`plan.md`/`CHANGELOG.md`), writing commit messages, or hitting the review gate. |
| **App-Specific** | [`docs/agents/app-specific.md`](docs/agents/app-specific.md) | working inside a specific `apps/*` or `libs/*` package; per-package map + API/CLI-first rule. |

## Agent Index

The repository defines specialised agents in two formats. Delegate to the right one rather than
doing everything inline; **dispatch independent agents concurrently** (multiple agent calls in one
message) wherever the work has no dependency between them.

**Claude Code subagents** (`.claude/agents/*.md` — invoked via the Agent tool by `name`):

| Agent | Model | Use it for |
|-------|-------|-----------|
| `review` | Haiku | Independent, fresh-context code review of a changed slice — correctness bugs, regressions, security/IAM-policy drift, missing tests, AGENTS.md style. Read-only; reports findings severity-first. **Required by the review gate before a turn ends** (see [Mandatory Independent Review](docs/agents/workflow.md#mandatory-independent-review-policy-driven-gate)). |
| `changelog` | Sonnet | Maintain `CHANGELOG.md` in functional, capability-first terms when a phase/track completes or a tag is cut. Reads `plan.md`/`plan-done.md` + git range; writes capability, not commit history. |
| `readme` | Sonnet | Maintain `README.md` as the project front door — the problem, the vision, and what the repo does. Keeps design decisions, phase history, threat models, and deep mechanism OUT (those go to `CHANGELOG.md`/`plan-done.md`/the docs site). |
| `observability` | Sonnet | Telemetry + logging in one (they share the `@opencrane/observability` lib and trace-wrap seam). Audits or wires a slice so external-I/O paths are traced (`___DoWithTrace` spans) and output is structured (no raw `console.*`, secrets redacted, errors under `err`), plus per-app `instrument.ts`/shutdown-flush/Helm env. Reads the lib barrel each run for current API names. |

**Roadmap execution** is the `/execute-plan` **skill** (`.claude/commands/execute-plan.md`), not an
agent — it runs in the main session, parallelises via a dependency DAG + waves (one `general-purpose`
subagent per lane), commits at each gate, and delegates the review gate to the `review` subagent above.

**Built-in platform agent types** (available via the Agent tool, not repo-defined): `Explore`
(read-only broad search — locating code across many files), `Plan` (design an implementation plan),
`general-purpose` (multi-step research/execution). The `architecture` and `angular` types target the
WeOwnAI frontend monorepo, not this AGPL platform repo.

When adding a new agent: put Claude Code subagents in `.claude/agents/` and add a row above — that is
the single home for agent definitions (do not reintroduce a parallel `.github/agents/` copy). Add a
user-invocable workflow as a skill under `.claude/commands/`.
