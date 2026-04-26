/**
 * Roll back the most recently applied migration by running its
 * `.down.sql` counterpart and removing the row from `_migrations`.
 *
 * Usage:
 *   bun run db:rollback
 *
 * For multiple steps back, run repeatedly.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { closePostgres, getPostgres } from '../src/db/postgres.ts'

async function main(): Promise<void> {
  const { pool } = getPostgres()
  const dir = new URL('../migrations/', import.meta.url).pathname

  const last = await pool<{ filename: string }[]>`
    SELECT filename FROM _migrations
    ORDER BY filename DESC
    LIMIT 1
  `

  if (last.length === 0) {
    console.log('[rollback] nothing to roll back')
    await closePostgres()
    return
  }

  const filename = last[0]!.filename
  const downFile = filename.replace(/\.sql$/, '.down.sql')
  const downSql = await readFile(join(dir, downFile), 'utf8')

  console.log(`[rollback] reverting ${filename} via ${downFile}`)
  // Same reason as migrate.ts: wrap in tx, .down.sql files must
  // not include raw BEGIN/COMMIT.
  await pool.begin(async (tx) => {
    await tx.unsafe(downSql)
    await tx`DELETE FROM _migrations WHERE filename = ${filename}`
  })

  console.log(`[rollback] rolled back ${filename}`)
  await closePostgres()
}

main().catch((err: unknown) => {
  console.error('[rollback] failed:', err)
  process.exit(1)
})
