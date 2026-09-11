# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS base
RUN apk add --no-cache libcrypto3=3.5.8-r0 libssl3=3.5.8-r0
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json ./
COPY scripts/toolchain-lock.json ./toolchain-lock.json
RUN node <<'INSTALL_PNPM'
const { execFileSync } = require("node:child_process");
const { packageManager } = require("./package.json");
const { pnpm } = require("./toolchain-lock.json");
const { createHash } = require("node:crypto");
const { writeFileSync, unlinkSync } = require("node:fs");
if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageManager)) {
  throw new Error("packageManager must pin an exact pnpm version");
}
if (packageManager !== `pnpm@${pnpm.version}`) throw new Error("pnpm toolchain mismatch");
(async () => {
  const response = await fetch(`https://registry.npmjs.org/pnpm/-/pnpm-${pnpm.version}.tgz`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error("pnpm download failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== pnpm.integrity) throw new Error("pnpm integrity mismatch");
  writeFileSync("/tmp/pnpm.tgz", bytes);
  execFileSync("npm", ["install", "--global", "/tmp/pnpm.tgz"], { stdio: "inherit" });
  unlinkSync("/tmp/pnpm.tgz");
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
INSTALL_PNPM
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/kafka/package.json packages/kafka/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY services/worker/package.json services/worker/package.json

FROM manifests AS dependencies
RUN --mount=type=cache,id=pstack-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --store-dir=/pnpm/store

FROM dependencies AS build
COPY . .
RUN pnpm --filter @pstack/web build

FROM manifests AS web-dependencies
RUN --mount=type=cache,id=pstack-pnpm,target=/pnpm/store pnpm --filter . --filter @pstack/web... install --prod --frozen-lockfile --store-dir=/pnpm/store

FROM web-dependencies AS web
COPY . .
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN --mount=type=cache,id=pstack-pnpm,target=/pnpm/store pnpm --filter . --filter @pstack/web... install --prod --offline --frozen-lockfile --store-dir=/pnpm/store
ENV NODE_ENV=production
ENV HOST=0.0.0.0 PORT=3000
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
EXPOSE 3000
WORKDIR /app/apps/web
CMD ["node", "scripts/start.mjs", "--hostname", "0.0.0.0", "--port", "3000"]

FROM manifests AS worker-dependencies
RUN --mount=type=cache,id=pstack-pnpm,target=/pnpm/store pnpm --filter . --filter @pstack/worker... --filter @pstack/server... install --prod --frozen-lockfile --store-dir=/pnpm/store

FROM worker-dependencies AS worker
COPY . .
RUN --mount=type=cache,id=pstack-pnpm,target=/pnpm/store pnpm --filter . --filter @pstack/worker... --filter @pstack/server... install --prod --offline --frozen-lockfile --store-dir=/pnpm/store
ENV NODE_ENV=production
USER node
WORKDIR /app/services/worker
CMD ["node", "--import", "tsx", "src/index.ts", "async-runtime"]
