# Build stage
FROM node:22-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY operator/package.json operator/tsconfig.json operator/
RUN pnpm install --frozen-lockfile --filter @opencrane/operator

COPY operator/src operator/src
RUN pnpm --filter @opencrane/operator build

# Runtime stage
FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/operator/package.json operator/
RUN pnpm install --frozen-lockfile --filter @opencrane/operator --prod

COPY --from=build /app/operator/dist operator/dist

USER node

CMD ["node", "operator/dist/index.js"]
