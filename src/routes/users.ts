import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getMongo } from '../db/mongo.ts'
import { getRedis } from '../db/redis.ts'
import { toIsoWeek } from '../lib/iso-week.ts'
import { getSampleUsers } from '../services/leaderboard-view.ts'

const SampleQuerySchema = z.object({
  n: z.coerce.number().int().min(1).max(10).default(3),
  isoWeek: z
    .string()
    .regex(/^\d{4}-W\d{2}$/, 'isoWeek must be YYYY-WXX')
    .optional(),
})

/**
 * GET /users/sample
 *
 * Returns N users that span the leaderboard rank distribution
 * (top, middle, lower). Frontend uses this to populate the demo
 * login picker with players whose ranks demonstrate all the
 * leaderboard view states (top-100, around-me, near-bottom).
 *
 * Default n = 3, max 10. If the leaderboard has fewer than N
 * players, all of them are returned in rank order.
 */
export function registerUsersRoutes(app: FastifyInstance): void {
  app.get('/users/sample', async (req, reply) => {
    const query = SampleQuerySchema.safeParse(req.query)
    if (!query.success) {
      return reply.status(400).send({
        error: { code: 'invalid_query', message: query.error.issues[0]!.message },
      })
    }
    const isoWeek = query.data.isoWeek ?? toIsoWeek(new Date())
    const { db: mongo } = getMongo()
    const redis = getRedis()
    const users = await getSampleUsers(redis, mongo, isoWeek, query.data.n)
    return reply.send({ isoWeek, count: users.length, users })
  })
}
