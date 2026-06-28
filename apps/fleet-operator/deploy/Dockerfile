# Build stage
FROM node:22-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY libs/observability/package.json libs/observability/tsconfig.json libs/observability/
COPY libs/contracts/package.json libs/contracts/tsconfig.json libs/contracts/
COPY libs/infra-api/package.json libs/infra-api/tsconfig.json libs/infra-api/
COPY libs/infra-auth/package.json libs/infra-auth/tsconfig.json libs/infra-auth/
COPY libs/infra-http/package.json libs/infra-http/tsconfig.json libs/infra-http/
COPY apps/fleet-operator/package.json apps/fleet-operator/tsconfig.json apps/fleet-operator/
RUN pnpm install --frozen-lockfile --filter @opencrane/observability --filter @opencrane/contracts --filter @opencrane/infra-api --filter @opencrane/infra-auth --filter @opencrane/infra-http --filter @opencrane/fleet-operator

COPY libs/observability/src libs/observability/src
COPY libs/contracts/src libs/contracts/src
COPY libs/infra-api/src libs/infra-api/src
COPY libs/infra-auth/src libs/infra-auth/src
COPY libs/infra-http/src libs/infra-http/src
# @opencrane/contracts' build regenerates its typed clients from BOTH OpenAPI specs — the silo
# (clustertenant-operator) and the fleet (fleet-operator) — via `pnpm generate` →
# openapi-typescript, so both specs must be present before contracts builds (below).
COPY apps/clustertenant-operator/openapi.json apps/clustertenant-operator/openapi.json
COPY apps/fleet-operator/openapi.json apps/fleet-operator/openapi.json
COPY apps/fleet-operator/src apps/fleet-operator/src
# scripts/emit-openapi.mts runs at the tail of the fleet build (`tsx scripts/emit-openapi.mts`),
# so the scripts dir must be present.
COPY apps/fleet-operator/scripts apps/fleet-operator/scripts
# Prisma schema + migrations: `prisma generate` (in the fleet build below) needs the schema,
# and the runtime db-migrate initContainer runs `prisma migrate deploy` over the migrations.
COPY apps/fleet-operator/prisma apps/fleet-operator/prisma
# All workspace libs are leaf packages (no inter-@opencrane deps), so any order builds; the app
# builds last once its dependencies' dist + the OpenAPI specs are in place.
RUN pnpm --filter @opencrane/observability build
RUN pnpm --filter @opencrane/contracts build
RUN pnpm --filter @opencrane/infra-api build
RUN pnpm --filter @opencrane/infra-auth build
RUN pnpm --filter @opencrane/infra-http build
RUN pnpm --filter @opencrane/fleet-operator build

# Runtime stage
FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/libs/observability/package.json libs/observability/
COPY --from=build /app/libs/contracts/package.json libs/contracts/
COPY --from=build /app/libs/infra-api/package.json libs/infra-api/
COPY --from=build /app/libs/infra-auth/package.json libs/infra-auth/
COPY --from=build /app/libs/infra-http/package.json libs/infra-http/
COPY --from=build /app/apps/fleet-operator/package.json apps/fleet-operator/
RUN pnpm install --frozen-lockfile --filter @opencrane/observability --filter @opencrane/contracts --filter @opencrane/infra-api --filter @opencrane/infra-auth --filter @opencrane/infra-http --filter @opencrane/fleet-operator --prod

COPY --from=build /app/libs/observability/dist libs/observability/dist
COPY --from=build /app/libs/contracts/dist libs/contracts/dist
COPY --from=build /app/libs/infra-api/dist libs/infra-api/dist
COPY --from=build /app/libs/infra-auth/dist libs/infra-auth/dist
COPY --from=build /app/libs/infra-http/dist libs/infra-http/dist
COPY --from=build /app/apps/fleet-operator/dist apps/fleet-operator/dist
# Schema + migrations for the db-migrate initContainer (`node dist/scripts/migrate.js` →
# `npx prisma migrate deploy`). The generated client itself ships inside dist/generated/prisma.
COPY --from=build /app/apps/fleet-operator/prisma apps/fleet-operator/prisma

USER node

CMD ["node", "apps/fleet-operator/dist/index.js"]
