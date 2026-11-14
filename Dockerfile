# syntax=docker/dockerfile:1.7
# OMNI web: Next.js standalone build for low-resource flight hardware.
# Built on Earth (needs the npm registry), shipped as an image in the flight
# bundle; the runtime image makes no network calls of its own.

ARG NODE_IMAGE=node:24.22.2-alpine3.24

# ---- deps: install exactly what the lockfile says --------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# ---- build ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runtime: standalone server only, non-root -----------------------------
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_OPTIONS=--max-old-space-size=256

RUN addgroup -S -g 1001 omni && adduser -S -u 1001 -G omni omni \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn*

COPY --from=builder --chown=omni:omni /app/.next/standalone ./
COPY --from=builder --chown=omni:omni /app/.next/static ./.next/static
COPY --from=builder --chown=omni:omni /app/public ./public

USER omni
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
