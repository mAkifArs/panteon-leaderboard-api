// Shared helpers for k6 benchmark scenarios.
// Seed creates user ids `seed-NNNNNNN` for N in [0, SEED_SIZE).

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000'
export const SEED_SIZE = Number(__ENV.SEED_SIZE || 100000)


export function randomUserId() {
  const n = Math.floor(Math.random() * SEED_SIZE)
  return `seed-${String(n).padStart(7, '0')}`
}

// Idempotency keys must be unique per logical earning event;
// reusing one returns a 200 replay and skews latency low.
export function uniqueIdempotencyKey() {
  return `bench-${__VU}-${__ITER}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
