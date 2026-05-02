-- Migration 0003 — idempotency key uniqueness becomes per-user
--
-- See ADR-009: Idempotency-Key uniqueness is scoped per-user.
--
-- Schema change:
--   1. Drop the existing global UNIQUE constraint on idempotency_key.
--   2. Create a compound UNIQUE index on (user_id, idempotency_key).
--
-- Why: with a global UNIQUE, two unrelated clients picking the same
-- key by coincidence would have the second arrival treated as a
-- replay of the first — and the API would return the wrong user's
-- earning row. Compound UNIQUE makes the dedup scope match the
-- natural namespace of the key (the user that issued it), enforced
-- at the schema level.
--
-- Insert path (services/earnings.ts) updates ON CONFLICT target to
-- (user_id, idempotency_key). Replay-lookup query gains a user_id
-- filter.
--
-- Rollback in 0003_idempotency_per_user.down.sql.
--
-- Wrapped in a transaction by scripts/migrate.ts.

ALTER TABLE earning_events
  DROP CONSTRAINT earning_events_idempotency_key_key;

CREATE UNIQUE INDEX earning_events_user_id_idempotency_key_key
  ON earning_events (user_id, idempotency_key);

COMMENT ON INDEX earning_events_user_id_idempotency_key_key IS
  'Per-user idempotency dedup. See ADR-009.';
