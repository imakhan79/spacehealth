# syntax=docker/dockerfile:1.7
# OMNI uplink relay. Build context is the repo root (it needs packages/):
#   docker build -f relay/Dockerfile .
# TypeScript runs directly via Node 24's built-in type stripping: no build
# step, no compiler in the image.

ARG NODE_IMAGE=node:24.22.2-alpine3.24

FROM ${NODE_IMAGE} AS deps
WORKDIR /app/relay
COPY relay/package.json relay/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=96
WORKDIR /app
RUN addgroup -S -g 1001 omni && adduser -S -u 1001 -G omni omni \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn*

COPY --from=deps --chown=omni:omni /app/relay/node_modules ./relay/node_modules
COPY --chown=omni:omni packages/uplink-protocol ./packages/uplink-protocol
COPY --chown=omni:omni relay/package.json ./relay/package.json
COPY --chown=omni:omni relay/src ./relay/src

USER omni

# Healthy = the loop is alive (it touches the heartbeat at least every 15 s,
# including while backing off during a blackout).
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const s=require('fs').statSync('/tmp/omni-relay-heartbeat');process.exit(Date.now()-s.mtimeMs<90000?0:1)"]

CMD ["node", "relay/src/main.ts"]
