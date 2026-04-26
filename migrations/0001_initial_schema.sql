-- Migration 0001 — initial schema
--
-- Creates the four core tables that back the leaderboard system:
--   1. users            — identity (BIGSERIAL id, external_id from the game)
--   2. earning_events   — append-only earnings audit trail
--   3. weekly_pools     — per-week prize pool with status state machine
--   4. prize_payouts    — append-only payout records
--
-- See:
--   docs/adr/ADR-001-three-database-split.md
--   docs/adr/ADR-004-idempotency-key-on-earning-events.md
--   docs/adr/ADR-005-iso-week-denormalization.md
--
-- Money is BIGINT in the smallest currency unit. No floats.
-- All timestamps are TIMESTAMPTZ; server runs in UTC.
-- Append-only invariant: never UPDATE or DELETE earning_events
-- or prize_payouts.
--
-- Rollback in 0001_initial_schema.down.sql.
--
-- The migration runner (scripts/migrate.ts) wraps each file in
-- a single transaction via postgres.js's sql.begin(); raw BEGIN
-- / COMMIT here would conflict with that, so they are omitted.

-- ---------------------------------------------------------------------------
-- 1. users
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id           BIGSERIAL    PRIMARY KEY,
  external_id  TEXT         NOT NULL UNIQUE,
  username     TEXT         NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  users               IS 'Player registry. id is internal; external_id is the game''s user id.';
COMMENT ON COLUMN users.external_id   IS 'Opaque identifier supplied by the upstream game backend.';

-- ---------------------------------------------------------------------------
-- 2. earning_events  (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE earning_events (
  id               BIGSERIAL    PRIMARY KEY,
  user_id          BIGINT       NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount           BIGINT       NOT NULL CHECK (amount <> 0),
  iso_week         TEXT         NOT NULL,
  earned_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  idempotency_key  TEXT         NOT NULL UNIQUE
);

COMMENT ON TABLE  earning_events                  IS 'Append-only earnings ledger. No UPDATE, no DELETE. Corrections are new rows with negative amounts.';
COMMENT ON COLUMN earning_events.amount           IS 'Smallest currency unit. May be negative for corrections (compensating events).';
COMMENT ON COLUMN earning_events.iso_week         IS 'ISO 8601 week, format YYYY-WXX. Denormalised at insert time (ADR-005).';
COMMENT ON COLUMN earning_events.idempotency_key  IS 'Client-supplied idempotency token. UNIQUE (ADR-004).';

CREATE INDEX earning_events_iso_week_user_id_idx ON earning_events (iso_week, user_id);
CREATE INDEX earning_events_user_id_earned_at_idx ON earning_events (user_id, earned_at);

-- ---------------------------------------------------------------------------
-- 3. weekly_pools
-- ---------------------------------------------------------------------------

CREATE TABLE weekly_pools (
  iso_week        TEXT         PRIMARY KEY,
  pool_amount     BIGINT       NOT NULL DEFAULT 0 CHECK (pool_amount >= 0),
  status          TEXT         NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open', 'distributing', 'distributed')),
  distributed_at  TIMESTAMPTZ  NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  weekly_pools             IS 'Per-week prize pool with state machine: open -> distributing -> distributed.';
COMMENT ON COLUMN weekly_pools.pool_amount IS 'Accumulated 2% pool, smallest currency unit. Mirrors Redis live counter.';
COMMENT ON COLUMN weekly_pools.status      IS 'open: accepting earnings. distributing: cron in flight. distributed: finalised.';

-- ---------------------------------------------------------------------------
-- 4. prize_payouts  (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE prize_payouts (
  id               BIGSERIAL    PRIMARY KEY,
  iso_week         TEXT         NOT NULL REFERENCES weekly_pools(iso_week) ON DELETE RESTRICT,
  user_id          BIGINT       NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  rank             INTEGER      NOT NULL CHECK (rank BETWEEN 1 AND 100),
  amount           BIGINT       NOT NULL CHECK (amount > 0),
  distribution_id  UUID         NOT NULL,
  distributed_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT prize_payouts_iso_week_user_id_key UNIQUE (iso_week, user_id),
  CONSTRAINT prize_payouts_iso_week_rank_key    UNIQUE (iso_week, rank)
);

COMMENT ON TABLE  prize_payouts                 IS 'Append-only record of prize distributions. Two UNIQUE constraints make double-payouts impossible.';
COMMENT ON COLUMN prize_payouts.rank            IS 'Final rank (1-100) at distribution time. UNIQUE per week enforces deterministic tie-breaking.';
COMMENT ON COLUMN prize_payouts.distribution_id IS 'UUID of the cron run that produced this row. Matches Mongo prize_distributions audit doc.';
