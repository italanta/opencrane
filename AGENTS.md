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

```typescript
// WRONG
export class MyService {
	getData(): string {
		return "data";
	}
}

// CORRECT
export class MyService
{
	getData(): string
	{
		return "data";
	}
}
```

```typescript
function trimString(value: string): string { return value?.trim() ?? ""; }
```

### Arrow Functions

Never use arrow functions to declare standalone functions. Arrow functions are only allowed inside higher-order functions like `map`, `filter`, and `reduce`.

```typescript
// WRONG
const getUserName = (user: User): string => user.name;

// CORRECT
function getUserName(user: User): string
{
	return user.name;
}

// Arrow functions OK inside higher-order functions
const names = users.map(user => user.name);
const total = items.reduce((sum, item) => sum + item.price, 0);
```

### Inline Step Comments

Every function with 3 or more sequential steps must have a numbered inline comment before each step.

- The comment must explain what the step does.
- The comment must explain why the step is necessary.
- The comment must not just restate the method name.

```typescript
// WRONG — no comments, reader must infer intent from method names alone
async function provision(tenant: Tenant): Promise<void>
{
	await createServiceAccount(tenant);
	await createBucket(tenant);
	await createDeployment(tenant);
}

// CORRECT — each step is explained with context
async function provision(tenant: Tenant): Promise<void>
{
	// 1. ServiceAccount — grants the pod a GCP identity for Workload Identity.
	await createServiceAccount(tenant);

	// 2. BucketClaim — requests a per-tenant GCS bucket via Crossplane.
	await createBucket(tenant);

	// 3. Deployment — runs the tenant gateway; mounts GCS volume and shared skills.
	await createDeployment(tenant);
}
```

### JSDoc Documentation

All declarations must have JSDoc comments.

```typescript
/** Service for managing tenant lifecycle */
export class TenantService
{
	/** The currently selected tenant */
	private currentTenant: Tenant | null = null;

	/**
	 * Fetches tenant by name from the cluster
	 * @param name - The tenant CR name
	 * @returns The tenant resource
	 */
	getTenant(name: string): Promise<Tenant>
	{
		return this.customApi.getNamespacedCustomObject({ name });
	}
}

/** Configuration options for the operator */
interface OperatorConfig
{
	/** Namespace to watch for Tenant CRs */
	watchNamespace: string;
	/** Default container image for tenant pods */
	tenantDefaultImage: string;
}
```

### Function Naming Conventions

Use underscore prefixes to indicate scope and visibility.

- `function _functionName`: same file only
- `function _FunctionName`: same package
- `function __FunctionName`: same domain
- `function ___FunctionName`: wide or global application use

| Pattern | Scope | Usage |
|---------|-------|-------|
| `function _functionName` | Same file only | Local helper consumed within the same file |
| `function _FunctionName` | Same package | Shared within the same workspace package |
| `function __FunctionName` | Same domain | Shared across closely related packages |
| `function ___FunctionName` | Wide/global | Shared across the entire application |

```typescript
// Local to this file only (not exported)
function _formatDate(date: Date): string
{
	return date.toISOString().split("T")[0];
}

// Exported for use within the same package
export function _FormatTitle(title: string): string
{
	return title.trim().toUpperCase();
}

// Exported for use across related packages
export function __FormatStatus(status: string): string
{
	return `STATUS.${status}`;
}

// Exported for wide use across the entire application
export function ___FormatDisplayName(firstName: string, lastName: string): string
{
	return `${firstName} ${lastName}`.trim();
}
```

### Import Order

Imports should be ordered from furthest dependency to closest, grouped by family.

- 1. Node builtins
- 2. External utils and helpers
- 3. External frameworks
- 4. Local packages
- 5. Local file imports

```typescript
// 1. External libraries - Utils/Helpers
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// 2. External libraries - Framework
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import * as k8s from "@kubernetes/client-node";
import pino from "pino";

// 3. Local packages - Types/Models
import type { Tenant, AccessPolicy, OperatorConfig } from "@opencrane/operator";

// 4. Local file imports (same package)
import { applyResource, deleteResource } from "./reconciler.js";
import type { CreateTenantRequest } from "../types.js";
```

| Priority | Category | Example |
|----------|----------|---------|
| 1 | Node builtins | `node:fs`, `node:path`, `node:crypto` |
| 2 | External - Utils | `date-fns`, `lodash` |
| 3 | External - Framework | `hono`, `@kubernetes/client-node`, `pino` |
| 4 | Local packages | `@opencrane/operator`, `@opencrane/control-plane` |
| 5 | Local file imports | `./reconciler.js`, `../types.js` |

### Single-Line Imports

All imports from a single package must be on one line.

- Never split a single import declaration across multiple lines.

```typescript
// WRONG
import {
	TenantSpec,
	TenantStatus,
	AccessPolicySpec,
	OperatorConfig,
} from "./types.js";

// CORRECT
import { TenantSpec, TenantStatus, AccessPolicySpec, OperatorConfig } from "./types.js";
```

### Barrel Exports

Each workspace package should have a single barrel export file at the package root (`src/index.ts`).

- Import from the package barrel.
- Do not import from internal package source paths.

```typescript
// CORRECT
import { TenantOperator } from "@opencrane/operator";

// WRONG
import { TenantOperator } from "@opencrane/operator/src/tenant-operator";
```

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

### Reusable Component Rule (Required)

Always create reusable UI components before writing repeated page-level markup.

- Shared visual wrappers must live under `src/app/shared/components/**`.
- Feature pages under `src/app/features/**` should compose shared components and services.
- If the same pattern appears in 2 or more places, refactor it into a shared component immediately.
- Page components should focus on orchestration and data flow; display logic belongs in shared components.
- Check these rules after every implementation cycle.

### Frontend Layering

- `core/`: API services, app-wide models, cross-cutting infrastructure
- `shared/`: reusable presentational components and UI primitives
- `features/`: route-level containers that compose `core` and `shared`

### Data Access

- All HTTP calls must go through dedicated `core/api` services.
- Do not issue HTTP requests directly from templates or shared presentational components.