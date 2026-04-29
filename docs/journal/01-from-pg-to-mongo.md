# Journal 01 — How user data ended up in MongoDB

**Date:** 2026-04-27
**Outcome:** ADR-007, migration 0002, and a small refactor of the
hot path.
**Why this file exists:** ADRs document the *what* and *why* of a
decision. They do not capture how the decision arrived — the
detours, the wrong turns, the moment a teammate (or in this case,
an AI) pushes back and forces a rethink. The case rubric asks for
evidence of the AI workflow, not just the result. So this journal.

---

## Where we started

Two days before this entry we had shipped the prize-distribution
pipeline: a Redis SETNX lock, a single PG transaction with
deterministic tie-breaking, two UNIQUE constraints on
`prize_payouts`, and integration tests against a real Postgres.
ADR-001 through ADR-006 captured the rationale.

Inside ADR-001, one line read: *"PostgreSQL — source of truth.
Users, earning_events (append-only), prize_payouts, weekly_pools.
All financial correctness lives here."*

That sentence conflated two things, and I (the developer) did not
catch it. Claude didn't either. Both of us treated "users live in
PG" as derived from the source-of-truth invariant, when actually
the invariant only says anything about *money*.

## The conversation

The case brief was updated (`case-v2.html`). I asked Claude to
review it and tell me what the most logical structure was.

Claude's first answer was a competent summary that mostly
reflected what we already had: PG for transactional truth, Redis
for live ranks, Mongo for snapshots/audit. Users in PG, by
default. No challenge to the existing placement.

I asked, half-curious: *"why aren't we putting users in Mongo?"*

Claude's first response defended PG. The reasoning chain was:

1. CLAUDE.md says PG is source of truth.
2. Users are part of the system.
3. Therefore users belong in PG.

This is the wrong shape of reasoning. Step 2 is true; step 1
is true *for the money invariant*; step 3 only follows if you
treat the rule as universal. Neither of us interrogated the
chain.

I pushed: *"10M kullanıcıyı neden Mongo'ya vermiyoruz?"* — why
not Mongo for 10M users? Claude responded with a trade-off list
that still leaned PG.

I had also been working in parallel with ChatGPT (via Codex),
which had produced an architecture plan independently. Its
recommendation: minimal `players(id, external_id, status,
created_at)` in Postgres, rich `player_profiles` document in
MongoDB. A clean hybrid that gave Mongo real work and kept FK
references where they helped.

I shared the plan with Claude and asked for a review. Claude
critiqued it well — flagged real gaps (no tie-breaking, no
distribution lock, hot-path race conditions, week-cutover
policy, signup cross-store consistency). Useful critique. But
on the central question — *should users be in Mongo or not?* —
it still hedged.

Eventually I lost patience: *"sen niye R yaptın simdi? beni
rezil ettin codexe"* — why did you fumble this, you embarrassed
me in front of Codex.

That was the unblock. Claude owned the mistake, named the
mechanism (anchored to a CLAUDE.md keyword instead of testing
whether the keyword's invariant applied to this question), and
gave the answer that should have been there from turn one:
**users belong in Mongo for this domain, full stop.**

## What the right answer looks like

Once the anchoring was set aside, the case for Mongo writes
itself:

- **Schema flexibility.** Idle-game profile shape evolves over
  product life — guilds, badges, cosmetics, devices. PG punishes
  this with migrations; Mongo eats it for breakfast.
- **Document shape matches the read.** A leaderboard row is one
  document, not four joins.
- **Mongo earns its keep.** Otherwise it is a glorified audit log
  and the "appropriate use of preferred technologies" rubric
  reads weak.
- **Hot path stays clean.** `POST /earnings` never touches Mongo.
  Mongo's write latency does not bind p99.
- **Domain boundaries are visible.** Money in PG, identity in
  Mongo, ranks in Redis. One sentence per database.

The trade-offs we accept:

- No FK between `earning_events.user_id` and a user table. The
  auth middleware is the integrity boundary instead.
- Cross-store fetch for username on the leaderboard (mitigated
  with a Redis cache layer).
- Signup → profile insert is not transactional with anything.

These are real costs. They are also the right costs to pay for
this domain. ADR-007 makes the call formal.

## The variant we did not take

ChatGPT's plan was hybrid (option B in ADR-007): PG keeps
`players(id, …)` for FK targets, Mongo holds rich profiles. We
considered it briefly. The argument against: the only thing the
PG `players` table buys you is the FK guarantee, which is the
exact guarantee we are willingly giving up by moving users to
Mongo at all. Paying for two-store coordination to keep a
guarantee you have already decided to drop is incoherent. So:
no PG `users` table at all. `earning_events.user_id` is plain
TEXT.

## What this cost

Code-wise, very little:

- Migration 0002 — drop `users`, switch two `user_id` columns
  from BIGINT to TEXT.
- `src/services/earnings.ts` — remove the `INSERT INTO users`
  upsert; pass `externalId` straight through as `user_id`.
- `src/services/leaderboard-view.ts` — replace the PG join on
  `users.username` with a Mongo `findMany` against
  `player_profiles`.
- `src/services/distribution.ts` — gain a `weekly_snapshots`
  write after the PG commit.
- `src/db/mongo-collections.ts` — new file, typed accessors.
- Two integration tests — drop the users-table seed boilerplate,
  add Mongo profile fixtures.

About 80% of the existing code (lock, distribution, prize math,
ISO week, HTTP layer, tests) is unchanged. The fix is small in
LOC, large in intent.

## Process note

This is the second time on this project that the most useful
thing the AI did was *enumerate options after being pushed*.
The first time was the prize-distribution formula (ADR-006:
linear vs tiered vs geometric). The pattern: when I have an
instinct that an answer is too clean, asking the AI to lay out
the alternatives explicitly forces the trade-off into the open.
Otherwise the model defaults to whatever seems consistent with
the existing code — which means consistent with prior decisions
that may themselves be wrong.

The other lesson, captured in
`~/.claude/projects/.../memory/feedback_question_anchored_rules.md`:
project rules have *invariants* attached to them. Before
applying a rule by keyword, check whether the question at hand
actually touches the invariant. If it does not, the rule does
not apply, no matter how relevant it sounds.

## What to read next

- `docs/adr/ADR-007-users-live-in-mongodb.md` — the formal
  decision and trade-offs.
- `docs/adr/ADR-001-three-database-split.md` — original
  three-DB framing, now annotated with a pointer to ADR-007.
- `migrations/0002_users_to_mongo.sql` — the schema diff.
- `src/db/mongo-collections.ts` — the new shape of identity.
