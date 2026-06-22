# NOTE: build context is the REPO ROOT (e.g. `docker build -f apps/gateway-proxy/deploy/Dockerfile .`),
# not the app dir — required so the @opencrane/observability workspace dependency resolves.
# Build stage
FROM node:22-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY libs/observability/package.json libs/observability/tsconfig.json libs/observability/
COPY apps/gateway-proxy/package.json apps/gateway-proxy/tsconfig.json apps/gateway-proxy/
RUN pnpm install --frozen-lockfile --filter @opencrane/observability --filter @opencrane/gateway-proxy

COPY libs/observability/src libs/observability/src
COPY apps/gateway-proxy/src apps/gateway-proxy/src
RUN pnpm --filter @opencrane/observability build
RUN pnpm --filter @opencrane/gateway-proxy build

# Runtime stage
FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/libs/observability/package.json libs/observability/
COPY --from=build /app/apps/gateway-proxy/package.json apps/gateway-proxy/
RUN pnpm install --frozen-lockfile --filter @opencrane/observability --filter @opencrane/gateway-proxy --prod

COPY --from=build /app/libs/observability/dist libs/observability/dist
COPY --from=build /app/apps/gateway-proxy/dist apps/gateway-proxy/dist

USER node

EXPOSE 8090

ENV NODE_OPTIONS="--import ./apps/gateway-proxy/dist/instrument.js"

CMD ["node", "apps/gateway-proxy/dist/index.js"]
