# NOTE: build context is the REPO ROOT (e.g. `docker build -f apps/skill-registry/deploy/Dockerfile .`),
# not the app dir — required so the @opencrane/observability workspace dependency resolves.
# Build stage
FROM node:22-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY libs/observability/package.json libs/observability/tsconfig.json libs/observability/
COPY apps/skill-registry/package.json apps/skill-registry/tsconfig.json apps/skill-registry/
RUN pnpm install --frozen-lockfile --filter @opencrane/observability --filter @opencrane/skill-registry

COPY libs/observability/src libs/observability/src
COPY apps/skill-registry/src apps/skill-registry/src
RUN pnpm --filter @opencrane/observability build
RUN pnpm --filter @opencrane/skill-registry build

# Runtime stage
FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/libs/observability/package.json libs/observability/
COPY --from=build /app/apps/skill-registry/package.json apps/skill-registry/
RUN pnpm install --frozen-lockfile --filter @opencrane/observability --filter @opencrane/skill-registry --prod

COPY --from=build /app/libs/observability/dist libs/observability/dist
COPY --from=build /app/apps/skill-registry/dist apps/skill-registry/dist

USER node

EXPOSE 5000

CMD ["node", "apps/skill-registry/dist/index.js"]
