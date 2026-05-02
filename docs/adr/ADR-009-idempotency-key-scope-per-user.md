# ADR-009: Idempotency-Key uniqueness is scoped per-user, not global

- **Status:** Accepted
- **Date:** 2026-05-02
- **Deciders:** Mehmet Akif Arslan
- **Tags:** #backend #postgres #idempotency #money-safety #revision

> **Note:** This ADR revises ADR-004. The decision to keep the
> idempotency key on `earning_events` (rather than a separate
> registry) stands. Only the **uniqueness scope** changes — from
> global UNIQUE to compound UNIQUE on `(user_id, idempotency_key)`.

## Context

ADR-004 placed the idempotency token on `earning_events` as a
`TEXT NOT NULL UNIQUE` column. The UNIQUE constraint was global —
the key alone is unique across the entire table, regardless of
which user submitted it.

Re-reading the contract on the eve of delivery, this scope choice
is wrong for the public API we expose:

`POST /earnings` accepts an `Idempotency-Key` header from each
client. Clients are independent — they have no reason (and no
mechanism) to coordinate on the namespace of their keys. Two
unrelated clients can pick the same key by coincidence:

- A naive SDK that uses short tokens (`"retry-1"`, `"round-end"`,
  hash of a payload that happens to collide).
- An offline-mode mobile client that flushes its retry queue with
  deterministic keys derived from local game state.
- A test harness that hardcodes a key during integration tests on
  staging that shares its database with another test run.

With a global UNIQUE, the second arrival of any colliding key is
treated as a *replay of the first* even when the requesting user
is different. The server returns the **other user's** earning row
in the response body — wrong user_id, wrong amount, marked as
`isReplay: true`. The PG row is not corrupted (no double-credit),
but the API silently returns one user's data to a different user.
That is a confidentiality bug at minimum and a potentially
financially-confusing one (the receiving client believes its own
earning was recorded).

The fix is to scope the uniqueness to the natural domain of the
key: the user that issued it.

## Decision

The idempotency uniqueness on `earning_events` becomes
**compound** on `(user_id, idempotency_key)`:

```sql
ALTER TABLE earning_events
  DROP CONSTRAINT earning_events_idempotency_key_key;

CREATE UNIQUE INDEX earning_events_user_id_idempotency_key_key
  ON earning_events (user_id, idempotency_key);
```

The `INSERT ... ON CONFLICT` target changes accordingly:

```sql
INSERT INTO earning_events (user_id, amount, iso_week, earned_at, idempotency_key)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (user_id, idempotency_key) DO NOTHING
RETURNING ...;
```

The replay-lookup query also gains the `user_id` filter:

```sql
SELECT ... FROM earning_events
WHERE user_id = $1 AND idempotency_key = $2;
```

Migration `0003_idempotency_per_user.sql` makes this change with a
matching `.down.sql` that restores the global UNIQUE (data permitting).

## Consequences

### Positive

- **The public-API class of confidentiality bug is eliminated at
  the schema level.** Two clients can pick identical keys; each one
  inserts under their own row, neither sees the other's data. The
  guarantee is enforced by Postgres, not by trusting clients to
  coordinate.
- **The auth boundary and the dedup boundary now match.** Each user
  has their own idempotency namespace — exactly what the rest of the
  system already assumes.
- **The compound index is still useful for lookups.** Replay-path
  queries already filter by `user_id` (we know it from the request);
  the compound index serves both insert dedup and replay lookup
  with one structure.

### Negative

- **One more index column.** The compound index is wider than the
  single-column one (`TEXT user_id` + `TEXT idempotency_key`). At
  10M earning rows the storage delta is on the order of a couple
  hundred MB — negligible for the query speedup.
- **The previous schema is the wire-compatible one for any
  pre-existing client that picked deliberately-global keys.** Pre-
  launch this is a non-issue; we have no production data and no
  shipped clients depending on the old behavior.

### Neutral

- Behavior for the *common* case (each client picks UUIDv4 keys)
  is unchanged. Compound UNIQUE on UUIDv4 keys is the same dedup
  guarantee in practice — UUID collisions across users are
  vanishingly improbable. The change matters specifically when
  clients pick *non-random* keys, which is the realistic risk.

## Alternatives Considered

### Alternative A: Keep global UNIQUE, validate ownership at API layer

Read the existing row on conflict, compare its `user_id` to the
request's `user_id`, return `409 Conflict` if they differ.

Rejected because:
- The check lives in application code, not in the schema. Anyone
  bypassing the service (a script, a future internal tool) reopens
  the bug.
- It turns a correct insert into a 409, which clients have no
  reason to expect from an idempotent endpoint. Compound UNIQUE
  makes the second insert succeed, which is what an independent
  client *should* see.

### Alternative B: Hash `user_id` into the idempotency key on the server

Concatenate `user_id + ':' + idempotency_key` before inserting,
keep the column globally UNIQUE.

Rejected because it is the compound UNIQUE solution dressed up as a
string hack — the database understands compound indexes natively,
encoding the same information in a TEXT column gives nothing but
hides the intent from anyone reading the schema.

### Alternative C: Scope keys to (user_id, iso_week, idempotency_key)

Stricter still: a key only dedupes within the same user *and the
same week*. A user submitting the same key in two different weeks
would get two rows.

Rejected because:
- The week boundary is an internal concept; the client is not
  required to know about it. A retry that crosses midnight on
  Sunday would silently fall through.
- The natural unit of "the same logical earning" is the user's
  intent, not the calendar.

## AI involvement

This bug was caught during a final pre-delivery codebase walkthrough
with Claude. The model flagged the global UNIQUE with a concrete
collision scenario (two clients picking the same short retry key);
the fix path was straightforward once the failure mode was named.

The decision to revise via a new ADR (rather than edit ADR-004
in place) follows the precedent set by ADR-007 revising ADR-001 —
the audit trail of "what we believed when, and why we changed our
mind" stays readable.

## References

- ADR-004 — original placement of the idempotency key on
  `earning_events` (this ADR revises only the uniqueness scope).
- CLAUDE.md invariant 6 — idempotency on all write endpoints.
- `migrations/0003_idempotency_per_user.sql` — schema change.
- `src/services/earnings.ts` — updated `ON CONFLICT` target.
