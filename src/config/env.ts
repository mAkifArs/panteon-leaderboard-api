import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  MONGO_URL: z.string().url(),
  MONGO_DB: z.string().min(1).default('leaderboard'),

  // Comma-separated list of origins allowed by CORS. Use '*' to
  // allow any origin (dev only). Default covers the local Vite,
  // CRA, and Next.js dev ports.
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:3000,http://localhost:3001'),
})

export type Env = z.infer<typeof EnvSchema>

let cached: Env | undefined

export function loadEnv(): Env {
  if (cached) return cached
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error('[env] invalid environment:')
    console.error(JSON.stringify(parsed.error.format(), null, 2))
    process.exit(1)
  }
  cached = parsed.data
  return cached
}

export function resetEnvForTests(): void {
  cached = undefined
}
