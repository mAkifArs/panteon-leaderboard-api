import type { Collection, Db } from 'mongodb'
import { getMongo } from './mongo.ts'

/**
 * Typed accessors and shape definitions for the MongoDB
 * collections this service owns.
 *
 * See ADR-007 for why user data lives here. See ADR-001 for the
 * snapshot/audit collections.
 *
 * BigInt money values are stored as strings — Mongo's BSON does
 * not have a native bigint, and Decimal128 introduces conversion
 * footguns that the JS `BigInt`-as-string convention avoids.
 * Read-side parses with `BigInt(field)`.
 */

// ---------------------------------------------------------------------------
// player_profiles  — primary user-of-record (ADR-007)
// ---------------------------------------------------------------------------

export interface PlayerProfileDoc {
  _id: string // upstream external player id
  username: string
  country?: string
  createdAt: Date
  updatedAt: Date
}

export function playerProfiles(db: Db = getMongo().db): Collection<PlayerProfileDoc> {
  return db.collection<PlayerProfileDoc>('player_profiles')
}

// ---------------------------------------------------------------------------
// weekly_snapshots  — frozen top-100 at week close
// ---------------------------------------------------------------------------

export interface WeeklySnapshotEntry {
  rank: number
  userId: string
  username: string
  country?: string
  total: string // BigInt as string
  prize: string // BigInt as string
}

export interface WeeklySnapshotDoc {
  _id: string // ISO week, e.g. "2026-W18" — UNIQUE per week
  isoWeek: string
  generatedAt: Date
  totalPool: string // BigInt as string
  top: WeeklySnapshotEntry[]
}

export function weeklySnapshots(db: Db = getMongo().db): Collection<WeeklySnapshotDoc> {
  return db.collection<WeeklySnapshotDoc>('weekly_snapshots')
}

// ---------------------------------------------------------------------------
// prize_distributions  — one audit doc per cron run
// ---------------------------------------------------------------------------

export interface PrizeDistributionDoc {
  _id: string // runId UUID
  isoWeek: string
  runAt: Date
  totalPool: string // BigInt as string
  payouts: { rank: number; amount: string }[]
}

export function prizeDistributions(db: Db = getMongo().db): Collection<PrizeDistributionDoc> {
  return db.collection<PrizeDistributionDoc>('prize_distributions')
}

// ---------------------------------------------------------------------------
// Index setup — idempotent. Call from app boot or test fixture.
// ---------------------------------------------------------------------------

/**
 * Ensure all required indexes exist. Safe to call repeatedly:
 * createIndex with the same spec is a no-op.
 */
export async function ensureMongoIndexes(db: Db = getMongo().db): Promise<void> {
  await Promise.all([
    // player_profiles._id is the PK (unique by default). Add a
    // case-insensitive lookup index on username for future
    // username-search features (cheap; prepare for the read).
    playerProfiles(db).createIndex(
      { username: 1 },
      { collation: { locale: 'en', strength: 2 } },
    ),
    // weekly_snapshots._id == isoWeek; the field index on isoWeek
    // is redundant but explicit, used by the read API.
    weeklySnapshots(db).createIndex({ isoWeek: 1 }, { unique: true }),
    // prize_distributions: sort by isoWeek for forensic queries.
    prizeDistributions(db).createIndex({ isoWeek: 1, runAt: -1 }),
  ])
}
