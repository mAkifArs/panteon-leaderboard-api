import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getPostgres } from '../db/postgres.ts'
import { getRedis } from '../db/redis.ts'
import { recordEarning } from '../services/earnings.ts'

const BodySchema = z.object({
  // .trim() prevents silent forking when upstream auth doesn't
  // normalise — "  player-1  " and "player-1" must hash to the
  // same row. Empty-after-trim fails min(1) → 400.
  userId: z.string().trim().min(1).max(100),
  // Amount as a string for BigInt safety. Must parse as a positive
  // BigInt; we re-validate after parse.
  amount: z.string().regex(/^[1-9]\d*$/, 'amount must be a positive integer string'),
})

const HeadersSchema = z.object({
  'idempotency-key': z.string().min(1, 'Idempotency-Key header is required').max(200),
})

export function registerEarningsRoutes(app: FastifyInstance): void {
  // Rate limit: 60/min per IP. ADR-010 — write endpoint, an idle
  // game tick is at most ~one POST per second per real player.
  // Idempotency-key dedup (ADR-009) is per-user; this limit is the
  // per-IP flood guard that dedup cannot give.
  app.post(
    '/earnings',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const headers = HeadersSchema.safeParse(req.headers)
      if (!headers.success) {
        return reply.status(400).send({
          error: { code: 'invalid_headers', message: headers.error.issues[0]!.message },
        })
      }
      const body = BodySchema.safeParse(req.body)
      if (!body.success) {
        return reply.status(400).send({
          error: { code: 'invalid_body', message: body.error.issues[0]!.message },
        })
      }

      const { db } = getPostgres()
      const redis = getRedis()

      const result = await recordEarning(db, redis, {
        userId: body.data.userId,
        amount: BigInt(body.data.amount),
        idempotencyKey: headers.data['idempotency-key'],
        logger: req.log,
      })

      return reply.status(result.earning.isReplay ? 200 : 201).send(result)
    },
  )
}
