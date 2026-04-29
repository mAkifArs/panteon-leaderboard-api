# ADR-007: User profile data lives in MongoDB, not Postgres

- **Status:** Accepted
- **Date:** 2026-04-27
- **Deciders:** Mehmet Akif Arslan
- **Tags:** #backend #mongodb #postgres #schema #revision

## Context

ADR-001 split the three databases by responsibility. In its
original form it placed users in Postgres alongside
`earning_events`, `weekly_pools`, and `prize_payouts`, justifying
the placement under the umbrella "PostgreSQL = source of truth".

Reading the v2 case brief more carefully, two things became
evident:

1. The "source of truth" invariant only meaningfully applies to
   **money** — the append-only earnings ledger, the pool state
   machine, and the payout records. These need ACID transactions,
   strong constraints, and FK integrity *between themselves*.
2. **User profile data is not money.** It does not need ACID
   transactions, has no append-only invariant, and gains nothing
   from being co-located with the earnings ledger. The brief also
   explicitly rewards "appropriate use" of each technology, and
   leaving Mongo to do snapshot-only work feels like a checkbox
   answer.

Once the conflation is broken (money invariant ≠ user invariant),
the question "where do users live?" becomes a real architectural
choice rather than a foregone conclusion.

The decision is being made before any production data has been
loaded. It is a refactor of intent, not a data migration.

## Decision

**Player profile data lives in MongoDB.** The Postgres `users`
table is removed. `earning_events.user_id` and
`prize_payouts.user_id` change from `BIGINT REFERENCES users(id)`
to plain `TEXT` columns holding the upstream game's external
player id directly. There is no FK from these columns into any
table.

MongoDB gains a primary collection:

```
player_profiles
  _id: string          // upstream external player id
  username: string
  country?: string
  level?: number
  // and any future profile fields, added without migrations
```

Plus the two write-once collections already planned in ADR-001:

- `weekly_snapshots` — frozen top-100 at week close
- `prize_distributions` — one audit doc per cron run

Postgres keeps:

- `earning_events` (append-only, idempotency, money truth)
- `weekly_pools` (state machine)
- `prize_payouts` (UNIQUE constraints prevent double-pay)

## Consequences

### Positive

- **Schema flexibility for the profile shape.** Idle-game player
  profiles accumulate fields over a product's life — badges,
  cosmetics, guild membership, A/B bucket, last-device, language.
  In Postgres each addition is a migration plus a nullable
  column; in Mongo it is a write that older docs simply do not
  carry.
- **Document-shaped reads match the frontend.** A leaderboard
  row needs `username + country + level + frame` from one place.
  Mongo returns it in one `findOne`; Postgres would need joins or
  a denormalised view.
- **Mongo earns its keep.** It is no longer a snapshot-only
  store; it is the user system of record. The "appropriate use of
  preferred technologies" rubric reads cleaner.
- **Hot path stays untouched.** `POST /earnings` writes only to
  Postgres and Redis. Mongo's write latency is irrelevant to
  request p99.
- **Domain boundaries are visible in the architecture.** Money in
  PG, identity in Mongo, ranks in Redis. Each database has a
  one-sentence description.
- **Snapshots co-locate with profiles.** When `weekly_snapshots`
  needs username/country denormalised, it reads from the same
  database, no cross-store fetch.

### Negative

- **No FK integrity between earning_events.user_id and a user
  table.** A bug in the upstream game backend could send earnings
  for a user_id that has no corresponding profile in Mongo. The
  tradeoff is acceptable: at 10M users the FK adds operational
  weight (referential cascades on delete, signup write ordering)
  for a guarantee the auth boundary is already supposed to
  provide.
- **Cross-store read for username on the leaderboard hot path.**
  Top-100 requests need username lookup in Mongo. Mitigation:
  Redis-backed cache (`user:{id}` HASH, short TTL) or a parallel
  Redis HASH alongside the sorted set. Implementation chooses
  whichever is cheaper to maintain.
- **Signup is no longer atomic with anything in PG.** New player
  → `player_profiles` insert. If a downstream `earning_events`
  insert references a profile that is not yet visible (replication
  lag), it still succeeds but the leaderboard render shows a
  fallback name. Acceptable; documented in failure modes.
- **One more system for tests to set up.** Integration tests that
  used to seed `INSERT INTO users` now seed Mongo `player_profiles`.

### Neutral

- The change is small in code size — three services and one
  migration — but large in intent. It touches an invariant that
  ADR-001 took as given.

## Alternatives Considered

### Alternative A: Keep users in Postgres (status quo from ADR-001)

The original placement. Pros: one less store on the write path,
FK integrity, single transactional boundary. Cons: Mongo
under-utilised, schema rigidity, no document-shaped reads, the
"appropriate use" rubric reads weaker.

Rejected because the only argument for it was the over-applied
"PG is source of truth" reading, which does not actually require
users to live in PG.

### Alternative B: Hybrid — minimal `users(id, created_at)` in PG, rich `player_profiles` in Mongo

PG keeps a thin reference table so FK constraints still work.
Mongo holds the rich profile. Pros: belt-and-suspenders FK
integrity. Cons: writes go to two stores at signup; semantically
redundant ("there is one user, but they live in two places");
extra operational surface.

Rejected because the FK guarantee it preserves is the same one
we are willingly giving up in the chosen design — paying for
two-store coordination to keep it makes no sense.

### Alternative C: Move snapshots to Postgres too, drop Mongo entirely

Possible but explicitly contradicts the brief's stack ("Node.js,
PostgreSQL, MongoDB, Redis. Your implementation must stay within
this stack."). Rejected on case-conformance grounds before
considering technical merit.

## AI involvement

This decision came out of a multi-turn back-and-forth that did
not go well at first. The full story is in
`docs/journal/01-from-pg-to-mongo.md`.

Short version: I (the developer) initially asked Claude where
user data should live. Claude anchored to CLAUDE.md's "PG is
source of truth" line and defended PG-for-users for several
turns. The user pushed back, citing a separate plan from
ChatGPT/Codex that put users in Mongo. Claude eventually
unblocked and gave the analysis that should have been the first
answer.

The decision itself is the developer's call. The trade-off
articulation is collaborative. The most useful AI contribution
came after the impasse — enumerating the three options
(A/B/C above) cleanly so the choice could be made on stated
grounds rather than instinct.

Lesson captured in memory
(`feedback_question_anchored_rules.md`): a project rule's scope
is bounded by the invariant it was written to protect; do not
over-apply it by keyword.

## References

- ADR-001 (this ADR supersedes the user-placement claim within it)
- `docs/journal/01-from-pg-to-mongo.md` — narrative of the
  decision process
- `migrations/0002_users_to_mongo.sql` — schema change
- `src/db/mongo-collections.ts` — typed Mongo accessors
- `docs/case/case-en.html` — brief, "appropriate use" rubric
- `~/Downloads/leaderboard-architecture-plan.md` — external
  plan (ChatGPT via Codex) that placed users in Mongo
