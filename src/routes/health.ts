import type { FastifyInstance } from 'fastify'
import { pingMongo } from '../db/mongo.ts'
import { pingPostgres } from '../db/postgres.ts'
import { pingRedis } from '../db/redis.ts'

/**
 * GET /health
 *
 * Pings all three databases in parallel and returns their status.
 * 200 if all three are up, 503 if any are down. Used as the
 * liveness probe by Fly.io and as a smoke test in CI.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', async (_req, reply) => {
    const [postgres, redis, mongo] = await Promise.all([pingPostgres(), pingRedis(), pingMongo()])

    const allUp = postgres && redis && mongo
    const status = allUp ? 'ok' : 'degraded'

    return reply.status(allUp ? 200 : 503).send({
      status,
      checks: { postgres, redis, mongo },
    })
  })

  app.get('/', async (_req, reply) => {
    return reply.send({ name: 'panteon-leaderboard-api', status: 'ok' })
  })
}
