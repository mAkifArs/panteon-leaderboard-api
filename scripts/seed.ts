/**
 * Seed the local stack with realistic fake leaderboard data.
 *
 * Generates N players with a tiered Pareto-like earnings
 * distribution (few whales, many casuals), spreads their events
 * across the current ISO week with random timestamps, and writes
 * to all three stores:
 *   - MongoDB  player_profiles  (one doc per user)
 *   - Postgres earning_events   (multi-row INSERT batches)
 *   - Redis    lb:week:<isoWeek> ZSET + pool:week:<isoWeek>
 *
 * Re-runnable: wipes the current week's seed-prefixed data
 * before re-seeding. Idempotency keys are deterministic
 * (`seed-<userId>-<n>`) so a re-run produces the same DB state.
 *
 * Safety: refuses to run if DATABASE_URL points at any managed
 * provider (neon, amazonaws, atlas, etc). Local dev only.
 *
 * Usage:
 *   bun run seed              # 1000 users (default)
 *   bun run seed 5000         # 5000 users
 *   bun run seed 100000       # 100k users (slower)
 */
import { sql } from 'drizzle-orm'
import { closeMongo, getMongo } from '../src/db/mongo.ts'
import { ensureMongoIndexes, playerProfiles } from '../src/db/mongo-collections.ts'
import { closePostgres, getPostgres } from '../src/db/postgres.ts'
import { closeRedis, getRedis } from '../src/db/redis.ts'
import { toIsoWeek } from '../src/lib/iso-week.ts'

