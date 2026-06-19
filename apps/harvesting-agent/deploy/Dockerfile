# NOTE: build context is the REPO ROOT (e.g. `docker build -f apps/harvesting-agent/deploy/Dockerfile .`),
# not the app dir — required so the @opencrane/observability workspace dependency resolves.
# Build stage
FROM node:22-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY libs/observability/package.json libs/observability/tsconfig.json libs/observability/
COPY apps/harvesting-agent/package.json apps/harvesting-agent/tsconfig.json apps/harvesting-agent/
RUN pnpm install --frozen-lockfile --filter @opencrane/observability --filter @opencrane/harvesting-agent

COPY libs/observability/src libs/observability/src
COPY apps/harvesting-agent/src apps/harvesting-agent/src
RUN pnpm --filter @opencrane/observability build
RUN pnpm --filter @opencrane/harvesting-agent build

# Runtime stage
FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/libs/observability/package.json libs/observability/
COPY --from=build /app/apps/harvesting-agent/package.json apps/harvesting-agent/
RUN pnpm install --frozen-lockfile --filter @opencrane/observability --filter @opencrane/harvesting-agent --prod

COPY --from=build /app/libs/observability/dist libs/observability/dist
COPY --from=build /app/apps/harvesting-agent/dist apps/harvesting-agent/dist

USER node

EXPOSE 9090

CMD ["node", "apps/harvesting-agent/dist/index.js"]
