import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { pingMongo } from '../db/mongo.ts'
import { pingPostgres } from '../db/postgres.ts'
import { pingRedis } from '../db/redis.ts'

/**
 * GET /health  (alias: /healthz)
 *
 * Pings all three databases in parallel and returns their status.
 * 200 if all three are up, 503 if any are down. Used as the
 * liveness probe by Render and as a smoke test in CI.
 *
 * Both `/health` (Render / Fastify ecosystem default) and
 * `/healthz` (Kubernetes convention) hit the same handler so the
 * service drops cleanly into either orchestrator without a config
 * change. Same rate-limit exemption applies to both.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  // /health, /healthz, and / are explicitly exempt from rate
  // limiting. Without this opt-out, a load-balancer liveness probe
  // (Render pings every 5–15 seconds per instance) would either eat
  // into a shared quota or trip its own limit and mark the instance
  // as down. `global: false` already exempts un-configured routes;
  // the explicit `rateLimit: false` here records the intent so a
  // future contributor doesn't "tighten" health by adding a default.
  const healthHandler = async (_req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const [postgres, redis, mongo] = await Promise.all([pingPostgres(), pingRedis(), pingMongo()])

    const allUp = postgres && redis && mongo
    const status = allUp ? 'ok' : 'degraded'

    void reply.status(allUp ? 200 : 503).send({
      status,
      checks: { postgres, redis, mongo },
    })
  }

  app.get('/health', { config: { rateLimit: false } }, healthHandler)
  app.get('/healthz', { config: { rateLimit: false } }, healthHandler)

  app.get('/', { config: { rateLimit: false } }, async (_req, reply) => {
    return reply.send({ name: 'panteon-leaderboard-api', status: 'ok' })
  })
}
