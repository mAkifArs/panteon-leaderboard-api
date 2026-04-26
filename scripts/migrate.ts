/**
 * Apply pending migrations from `migrations/NNNN_*.sql`.
 *
 * State is tracked in a `_migrations` table created on first run.
 * Each forward migration runs once, in filename order.
 *
 * Usage:
 *   bun run db:migrate
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { closePostgres, getPostgres } from '../src/db/postgres.ts'

async function main(): Promise<void> {
  const { pool } = getPostgres()
  const dir = new URL('../migrations/', import.meta.url).pathname

  await pool`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  const files = (await readdir(dir))
    .filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.endsWith('.down.sql'))
    .sort()

  const appliedRows = await pool<{ filename: string }[]>`SELECT filename FROM _migrations`
  const applied = new Set(appliedRows.map((r) => r.filename))

  let count = 0
  for (const file of files) {
    if (applied.has(file)) continue
    const sqlText = await readFile(join(dir, file), 'utf8')
    console.log(`[migrate] applying ${file}`)
    // Wrap each migration in a transaction so a partial failure
    // rolls back cleanly. postgres.js rejects raw BEGIN/COMMIT
    // in user SQL, so the .sql files must not include them.
    await pool.begin(async (tx) => {
      await tx.unsafe(sqlText)
      await tx`INSERT INTO _migrations (filename) VALUES (${file})`
    })
    count++
  }

  console.log(count === 0 ? '[migrate] no pending migrations' : `[migrate] applied ${String(count)} migration(s)`)

  await closePostgres()
}

main().catch((err: unknown) => {
  console.error('[migrate] failed:', err)
  process.exit(1)
})
