import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Drizzle schema mirroring `migrations/0001_initial_schema.sql`.
 *
 * The SQL file is the source of truth for what runs in the
 * database; this TypeScript schema gives us typed query building
 * via Drizzle ORM. Both must stay in sync — if you change one,
 * change the other.
 */

export const users = pgTable('users', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  externalId: text('external_id').notNull().unique(),
  username: text('username').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const earningEvents = pgTable(
  'earning_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    isoWeek: text('iso_week').notNull(),
    earnedAt: timestamp('earned_at', { withTimezone: true }).notNull().defaultNow(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
  },
  (t) => [
    index('earning_events_iso_week_user_id_idx').on(t.isoWeek, t.userId),
    index('earning_events_user_id_earned_at_idx').on(t.userId, t.earnedAt),
    check('earning_events_amount_check', sql`${t.amount} <> 0`),
  ],
)

export const weeklyPools = pgTable(
  'weekly_pools',
  {
    isoWeek: text('iso_week').primaryKey(),
    poolAmount: bigint('pool_amount', { mode: 'bigint' }).notNull().default(0n),
    status: text('status', { enum: ['open', 'distributing', 'distributed'] })
      .notNull()
      .default('open'),
    distributedAt: timestamp('distributed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('weekly_pools_pool_amount_check', sql`${t.poolAmount} >= 0`)],
)

export const prizePayouts = pgTable(
  'prize_payouts',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    isoWeek: text('iso_week')
      .notNull()
      .references(() => weeklyPools.isoWeek, { onDelete: 'restrict' }),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    rank: integer('rank').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    distributionId: uuid('distribution_id').notNull(),
    distributedAt: timestamp('distributed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('prize_payouts_iso_week_user_id_key').on(t.isoWeek, t.userId),
    unique('prize_payouts_iso_week_rank_key').on(t.isoWeek, t.rank),
    check('prize_payouts_rank_check', sql`${t.rank} BETWEEN 1 AND 100`),
    check('prize_payouts_amount_check', sql`${t.amount} > 0`),
  ],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type EarningEvent = typeof earningEvents.$inferSelect
export type NewEarningEvent = typeof earningEvents.$inferInsert
export type WeeklyPool = typeof weeklyPools.$inferSelect
export type NewWeeklyPool = typeof weeklyPools.$inferInsert
export type PrizePayout = typeof prizePayouts.$inferSelect
export type NewPrizePayout = typeof prizePayouts.$inferInsert
