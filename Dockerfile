# Multi-stage Bun build for Koyeb / any container host.
#
# Stage 1 — install deps with the lockfile so prod runtime is
# reproducible. We don't compile TS ahead of time: Bun runs .ts
# directly (server.ts is the entrypoint), so a "build" step would
# only add complexity without runtime gain.
#
# Stage 2 — slim runtime image with only node_modules + source.
# Tests, benchmarks, ADRs, and tooling are stripped via .dockerignore.
#
# Health check hits /health which pings PG + Redis + Mongo; the
# orchestrator (Koyeb) re-uses the same endpoint as its liveness
# probe so a degraded DB connection eventually marks the instance
# unhealthy and triggers a restart.

FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY drizzle.config.ts ./

EXPOSE 3000

# Bun runs TypeScript natively — no build step.
CMD ["bun", "run", "src/server.ts"]
