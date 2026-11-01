# syntax=docker/dockerfile:1
# SPDX-License-Identifier: Apache-2.0
# Tiresias in a container: optional, for owners who want a hard box around the MCP server (W-33, docs/docker.md).
# Same commands and same store format as on your machine. Rendering is OFF in the container: no Chrome is
# installed, because Chrome's sandbox needs privileges a hardened container takes away, and Tiresias never runs
# Chrome without its sandbox. A read that asks to render says render.status "not_allowed" (rendering off, the
# default) or "unavailable" (rendering turned on, no Chrome).
#
#   docker build -t tiresias:1.0 .
#   docker run -i --rm --init --memory 2g --memory-swap 2g --cpus 2 --pids-limit 256 \
#     --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
#     -v tiresias-store:/home/node/.tiresias tiresias:1.0 mcp

# The official Node.js 22 image (Debian bookworm, slim), pinned by its multi-arch digest (Docker Hub, 2026-10-28).
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

# ---- build: compile the TypeScript ----
FROM ${NODE_IMAGE} AS build
WORKDIR /src
# .npmrc turns install scripts off, so no package runs code while installing (as on your machine).
COPY package.json package-lock.json .npmrc ./
COPY stubs ./stubs
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc && rm -rf dist/test

# ---- run: only what the npm package holds, as the unprivileged user "node" ----
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY stubs ./stubs
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force \
 && mkdir -p /home/node/.tiresias \
 && chown node:node /home/node/.tiresias \
 && chmod 700 /home/node/.tiresias
COPY --from=build /src/dist ./dist
USER node
ENV HOME=/home/node
# The store (~/.tiresias). Mount a named volume here so it outlives the container.
VOLUME ["/home/node/.tiresias"]
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["mcp"]
