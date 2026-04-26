import IORedis, { type Redis } from 'ioredis'
import { loadEnv } from '../config/env.ts'

let client: Redis | undefined

/**
 * Lazy-init ioredis client. Safe to call multiple times —
 * returns the same instance.
 */
export function getRedis(): Redis {
  if (client) return client
  const env = loadEnv()
  client = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  })
  client.on('error', (err: Error) => {
    console.error('[redis] error:', err.message)
  })
  return client
}

export async function pingRedis(): Promise<boolean> {
  const r = getRedis()
  try {
    const reply = await r.ping()
    return reply === 'PONG'
  } catch {
    return false
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    client.disconnect()
    client = undefined
  }
}