// ---------------------------------------------------------------------------
// Safety guard
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env['DATABASE_URL'] ?? ''
const MANAGED_HOSTS = ['neon.tech', 'amazonaws.com', 'mongodb.net', 'upstash.io', 'render.com']
for (const host of MANAGED_HOSTS) {
  if (DATABASE_URL.includes(host)) {
    console.error(`[seed] refusing to run: DATABASE_URL points at managed provider (${host}).`)
    process.exit(2)
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const RAW_SIZE = process.argv[2] ?? '1000'
const SIZE = parseSize(RAW_SIZE)
if (!Number.isFinite(SIZE) || SIZE < 1 || SIZE > 1_000_000) {
  console.error(`[seed] invalid size: ${RAW_SIZE} (expected 1..1_000_000)`)
  process.exit(2)
}

function parseSize(raw: string): number {
  const m = /^(\d+)([km]?)$/i.exec(raw.trim())
  if (!m) return Number.NaN
  const n = Number(m[1])
  const unit = m[2]?.toLowerCase()
  if (unit === 'k') return n * 1_000
  if (unit === 'm') return n * 1_000_000
  return n
}

// ---------------------------------------------------------------------------
// Fake-data lexicons (no faker dep — keeps install lean)
// ---------------------------------------------------------------------------

const ADJECTIVES = [
  'Shadow', 'Iron', 'Crystal', 'Storm', 'Frost', 'Blaze', 'Night',
  'Dawn', 'Echo', 'Vortex', 'Silver', 'Crimson', 'Obsidian', 'Solar',
  'Lunar', 'Ember', 'Glacial', 'Mystic', 'Savage', 'Royal', 'Cosmic',
  'Phantom', 'Radiant', 'Wild', 'Ancient',
]
const NOUNS = [
  'Hunter', 'Warrior', 'Mage', 'Wolf', 'Drake', 'Phoenix', 'Knight',
  'Striker', 'Shade', 'Forge', 'Reaper', 'Ranger', 'Titan', 'Sentinel',
  'Blade', 'Fox', 'Raven', 'Serpent', 'Falcon', 'Berserker', 'Oracle',
  'Wraith', 'Nomad', 'Pilgrim', 'Champion',
]
const COUNTRIES = ['TR', 'US', 'DE', 'BR', 'JP', 'KR', 'IN', 'GB', 'FR', 'IT', 'ES', 'RU', 'PL', 'NL', 'SE']

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

function makeUsername(i: number): string {
  return `${pick(ADJECTIVES)}${pick(NOUNS)}${String(i).padStart(3, '0')}`
}

// ---------------------------------------------------------------------------
// Earnings distribution — tiered Pareto-like
// ---------------------------------------------------------------------------

interface PlayerSpec {
  userId: string
  username: string
  country: string
  events: { amount: bigint; earnedAt: Date }[]
}

function planPlayer(i: number, weekStart: Date, weekEnd: Date): PlayerSpec {
  const userId = `seed-${String(i).padStart(7, '0')}`
  const username = makeUsername(i)
  const country = pick(COUNTRIES)
  const tier = Math.random()

  // Tiered amounts: top 5% whales, next 25% mid, rest casual.
  let eventCount: number
  let amountMin: number
  let amountMax: number
  if (tier < 0.05) {
    eventCount = 20 + Math.floor(Math.random() * 30) // 20..49
    amountMin = 5_000
    amountMax = 200_000
  } else if (tier < 0.30) {
    eventCount = 10 + Math.floor(Math.random() * 15) // 10..24
    amountMin = 500
    amountMax = 10_000
  } else {
    eventCount = 1 + Math.floor(Math.random() * 9) // 1..9
    amountMin = 50
    amountMax = 1_000
  }

  const weekSpanMs = weekEnd.getTime() - weekStart.getTime()
  const events = Array.from({ length: eventCount }, () => {
    const amount = BigInt(amountMin + Math.floor(Math.random() * (amountMax - amountMin + 1)))
    const earnedAt = new Date(weekStart.getTime() + Math.random() * weekSpanMs)
    return { amount, earnedAt }
  })

  return { userId, username, country, events }
}

// ---------------------------------------------------------------------------
// Week boundary — Monday 00:00 UTC to Sunday 23:59 UTC
// ---------------------------------------------------------------------------

function weekBounds(now: Date): { start: Date; end: Date } {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const dow = d.getUTCDay() || 7 // 1..7, Mon=1
  d.setUTCDate(d.getUTCDate() - (dow - 1))
  const end = new Date(d)
  end.setUTCDate(end.getUTCDate() + 7)
  end.setUTCMilliseconds(end.getUTCMilliseconds() - 1)
  return { start: d, end }
}

// ---------------------------------------------------------------------------
// Cleanup current week's seed data
// ---------------------------------------------------------------------------

async function wipeWeek(isoWeek: string): Promise<void> {
  const { db } = getPostgres()
  const redis = getRedis()
  const { db: mongo } = getMongo()

  await db.execute(sql`DELETE FROM prize_payouts  WHERE iso_week = ${isoWeek}`)
  await db.execute(sql`DELETE FROM earning_events WHERE iso_week = ${isoWeek}`)
  await db.execute(sql`DELETE FROM weekly_pools   WHERE iso_week = ${isoWeek}`)

  await Promise.all([
    redis.del(`lb:week:${isoWeek}`),
    redis.del(`pool:week:${isoWeek}`),
  ])

  await playerProfiles(mongo).deleteMany({ _id: { $regex: '^seed-' } })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const now = new Date()
  const isoWeek = toIsoWeek(now)
  const { start: weekStart, end: weekEnd } = weekBounds(now)

  console.log(`[seed] week        = ${isoWeek} (${weekStart.toISOString().slice(0, 10)} → ${weekEnd.toISOString().slice(0, 10)})`)
  console.log(`[seed] users       = ${SIZE.toLocaleString()}`)

  const t0 = Date.now()

  // Connect (lazy clients return existing instances if already open).
  const { db: mongo } = getMongo()
  await ensureMongoIndexes(mongo)
  const { pool } = getPostgres()
  const redis = getRedis()

  console.log(`[seed] wiping existing seed data for ${isoWeek}...`)
  await wipeWeek(isoWeek)

  console.log(`[seed] planning players + events...`)
  const players: PlayerSpec[] = Array.from({ length: SIZE }, (_, i) => planPlayer(i, weekStart, weekEnd))
  const totalEvents = players.reduce((s, p) => s + p.events.length, 0)
  console.log(`[seed] planned ${totalEvents.toLocaleString()} earning events across ${SIZE.toLocaleString()} users`)

  // ---- Mongo: player_profiles ----
  console.log(`[seed] writing ${SIZE.toLocaleString()} player_profiles to mongo...`)
  const profileDocs = players.map((p) => ({
    _id: p.userId,
    username: p.username,
    country: p.country,
    createdAt: now,
    updatedAt: now,
  }))
  // insertMany with ordered:false — duplicates would error but
  // we just wiped, so this is a clean insert.
  await playerProfiles(mongo).insertMany(profileDocs, { ordered: false })

  // ---- Postgres: earning_events (batched multi-row INSERT) ----
  console.log(`[seed] writing earning_events to postgres in batches...`)
  const BATCH = 1000
  let written = 0
  let batch: {
    user_id: string
    amount: string
    iso_week: string
    earned_at: string
    idempotency_key: string
  }[] = []
  for (const p of players) {
    p.events.forEach((e, idx) => {
      batch.push({
        user_id: p.userId,
        amount: e.amount.toString(),
        iso_week: isoWeek,
        earned_at: e.earnedAt.toISOString(),
        idempotency_key: `seed-${p.userId}-${String(idx).padStart(3, '0')}`,
      })
    })
    if (batch.length >= BATCH) {
      await flushBatch(batch)
      written += batch.length
      batch = []
    }
  }
  if (batch.length > 0) {
    await flushBatch(batch)
    written += batch.length
  }
  console.log(`[seed]   wrote ${written.toLocaleString()} earning_events rows`)

  async function flushBatch(rows: typeof batch): Promise<void> {
    await pool`
      INSERT INTO earning_events ${pool(rows, 'user_id', 'amount', 'iso_week', 'earned_at', 'idempotency_key')}
    `
  }

  // ---- Redis: ZADD totals + INCRBY pool counter ----
  console.log(`[seed] populating redis ZSET + pool counter...`)
  const totalsByUser = new Map<string, bigint>()
  let totalEarnings = 0n
  for (const p of players) {
    const sum = p.events.reduce((s, e) => s + e.amount, 0n)
    totalsByUser.set(p.userId, sum)
    totalEarnings += sum
  }
  const totalPool = (totalEarnings * 2n) / 100n

  // Pipeline ZADDs in chunks of 1000.
  const lbKey = `lb:week:${isoWeek}`
  const entries = [...totalsByUser.entries()]
  for (let i = 0; i < entries.length; i += 1000) {
    const slice = entries.slice(i, i + 1000)
    const args: (string | number)[] = []
    for (const [uid, total] of slice) {
      args.push(Number(total), uid)
    }
    await redis.zadd(lbKey, ...args)
  }
  await redis.set(`pool:week:${isoWeek}`, totalPool.toString())

  // ---- Summary ----
  const elapsedMs = Date.now() - t0
  const top5 = [...totalsByUser.entries()]
    .sort(([, a], [, b]) => (b > a ? 1 : b < a ? -1 : 0))
    .slice(0, 5)

  console.log()
  console.log(`[seed] done in ${(elapsedMs / 1000).toFixed(2)}s`)
  console.log(`[seed] total earnings: ${totalEarnings.toLocaleString()}`)
  console.log(`[seed] total pool (2%): ${totalPool.toLocaleString()}`)
  console.log()
  console.log('top 5:')
  for (const [uid, total] of top5) {
    const player = players.find((p) => p.userId === uid)!
    console.log(`  ${player.username.padEnd(28)} (${player.country})  ${total.toLocaleString().padStart(14)}`)
  }

  await Promise.all([closePostgres(), closeRedis(), closeMongo()])
}

main().catch((err: unknown) => {
  console.error('[seed] failed:', err)
  process.exit(1)
})
