# OpenCrane Agent Guidance

## Source Of Truth

This file is the canonical agent instruction file for the repository.

- Read this file first when working in the repo.
- Treat legacy guidance in `CLAUDE.md` as redirected here.

## Build And Test

- Install deps: `pnpm install`
- Build all: `pnpm build`
- Test all: `pnpm test`
- Build single package: `pnpm --filter @opencrane/operator build`
- Test single package: `pnpm --filter @opencrane/control-plane test`

## TypeScript Coding Guidelines

### Bracket Placement

Opening brackets `{` must be on their own line for classes and functions.

Exception: single-line functions may have the bracket on the same line.

### Arrow Functions

Never use arrow functions to declare standalone functions. Arrow functions are only allowed inside higher-order functions like `map`, `filter`, and `reduce`.

### Inline Step Comments

Every function with 3 or more sequential steps must have a numbered inline comment before each step.

- The comment must explain what the step does.
- The comment must explain why the step is necessary.
- The comment must not just restate the method name.

### JSDoc Documentation

All declarations must have JSDoc comments.

### Function Naming Conventions

Use underscore prefixes to indicate scope and visibility.

- `function _functionName`: same file only
- `function _FunctionName`: same package
- `function __FunctionName`: same domain
- `function ___FunctionName`: wide or global application use

### Import Order

Imports should be ordered from furthest dependency to closest, grouped by family.

- 1. Node builtins
- 2. External utils and helpers
- 3. External frameworks
- 4. Local packages
- 5. Local file imports

### Single-Line Imports

All imports from a single package must be on one line.

- Never split a single import declaration across multiple lines.

### Barrel Exports

Each workspace package should have a single barrel export file at the package root (`src/index.ts`).

- Import from the package barrel.
- Do not import from internal package source paths.

## IAM-First

OpenCrane is IAM-first.

- Prefer federated identity, Workload Identity, OIDC, and cloud IAM over static bearer tokens.
- Treat bearer tokens as temporary compatibility shims or break-glass paths, not the default architecture.
- Every platform service and every tenant workload should have an explicit workload identity.
- Every human operator should authenticate through centrally managed identity, not shared long-lived tokens.

## Central Identity Model

Identity and authorization must be described centrally.

- Cloud IAM is the source of truth for cloud resource access.
- Kubernetes RBAC is the source of truth for Kubernetes API access.
- Terraform should define cloud identities, trust bindings, and IAM role attachments.
- Helm should define Kubernetes service accounts, RBAC bindings, and workload identity annotations.
- Application code should consume identity provided by the platform rather than inventing parallel auth schemes.

## Defaults

- New services should get a dedicated Kubernetes service account.
- New services should get a dedicated cloud service account when they need cloud API access.
- Disable service account token automount unless Kubernetes API access is explicitly required.
- Scope IAM and RBAC to the smallest role that satisfies the workload.
- Prefer machine-to-machine identity over shared secrets.

## Token Policy

- Do not introduce new bearer-token control paths when IAM or OIDC can solve the problem.
- Existing bearer-token paths should be treated as migration targets.
- If a bearer token is unavoidable, document why IAM cannot be used, constrain its scope, and define a removal path.

## OpenCrane-Specific Direction

- Tenant workloads should use per-tenant Workload Identity for cloud storage and other tenant-scoped cloud resources.
- Operator and control-plane services should move toward explicit workload identities instead of implicit cluster-only trust.
- Network reachability does not imply authorization; authorization should come from IAM and RBAC, not location on the cluster network.

## Frontend Guidelines

### PrimeNG Standard

For Angular frontend work, use PrimeNG as the default component library.

- Prefer PrimeNG form, table, navigation, and feedback components over custom implementations.
- Configure theme providers in `app.config.ts` using `providePrimeNG`.
- Keep global visual tokens in `styles.css`; avoid ad-hoc per-page color systems.

### Reusable Component Rule

Always create reusable UI components before writing repeated page-level markup.

- Shared visual wrappers must live under `src/app/shared/components/**`.
- Feature pages under `src/app/features/**` should compose shared components and services.
- If the same pattern appears in 2 or more places, refactor it into a shared component immediately.
- Page components should focus on orchestration and data flow; display logic belongs in shared components.

### Frontend Layering

- `core/`: API services, app-wide models, cross-cutting infrastructure
- `shared/`: reusable presentational components and UI primitives
- `features/`: route-level containers that compose `core` and `shared`

### Data Access

- All HTTP calls must go through dedicated `core/api` services.
- Do not issue HTTP requests directly from templates or shared presentational components.