import './plugins/bigint-serializer.ts'

import cors from '@fastify/cors'
import sensible from '@fastify/sensible'
import Fastify, { type FastifyInstance } from 'fastify'
import { loadEnv } from './config/env.ts'
import { closeMongo } from './db/mongo.ts'
import { closePostgres } from './db/postgres.ts'
import { closeRedis } from './db/redis.ts'
import { registerErrorHandler } from './plugins/error-handler.ts'
import { registerEarningsRoutes } from './routes/earnings.ts'
import { registerHealthRoutes } from './routes/health.ts'
import { registerLeaderboardRoutes } from './routes/leaderboard.ts'
import { registerUsersRoutes } from './routes/users.ts'

export async function buildServer(): Promise<FastifyInstance> {
  const env = loadEnv()

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l' } } }
        : {}),
    },
    disableRequestLogging: false,
    trustProxy: true,
  })

  // CORS — allow the origins listed in CORS_ORIGINS. Use '*' for
  // dev wide-open. Idempotency-Key is exposed because POST
  // /earnings reads it from headers.
  const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  await app.register(cors, {
    origin: corsOrigins.includes('*') ? true : corsOrigins,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Idempotency-Key'],
  })

  await app.register(sensible)
  registerErrorHandler(app)
  registerHealthRoutes(app)
  registerEarningsRoutes(app)
  registerLeaderboardRoutes(app)
  registerUsersRoutes(app)

  return app
}

async function main(): Promise<void> {
  const env = loadEnv()
  const app = await buildServer()

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down')
    try {
      await app.close()
      await Promise.all([closePostgres(), closeRedis(), closeMongo()])
      process.exit(0)
    } catch (err) {
      app.log.error({ err }, 'error during shutdown')
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' })
  } catch (err) {
    app.log.error({ err }, 'failed to start server')
    process.exit(1)
  }
}

const isEntrypoint = import.meta.url === `file://${process.argv[1] ?? ''}`
if (isEntrypoint) {
  void main()
}
