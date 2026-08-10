# syntax=docker/dockerfile:1
# habenula-engine container image.
#
# The build context is the tree root (the tree-root compose.yaml passes `.`).
# The canonical context is the packed OSS tree — dist/oss in the monorepo, the
# repository root for a public cloner. The monorepo root is not a supported
# context: its lockfile resolves private workspaces.
#
# The `# syntax` line pins the BuildKit frontend so the Dockerfile-adjacent
# Dockerfile.dockerignore is always honored — it keeps real secrets
# (**/.env, **/.dev.vars) out of the build context.
#
# Base pinned by index digest (amd64 + arm64, pushed 2026-07-14); digest bumps
# are reviewed like a dependency bump. workerd is a
# glibc binary — Debian, not Alpine.

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS base
WORKDIR /app

# --- prod-deps: production node_modules for the runtime stage ----------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/cli/package.json packages/cli/
COPY packages/contracts/package.json packages/contracts/
COPY packages/credentials/package.json packages/credentials/
COPY packages/governance/package.json packages/governance/
COPY packages/audit/package.json packages/audit/
COPY packages/tools/package.json packages/tools/
# npm runs the cli workspace's `prepare` (the habenula bin build) even in a
# deps-only install, and this stage carries manifests only — there is no
# build.mjs or src/ for that hook to run against. Give it an empty build.mjs
# to run as a no-op; the runtime never uses the cli bin. Dependency lifecycle
# scripts (workerd's postinstall) run normally.
RUN printf '' > packages/cli/build.mjs
RUN npm ci --omit=dev

# --- builder: the engine build (Worker bundle, module surface, daemon) --------
# One definition of the build: scripts/build.mjs is what the npm publish path
# runs too, so the image and the tarball cannot drift. The module-surface emit
# it adds over the old wrangler+tsc pair costs seconds and lands inside the
# dist/ the runtime stage already copies wholesale.
FROM base AS builder
COPY . .
RUN npm ci
RUN cd packages/engine && node scripts/build.mjs

# --- runtime ------------------------------------------------------------------
# Carries the tree sources + prod node_modules even though the Worker bundle
# inlines its deps — only miniflare is truly needed. Accepted for this
# release; a leaner image is future work. No key, no secret, in
# any layer: CREDENTIAL_ENCRYPTION_KEY arrives from the environment at run
# time (compose env_file).
FROM base AS runtime
# The slim base ships no system CA store, and workerd validates outbound TLS
# against the system store (Node's bundled CAs cover only Node code — the
# build works without this, the Worker's outbound fetches don't). Without it
# every external HTTPS call from the engine — the Anthropic API, real OAuth
# providers — fails with "TLS peer's certificate is not trusted". The
# validation harness asserts the store is present (offline check).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV HABENULA_PERSIST_ROOT=/data
COPY --from=prod-deps /app/node_modules ./node_modules
COPY . .
COPY --from=builder /app/packages/engine/dist ./packages/engine/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node", "packages/engine/dist/daemon/container.js"]
