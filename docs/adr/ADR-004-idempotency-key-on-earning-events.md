# ADR-004: Idempotency key as a column on `earning_events`, not a separate table

- **Status:** Accepted
- **Date:** 2026-04-26
- **Deciders:** Mehmet Akif Arslan
- **Tags:** #backend #postgres #idempotency #money-safety

## Context

`POST /earnings` is the only write endpoint in the system. Network
flakiness or aggressive client retries can deliver the same logical
earning twice within milliseconds. Without idempotency, this becomes
double-credit on the user, double 2% contribution to the weekly pool,
and ultimately a financial correctness incident.

The client is required to supply an `Idempotency-Key` header (a UUID
or similarly opaque token) on every `POST /earnings`. The server must
guarantee that two requests carrying the same key produce **at most
one** side effect — one row in `earning_events`, one pool increment,
one identical response.

The question is *where* to store the idempotency registry.

## Decision

We store the idempotency key as a **`TEXT UNIQUE NOT NULL` column on
`earning_events`** rather than as a separate `idempotency_records`
table.

The insert path becomes:

```sql
INSERT INTO earning_events (user_id, amount, iso_week, earned_at, idempotency_key)
VALUES ($1, $2, $3, NOW(), $4)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id, amount, iso_week, earned_at;
```

If the `RETURNING` clause yields no rows, the request is a duplicate —
we read the existing row by `idempotency_key` and return its data.
The pool increment runs only when a new row was inserted.

## Consequences

### Positive

- **Single source of truth.** The earning row and its idempotency
  guarantee live in the same place. There is no possible state where
  the idempotency record exists but the earning row does not, or
  vice versa.
- **One INSERT, no extra round trip.** The first version of this
  design used `INSERT INTO idempotency_records ... ON CONFLICT` first,
  then `INSERT INTO earning_events`. Two statements per request, plus
  a join on read. Collapsing to one UNIQUE column halves the work.
- **Less code, fewer concepts.** A new contributor reads the schema
  and immediately understands the dedup mechanism.
- **No coordination problem on writes.** Both the earning row and
  the dedup live in the same table — the same transaction either
  commits both or neither.

### Negative

- **Couples idempotency to earnings.** If a future write endpoint
  (e.g. profile updates, bulk corrections) also needs idempotency,
  it must either define its own `idempotency_key` column or we
  introduce a separate registry then. The migration is straightforward
  — extract the column into a side table and reference it — but it
  is one we will pay if and when the second endpoint exists.
- **The `idempotency_key` column lives forever on every earning row.**
  Hundreds of millions of rows × ~36 bytes (UUID v4 string) ≈ a few
  GB over the project's life. Acceptable.

### Neutral

- The response body is reconstructed from the existing row on a
  duplicate request rather than being stored verbatim. The contract
  of `POST /earnings` is small enough (echoes the inserted earning
  with computed pool delta) that this reconstruction is exact.

## Alternatives Considered

### Alternative A: Separate `idempotency_records` table

```sql
CREATE TABLE idempotency_records (
  key            TEXT PRIMARY KEY,
  request_hash   TEXT NOT NULL,
  response_body  JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Generic — usable for any future write endpoint. Two writes per
earning instead of one. The response is stored verbatim, so the
client gets a byte-identical response on retry.

Rejected because:
- We have one write endpoint.
- The benefits (genericness, byte-identical replay) do not earn
  their cost (extra table, extra write, extra concept) on a single
  endpoint.
- YAGNI: when the second endpoint appears, migrating to a side
  table is one ALTER + one backfill.

### Alternative B: Application-layer cache (Redis)

Store seen idempotency keys in Redis with a TTL. Fast, simple, but:

- Redis is volatile in our architecture (it is the *derived* layer,
  not the source of truth). A wipe would let duplicate requests
  through.
- TTL forces a choice between "memory grows unboundedly" and
  "duplicates outside the TTL window go through silently".
- The earning row already has to be written to Postgres atomically;
  putting the dedup somewhere else creates a coordination problem.

Rejected because the dedup must be as durable as the side effect
it guards, and the side effect is durable in Postgres.

### Alternative C: Dual write — Redis fast-path, Postgres source

Check Redis first (fast path), fall through to Postgres on miss.
Adds a moving part for no measurable latency win — Postgres dedup
on a UNIQUE-indexed TEXT column is already sub-millisecond.

## AI involvement

Claude was consulted to enumerate the trade-offs between these
three options. It initially leaned toward Alternative A (separate
table) on "future flexibility" grounds. The pushback was YAGNI:
flexibility for endpoints that do not exist is not a present-day
benefit. Claude agreed once the trade-off was framed in terms of
current vs hypothetical endpoints.

The final decision is mine, written before any implementation code
exists.

## References

- ADR-001 — three-database role split (Postgres as source of truth).
- CLAUDE.md invariant 6 — idempotency on all write endpoints.
- `.claude/skills/postgres-patterns/SKILL.md` — encodes the
  insert-with-on-conflict pattern.
