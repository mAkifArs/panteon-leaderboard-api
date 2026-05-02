import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getMongo } from '../db/mongo.ts'
import { getPostgres } from '../db/postgres.ts'
import { getRedis } from '../db/redis.ts'
import { isoWeekRange, toIsoWeek } from '../lib/iso-week.ts'
import { getOwnRankView, getTopView } from '../services/leaderboard-view.ts'
import { getCurrentPool } from '../services/pool.ts'

const TopQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  isoWeek: z
    .string()
    .regex(/^\d{4}-W\d{2}$/, 'isoWeek must be YYYY-WXX')
    .optional(),
})

const UserParamsSchema = z.object({
  // .trim() matches the normalisation applied on POST /earnings so
  // " player-1 " and "player-1" hit the same Redis member.
  userId: z.string().trim().min(1).max(100),
})

const WeekQuerySchema = z.object({
  isoWeek: z
    .string()
    .regex(/^\d{4}-W\d{2}$/, 'isoWeek must be YYYY-WXX')
    .optional(),
})

interface LeaderboardMeta {
  isoWeek: string
  weekStart: string
  weekEnd: string
  pool: bigint
}

function buildMeta(isoWeek: string, pool: bigint): LeaderboardMeta {
  const { start, end } = isoWeekRange(isoWeek)
  return {
    isoWeek,
    weekStart: start.toISOString(),
    weekEnd: end.toISOString(),
    pool,
  }
}

// Shared rate limit for the three polling endpoints. ADR-010 sized
// for 5sec polling × 2 tabs × ~10 NATed users headroom (~240/min)
// with a 2.5x cushion. Defined once so the three routes can never
// drift apart under maintenance — that drift was an explicitly
// flagged negative consequence in ADR-010.
const POLL_RATE_LIMIT = { max: 600, timeWindow: '1 minute' } as const

export function registerLeaderboardRoutes(app: FastifyInstance): void {
  app.get('/leaderboard/top', { config: { rateLimit: POLL_RATE_LIMIT } }, async (req, reply) => {
    const query = TopQuerySchema.safeParse(req.query)
    if (!query.success) {
      return reply.status(400).send({
        error: { code: 'invalid_query', message: query.error.issues[0]!.message },
      })
    }
    const isoWeek = query.data.isoWeek ?? toIsoWeek(new Date())
    const { db: mongo } = getMongo()
    const { db } = getPostgres()
    const redis = getRedis()
    const [top, pool] = await Promise.all([
      getTopView(redis, mongo, isoWeek, query.data.limit),
      getCurrentPool(redis, db, isoWeek),
    ])
    return reply.send({
      meta: buildMeta(isoWeek, pool),
      count: top.length,
      entries: top,
    })
  })

  app.get(
    '/leaderboard/me/:userId',
    { config: { rateLimit: POLL_RATE_LIMIT } },
    async (req, reply) => {
      const params = UserParamsSchema.safeParse(req.params)
      if (!params.success) {
        return reply.status(400).send({
          error: { code: 'invalid_params', message: params.error.issues[0]!.message },
        })
      }
      const query = WeekQuerySchema.safeParse(req.query)
      if (!query.success) {
        return reply.status(400).send({
          error: { code: 'invalid_query', message: query.error.issues[0]!.message },
        })
      }
      const isoWeek = query.data.isoWeek ?? toIsoWeek(new Date())
      const { db: mongo } = getMongo()
      const { db } = getPostgres()
      const redis = getRedis()
      const [view, pool] = await Promise.all([
        getOwnRankView(redis, mongo, isoWeek, params.data.userId),
        getCurrentPool(redis, db, isoWeek),
      ])

      if (view === null) {
        return reply.status(404).send({
          error: {
            code: 'unranked',
            message: `User ${params.data.userId} has no earnings this week`,
          },
        })
      }
      return reply.send({
        meta: buildMeta(isoWeek, pool),
        rank: view.rank,
        totalPlayers: view.totalPlayers,
        cluster: view.cluster,
      })
    },
  )

  // Combined endpoint: top 100 + own-rank cluster + meta in a
  // single round-trip. Matches the architecture-plan section 6
  // shape and is what the frontend hits on leaderboard mount.
  app.get(
    '/leaderboard/current/:userId',
    { config: { rateLimit: POLL_RATE_LIMIT } },
    async (req, reply) => {
      const params = UserParamsSchema.safeParse(req.params)
      if (!params.success) {
        return reply.status(400).send({
          error: { code: 'invalid_params', message: params.error.issues[0]!.message },
        })
      }
      const query = WeekQuerySchema.safeParse(req.query)
      if (!query.success) {
        return reply.status(400).send({
          error: { code: 'invalid_query', message: query.error.issues[0]!.message },
        })
      }
      const isoWeek = query.data.isoWeek ?? toIsoWeek(new Date())
      const { db: mongo } = getMongo()
      const { db } = getPostgres()
      const redis = getRedis()

      const [top, ownView, pool] = await Promise.all([
        getTopView(redis, mongo, isoWeek, 100),
        getOwnRankView(redis, mongo, isoWeek, params.data.userId),
        getCurrentPool(redis, db, isoWeek),
      ])

      return reply.send({
        meta: buildMeta(isoWeek, pool),
        top: { count: top.length, entries: top },
        // null when the user has no earnings this week — frontend
        // can render a 'You have no rank yet, play a round' state.
        me: ownView,
      })
    },
  )
}
