# Build stage
FROM node:22-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY libs/observability/package.json libs/observability/tsconfig.json libs/observability/
COPY apps/operator/package.json apps/operator/tsconfig.json apps/operator/
RUN pnpm install --frozen-lockfile --filter @opencrane/observability --filter @opencrane/operator

COPY libs/observability/src libs/observability/src
COPY apps/operator/src apps/operator/src
RUN pnpm --filter @opencrane/observability build
RUN pnpm --filter @opencrane/operator build

# Runtime stage
FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/libs/observability/package.json libs/observability/
COPY --from=build /app/apps/operator/package.json apps/operator/
RUN pnpm install --frozen-lockfile --filter @opencrane/observability --filter @opencrane/operator --prod

COPY --from=build /app/libs/observability/dist libs/observability/dist
COPY --from=build /app/apps/operator/dist apps/operator/dist

USER node

CMD ["node", "apps/operator/dist/index.js"]
