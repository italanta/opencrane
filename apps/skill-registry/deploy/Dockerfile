FROM node:22-slim AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 5000
CMD ["node", "dist/index.js"]
