-- Rollback for migration 0001 — initial schema
--
-- Drops the four tables created in 0001_initial_schema.sql.
-- Order matters: prize_payouts and earning_events reference
-- users and weekly_pools via foreign keys, so they must drop
-- first.
--
-- WARNING: this destroys all leaderboard data. Only run in
-- development or against a known-disposable database.
--
-- Wrapped in a transaction by scripts/rollback.ts — no BEGIN /
-- COMMIT here.

DROP TABLE IF EXISTS prize_payouts;
DROP TABLE IF EXISTS earning_events;
DROP TABLE IF EXISTS weekly_pools;
DROP TABLE IF EXISTS users;
