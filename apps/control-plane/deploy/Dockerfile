# Build stage
FROM node:22-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY libs/contracts/package.json libs/contracts/tsconfig.json libs/contracts/
COPY apps/control-plane/scripts apps/control-plane/scripts
COPY apps/control-plane/openapi.json apps/control-plane/openapi.json
COPY apps/control-plane/package.json apps/control-plane/tsconfig.json apps/control-plane/
COPY apps/control-plane/prisma apps/control-plane/prisma
RUN pnpm install --frozen-lockfile --filter @opencrane/contracts --filter @opencrane/control-plane

COPY libs/contracts/src libs/contracts/src
COPY apps/control-plane/src apps/control-plane/src
RUN pnpm --filter @opencrane/contracts build
RUN pnpm --filter @opencrane/control-plane build
# Stage generated Prisma client to a fixed path for the runtime stage
RUN find /app -path '*/node_modules/.prisma/client' -type d | head -1 | \
    xargs -I{} cp -r {} /generated-prisma

# Runtime stage
FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/libs/contracts/package.json libs/contracts/
COPY --from=build /app/apps/control-plane/package.json apps/control-plane/
COPY --from=build /app/apps/control-plane/prisma apps/control-plane/prisma
RUN pnpm install --frozen-lockfile --filter @opencrane/contracts --filter @opencrane/control-plane --prod
COPY --from=build /generated-prisma /tmp/generated-prisma
# Retrieve the generated Prisma client for the runtime stage
RUN target=$(find /app -path '*/node_modules/.prisma/client' -type d | head -1) && \
    rm -rf "$target" && \
    cp -r /tmp/generated-prisma "$target" && \
    rm -rf /tmp/generated-prisma

COPY --from=build /app/libs/contracts/dist libs/contracts/dist
COPY --from=build /app/apps/control-plane/dist apps/control-plane/dist

USER node

EXPOSE 8080

CMD ["node", "apps/control-plane/dist/index.js"]
