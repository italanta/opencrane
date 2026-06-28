# Build stage
FROM node:22-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY libs/contracts/package.json libs/contracts/tsconfig.json libs/contracts/
COPY libs/awareness/package.json libs/awareness/tsconfig.json libs/awareness/
COPY libs/observability/package.json libs/observability/tsconfig.json libs/observability/
COPY libs/infra-api/package.json libs/infra-api/tsconfig.json libs/infra-api/
COPY libs/infra-auth/package.json libs/infra-auth/tsconfig.json libs/infra-auth/
COPY libs/infra-http/package.json libs/infra-http/tsconfig.json libs/infra-http/
COPY apps/clustertenant-operator/scripts apps/clustertenant-operator/scripts
# @opencrane/contracts generates typed clients from BOTH OpenAPI specs (silo + fleet), so the
# fleet spec must be present too even though this is the silo image.
COPY apps/clustertenant-operator/openapi.json apps/clustertenant-operator/openapi.json
COPY apps/fleet-operator/openapi.json apps/fleet-operator/openapi.json
COPY apps/clustertenant-operator/package.json apps/clustertenant-operator/tsconfig.json apps/clustertenant-operator/
COPY apps/clustertenant-operator/prisma apps/clustertenant-operator/prisma
RUN pnpm install --frozen-lockfile --filter @opencrane/contracts --filter @opencrane/awareness --filter @opencrane/observability --filter @opencrane/infra-api --filter @opencrane/infra-auth --filter @opencrane/infra-http --filter @opencrane/clustertenant-operator

COPY libs/contracts/src libs/contracts/src
COPY libs/awareness/src libs/awareness/src
COPY libs/observability/src libs/observability/src
COPY libs/infra-api/src libs/infra-api/src
COPY libs/infra-auth/src libs/infra-auth/src
COPY libs/infra-http/src libs/infra-http/src
COPY apps/clustertenant-operator/src apps/clustertenant-operator/src
# All workspace libs are leaf packages (no inter-@opencrane deps), so any order builds; the app
# builds last once its dependencies' dist is in place.
RUN pnpm --filter @opencrane/contracts build
RUN pnpm --filter @opencrane/awareness build
RUN pnpm --filter @opencrane/observability build
RUN pnpm --filter @opencrane/infra-api build
RUN pnpm --filter @opencrane/infra-auth build
RUN pnpm --filter @opencrane/infra-http build
RUN pnpm --filter @opencrane/clustertenant-operator build
# Stage generated Prisma client to a fixed path for the runtime stage
RUN find /app -path '*/node_modules/.prisma/client' -type d | head -1 | \
    xargs -I{} cp -r {} /generated-prisma

# Runtime stage
FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/libs/contracts/package.json libs/contracts/
COPY --from=build /app/libs/awareness/package.json libs/awareness/
COPY --from=build /app/libs/observability/package.json libs/observability/
COPY --from=build /app/libs/infra-api/package.json libs/infra-api/
COPY --from=build /app/libs/infra-auth/package.json libs/infra-auth/
COPY --from=build /app/libs/infra-http/package.json libs/infra-http/
COPY --from=build /app/apps/clustertenant-operator/package.json apps/clustertenant-operator/
COPY --from=build /app/apps/clustertenant-operator/prisma apps/clustertenant-operator/prisma
RUN pnpm install --frozen-lockfile --filter @opencrane/contracts --filter @opencrane/awareness --filter @opencrane/observability --filter @opencrane/infra-api --filter @opencrane/infra-auth --filter @opencrane/infra-http --filter @opencrane/clustertenant-operator --prod
COPY --from=build /generated-prisma /tmp/generated-prisma
# Retrieve the generated Prisma client for the runtime stage
RUN target=$(find /app -path '*/node_modules/.prisma/client' -type d | head -1) && \
    rm -rf "$target" && \
    cp -r /tmp/generated-prisma "$target" && \
    rm -rf /tmp/generated-prisma

COPY --from=build /app/libs/contracts/dist libs/contracts/dist
COPY --from=build /app/libs/awareness/dist libs/awareness/dist
COPY --from=build /app/libs/observability/dist libs/observability/dist
COPY --from=build /app/libs/infra-api/dist libs/infra-api/dist
COPY --from=build /app/libs/infra-auth/dist libs/infra-auth/dist
COPY --from=build /app/libs/infra-http/dist libs/infra-http/dist
COPY --from=build /app/apps/clustertenant-operator/dist apps/clustertenant-operator/dist

USER node

EXPOSE 8080

CMD ["node", "apps/clustertenant-operator/dist/index.js"]
