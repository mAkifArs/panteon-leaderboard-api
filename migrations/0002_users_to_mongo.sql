-- Migration 0002 — users move to MongoDB
--
-- See ADR-007: User profile data lives in MongoDB.
--
-- Schema changes:
--   1. Drop FK constraint from earning_events.user_id → users.id
--   2. Drop FK constraint from prize_payouts.user_id → users.id
--   3. Convert earning_events.user_id from BIGINT to TEXT
--      (now holds the upstream external player id directly)
--   4. Convert prize_payouts.user_id from BIGINT to TEXT
--   5. Drop the users table
--
-- The two existing indexes on (iso_week, user_id) and
-- (user_id, earned_at) are rebuilt automatically by ALTER COLUMN
-- TYPE. They remain useful for TEXT columns.
--
-- Rollback in 0002_users_to_mongo.down.sql. Note: rollback can
-- recreate the table shape but cannot reconstruct the original
-- BIGINT internal ids — the move to TEXT is one-way for any data
-- that exists. Pre-launch this is acceptable.
--
-- Wrapped in a transaction by scripts/migrate.ts.

ALTER TABLE earning_events DROP CONSTRAINT earning_events_user_id_fkey;
ALTER TABLE prize_payouts  DROP CONSTRAINT prize_payouts_user_id_fkey;

ALTER TABLE earning_events
  ALTER COLUMN user_id TYPE TEXT USING user_id::text;

ALTER TABLE prize_payouts
  ALTER COLUMN user_id TYPE TEXT USING user_id::text;

COMMENT ON COLUMN earning_events.user_id IS
  'Upstream external player id. No FK; the auth boundary is the integrity check. Profile data lives in MongoDB (ADR-007).';

COMMENT ON COLUMN prize_payouts.user_id IS
  'Upstream external player id. Matches earning_events.user_id and Mongo player_profiles._id.';

DROP TABLE users;
