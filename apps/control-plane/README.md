# @opencrane/control-plane

Express REST API that serves as the management layer for the OpenCrane platform. It provides endpoints for tenant lifecycle management, access policy administration, shared skills discovery, and audit log querying.

All mutations are dual-written: changes are applied to both Kubernetes CRDs (the operator's source of truth) and PostgreSQL via Prisma (the query store for dashboards and reporting).

## Responsibilities

| Route group | What it does |
|-------------|-------------|
| `GET/POST/DELETE /tenants` | Create, list, update, suspend/resume, and delete tenants. Writes to K8s CRD + Prisma. |
| `GET/POST/DELETE /policies` | Manage `AccessPolicy` CRs controlling tenant egress and MCP server access |
| `GET /skills` | Discover shared org/team skills from the mounted skills volume; upserts into Prisma for fast querying |
| `GET /audit` | Query the audit log with tenant, action, and time-range filters |
| `GET /healthz` | Liveness/readiness probe; reports DB connectivity status |

## Source layout

```
src/
├── index.ts              # Express app factory + server bootstrap
├── db.ts                 # Prisma client factory + health check
├── types.ts              # Shared request/response interfaces, AppDependencies
├── middleware/
│   └── auth.ts           # Bearer token auth middleware
├── routes/
│   ├── tenants.ts        # Tenant CRUD + dual-write
│   ├── policies.ts       # AccessPolicy CRUD + dual-write
│   ├── skills.ts         # Skills filesystem scan + Prisma upsert
│   └── audit.ts          # Audit log query from Prisma
├── scripts/
│   └── migrate.ts        # Standalone migration runner (prisma migrate deploy)
└── index.test.ts         # Integration tests with supertest
```

```
prisma/
└── schema.prisma         # PostgreSQL schema: Tenant, AccessPolicy, AuditEntry, Skill
```

## Configuration (environment variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP listen port |
| `DATABASE_URL` | — | PostgreSQL connection string (`postgresql://user:pass@host/db`) |
| `KUBECONFIG` / in-cluster | — | Kubernetes API access (auto-detected) |
| `INGRESS_DOMAIN` | `opencrane.local` | Used to derive tenant ingress hosts |
| `AUTH_TOKEN` | `""` | Bearer token for API access (empty = dev bypass) |
| `NODE_ENV` | `development` | Set to `production` to enforce auth |

## Database schema

```
Tenant          — mirrors the Tenant CRD status in Postgres
AccessPolicy    — mirrors the AccessPolicy CRD
AuditEntry      — append-only audit trail for all mutations
Skill           — discovered skills registry (name, scope, team, contentHash)
```

Run migrations:

```bash
pnpm db:migrate   # prisma migrate deploy (production)
pnpm db:generate  # regenerate Prisma client after schema changes
pnpm db:push      # push schema without migrations (dev only)
```

## Development

```bash
# From repo root
pnpm build          # compile TypeScript + generate Prisma client
pnpm test           # run vitest integration tests
```

## Docker

Built from `deploy/Dockerfile` using the repo root as build context:

```bash
docker build -f apps/control-plane/deploy/Dockerfile -t ghcr.io/opencrane/control-plane:latest .
```
