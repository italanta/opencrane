# Build stage
FROM node:22-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY control-plane/package.json control-plane/tsconfig.json control-plane/
COPY control-plane/prisma control-plane/prisma
RUN pnpm install --frozen-lockfile --filter @opencrane/control-plane

COPY control-plane/src control-plane/src
RUN pnpm --filter @opencrane/control-plane build

# Runtime stage
FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/control-plane/package.json control-plane/
COPY --from=build /app/control-plane/prisma control-plane/prisma
RUN pnpm install --frozen-lockfile --filter @opencrane/control-plane --prod

COPY --from=build /app/control-plane/dist control-plane/dist

USER node

EXPOSE 8080

CMD ["node", "control-plane/dist/index.js"]
