# OpenCrane Platform Guidelines

## Build & Test

- Install deps: `pnpm install`
- Build all: `pnpm build`
- Test all: `pnpm test`
- Build single package: `pnpm --filter @opencrane/operator build`
- Test single package: `pnpm --filter @opencrane/control-plane test`

## TypeScript Coding Guidelines

### Bracket Placement

Opening brackets `{` must be on their own line for classes and functions:

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

Exception: single-line functions may have the bracket on the same line:

```typescript
function trimString(value: string): string { return value?.trim() ?? ""; }
```

### Arrow Functions

Never use arrow functions to declare standalone functions. Arrow functions are only allowed inside higher-order functions like `map`, `filter`, `reduce`, etc.

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

### JSDoc Documentation

All declarations must have JSDoc comments:

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

Use underscore prefixes to indicate scope/visibility:

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

Imports should be ordered from furthest dependency to closest, grouped by family:

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

### Critical: All imports from a single package must be on ONE LINE

Every import statement must be on a single line. Never split imports across multiple lines:

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

Import order summary:

| Priority | Category | Example |
|----------|----------|---------|
| 1 | Node builtins | `node:fs`, `node:path`, `node:crypto` |
| 2 | External - Utils | `date-fns`, `lodash` |
| 3 | External - Framework | `hono`, `@kubernetes/client-node`, `pino` |
| 4 | Local packages | `@opencrane/operator`, `@opencrane/control-plane` |
| 5 | Local file imports | `./reconciler.js`, `../types.js` |

### Barrel Exports

Each workspace package should have a single barrel export file at the package root (`src/index.ts`). Always import from the package barrel, not from internal paths.

```typescript
// CORRECT
import { TenantOperator } from "@opencrane/operator";

// WRONG
import { TenantOperator } from "@opencrane/operator/src/tenant-operator";
```
