# syntax=docker/dockerfile:1
#
# The spike as a process (yourphr#587).
#
# THE FRONTEND IS NOT BUILT HERE. The Angular app is built once, by the product repo's release
# workflow, and ships inside ghcr.io/jwilleke/yourphr. This image copies the built bundle out of
# that released image (/opt/fasten/web, the path the Go binary serves it from) — so the UI a spike
# release serves is exactly the UI a product release serves, pinned by FRONTEND_IMAGE. Bump the ARG
# when the frontend moves; the build stays a few seconds either way.
#
# MULTI-ARCH without native runners: the TypeScript compiles on the BUILD platform (its output is
# arch-independent), and the only native dependency, better-sqlite3-multiple-ciphers, ships linux
# x64 AND arm64 prebuilds, so the per-arch stages download rather than compile. No QEMU compile.
ARG FRONTEND_IMAGE=ghcr.io/jwilleke/yourphr:2.10.2

FROM ${FRONTEND_IMAGE} AS frontend

# --- compile TypeScript once, on the build platform -------------------------------------------
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
# --ignore-scripts: the repo's `prepare` hook wires git hooks, which has no business in an image.
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

# --- production dependencies for the TARGET platform ------------------------------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# --- the runtime --------------------------------------------------------------------------------
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /opt/yourphr
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json ./
# The shipped defaults are part of the product (yourphr#621): the process refuses to boot without
# them, and WORKDIR is where FileConfigProvider looks. Instance overrides live under ./data.
COPY config ./config
COPY --from=frontend /opt/fasten/web ./web
RUN mkdir -p /opt/yourphr/data && chown -R node:node /opt/yourphr
USER node

# Bootstrap only (yourphr#472): where the data lives, where the UI is, which port. Settings live in
# the config store under the data directory. Secrets (YOURPHR_DATABASE_ENCRYPTION_KEY,
# YOURPHR_BACKUP_ENCRYPTION_KEY) come from the orchestrator, never from an image.
# Names derive from the configuration keys, which carry the yourphr. prefix (yourphr#627). The
# pre-#627 SPIKE_* names are still accepted with a warning, so a deployment whose manifests have
# not been updated keeps booting; that fallback goes at the cut-over (yourphr#588).
ENV YOURPHR_STORAGE_DATA_DIR=/opt/yourphr/data \
    YOURPHR_WEB_STATIC_DIR=/opt/yourphr/web \
    YOURPHR_WEB_LISTEN_PORT=8080
EXPOSE 8080
VOLUME ["/opt/yourphr/data"]
CMD ["node", "dist/main.js"]
