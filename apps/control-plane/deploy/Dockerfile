# Build stage
FROM node:22-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY apps/control-plane/package.json apps/control-plane/tsconfig.json apps/control-plane/
COPY apps/control-plane/prisma apps/control-plane/prisma
RUN pnpm install --frozen-lockfile --filter @opencrane/control-plane

COPY apps/control-plane/src apps/control-plane/src
RUN pnpm --filter @opencrane/control-plane build

# Runtime stage
FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/apps/control-plane/package.json apps/control-plane/
COPY --from=build /app/apps/control-plane/prisma apps/control-plane/prisma
RUN pnpm install --frozen-lockfile --filter @opencrane/control-plane --prod

COPY --from=build /app/apps/control-plane/dist apps/control-plane/dist

USER node

EXPOSE 8080

CMD ["node", "apps/control-plane/dist/index.js"]
