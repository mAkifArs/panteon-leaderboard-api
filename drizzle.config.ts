import { defineConfig } from 'drizzle-kit'

/**
 * Drizzle Kit configuration.
 *
 * We do NOT use `drizzle-kit generate` to produce migration SQL.
 * Migrations live in `migrations/NNNN_*.sql` (forward) and
 * `migrations/NNNN_*.down.sql` (rollback), hand-written for
 * explicit control over CHECK constraints, COMMENTs, and index
 * naming.
 *
 * This config exists so `drizzle-kit studio` can open a visual
 * DB explorer when needed, and so `drizzle-kit introspect` can
 * be used as a sanity check that schema.ts matches the live DB.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/leaderboard',
  },
})
