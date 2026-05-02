-- Rollback for migration 0003 — restore global UNIQUE on idempotency_key
--
-- See ADR-009 for the forward rationale.
--
-- WARNING: this rollback will fail if the table contains two or
-- more rows that share the same idempotency_key across different
-- user_ids. After 0003 such rows are legal; under the original
-- global UNIQUE they are not. For dev-only resets this is fine;
-- in production a rollback would require de-duplication first.
--
-- Wrapped in a transaction by scripts/rollback.ts.

DROP INDEX earning_events_user_id_idempotency_key_key;

ALTER TABLE earning_events
  ADD CONSTRAINT earning_events_idempotency_key_key UNIQUE (idempotency_key);
