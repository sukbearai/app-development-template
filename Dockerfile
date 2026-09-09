# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json ./
RUN node <<'INSTALL_PNPM'
const { execFileSync } = require("node:child_process");
const { packageManager } = require("./package.json");
if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageManager)) {
  throw new Error("packageManager must pin an exact pnpm version");
}
execFileSync("npm", ["install", "--global", packageManager], { stdio: "inherit" });
INSTALL_PNPM

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/kafka/package.json packages/kafka/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/sdk/package.json packages/sdk/package.json
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
WORKDIR /app/apps/web
CMD ["node", "scripts/start.mjs", "--hostname", "0.0.0.0", "--port", "3000"]

FROM dependencies AS worker
COPY . .
ENV NODE_ENV=production
USER node
WORKDIR /app/services/worker
CMD ["node", "--import", "tsx", "src/index.ts", "async-runtime"]
