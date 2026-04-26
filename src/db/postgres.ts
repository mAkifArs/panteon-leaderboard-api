import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres, { type Sql } from 'postgres'
import { loadEnv } from '../config/env.ts'
import * as schema from './schema.ts'

export type DbSchema = typeof schema
export type Database = PostgresJsDatabase<DbSchema>

let pool: Sql | undefined
let db: Database | undefined

/**
 * Lazy-init Postgres connection pool + Drizzle wrapper.
 * Safe to call multiple times — returns the same instance.
 */
export function getPostgres(): { pool: Sql; db: Database } {
  if (pool && db) return { pool, db }
  const env = loadEnv()
  pool = postgres(env.DATABASE_URL, {
    max: 20,
    onnotice: () => undefined,
  })
  db = drizzle(pool, { schema })
  return { pool, db }
}

export async function pingPostgres(): Promise<boolean> {
  const { pool } = getPostgres()
  try {
    await pool`SELECT 1`
    return true
  } catch {
    return false
  }
}

export async function closePostgres(): Promise<void> {
  if (pool) {
    await pool.end({ timeout: 5 })
    pool = undefined
    db = undefined
  }
}
