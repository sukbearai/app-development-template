# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --global pnpm@10.33.4

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/kafka/package.json packages/kafka/package.json
COPY packages/server/package.json packages/server/package.json
COPY services/worker/package.json services/worker/package.json
RUN --mount=type=cache,id=pstack-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --store-dir=/pnpm/store

FROM dependencies AS build
COPY . .
RUN pnpm --filter @pstack/web build

FROM build AS web
ENV NODE_ENV=production
ENV HOST=0.0.0.0 PORT=3000
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@pstack/web", "start", "--hostname", "0.0.0.0", "--port", "3000"]

FROM dependencies AS worker
COPY . .
ENV NODE_ENV=production
USER node
WORKDIR /app/services/worker
CMD ["node", "--import", "tsx", "src/index.ts", "async-runtime"]
