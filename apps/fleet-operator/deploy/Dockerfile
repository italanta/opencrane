# Build stage
FROM node:22-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY libs/observability/package.json libs/observability/tsconfig.json libs/observability/
COPY libs/contracts/package.json libs/contracts/tsconfig.json libs/contracts/
COPY apps/fleet-operator/package.json apps/fleet-operator/tsconfig.json apps/fleet-operator/
RUN pnpm install --frozen-lockfile --filter @opencrane/observability --filter @opencrane/contracts --filter @opencrane/fleet-operator

COPY libs/observability/src libs/observability/src
COPY libs/contracts/src libs/contracts/src
# @opencrane/contracts' build regenerates its typed clients from BOTH OpenAPI specs — the silo
# (clustertenant-operator) and the fleet (fleet-operator) — via `pnpm generate` →
# openapi-typescript, so both specs must be present before contracts builds (below).
COPY apps/clustertenant-operator/openapi.json apps/clustertenant-operator/openapi.json
COPY apps/fleet-operator/openapi.json apps/fleet-operator/openapi.json
COPY apps/fleet-operator/src apps/fleet-operator/src
RUN pnpm --filter @opencrane/observability build
RUN pnpm --filter @opencrane/contracts build
RUN pnpm --filter @opencrane/fleet-operator build

# Runtime stage
FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/libs/observability/package.json libs/observability/
COPY --from=build /app/libs/contracts/package.json libs/contracts/
COPY --from=build /app/apps/fleet-operator/package.json apps/fleet-operator/
RUN pnpm install --frozen-lockfile --filter @opencrane/observability --filter @opencrane/contracts --filter @opencrane/fleet-operator --prod

COPY --from=build /app/libs/observability/dist libs/observability/dist
COPY --from=build /app/libs/contracts/dist libs/contracts/dist
COPY --from=build /app/apps/fleet-operator/dist apps/fleet-operator/dist

USER node

CMD ["node", "apps/fleet-operator/dist/index.js"]
