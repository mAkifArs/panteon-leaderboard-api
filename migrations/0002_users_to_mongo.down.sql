-- Rollback for migration 0002 — users move to MongoDB
--
-- Recreates the users table and the two FK constraints.
--
-- WARNING: this rollback cannot reconstruct the original BIGINT
-- internal ids that earning_events.user_id and
-- prize_payouts.user_id used to hold. After 0002 those columns
-- contain the external player id (TEXT). The cast back to BIGINT
-- will fail unless those values happen to be all-numeric.
--
-- For dev-only resets where you have already truncated
-- earning_events and prize_payouts, this rollback is safe.
-- Otherwise expect ALTER COLUMN to error and roll back.
--
-- Wrapped in a transaction by scripts/rollback.ts.

CREATE TABLE users (
  id           BIGSERIAL    PRIMARY KEY,
  external_id  TEXT         NOT NULL UNIQUE,
  username     TEXT         NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE earning_events
  ALTER COLUMN user_id TYPE BIGINT USING user_id::bigint;

ALTER TABLE prize_payouts
  ALTER COLUMN user_id TYPE BIGINT USING user_id::bigint;

ALTER TABLE earning_events
  ADD CONSTRAINT earning_events_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE prize_payouts
  ADD CONSTRAINT prize_payouts_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
