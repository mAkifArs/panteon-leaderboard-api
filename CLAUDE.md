# CLAUDE.md — Panteon Leaderboard API

Project-level rules for Claude Code. The global `~/Documents/GitHub/CLAUDE.md`
still applies (git rules, commit etiquette, tech preferences).

## What this project is

Backend API for a weekly leaderboard in an idle-game economy. Brief is in
`docs/case/case-en.html`. Frontend lives in a separate repo (see ADR-002).

## Stack

- Fastify + TypeScript (strict)
- PostgreSQL via Drizzle (source of truth)
- Redis (live leaderboard, own-rank, weekly prize pool, cron lock)
- MongoDB (weekly snapshots, prize distribution audit)
- Vitest for unit, k6 for load

## Non-negotiable invariants

Break any of these → it is a bug, not a preference.

1. **Money is BigInt in the smallest unit.** No floats, ever. Pool
   contribution: `total * 2n / 100n`, never `Math.round(total * 0.02)`.
2. **Postgres is the source of truth.** Redis and Mongo are derived —
   both must be rebuildable from PG (`/rebuild-redis` proves this).
3. **`earning_events` is append-only.** Never UPDATE, never DELETE.
   Corrections are new rows with negative amounts.
4. **Every migration is reversible.** Forward + rollback SQL, both
   tested. Use `/migrate` — it enforces this.
5. **Prize distribution runs in a single PG transaction, guarded by a
   Redis `SETNX` lock with TTL.** Never `node-cron` inside the app
   process — it fires N times on N instances.
6. **Idempotency on all write endpoints.** Client supplies
   `Idempotency-Key`; we dedupe on it.
7. **Tie-breaking is deterministic.** Two players with equal
   weekly totals are ranked by *earliest first earning timestamp
   of that week* (ASC). If still tied (same microsecond), fall
   back to smaller `earning_events.id` (earlier insert wins).
   Every ranking query — leaderboard, own-rank, prize
   distribution, replay — uses the same three-level ORDER BY.
   Required because `prize_payouts UNIQUE (iso_week, rank)` and
   replay determinism both depend on it.

## Commands

```
bun install
bun run dev            # Fastify hot reload
bun run typecheck
bun run test           # Vitest
bun run test:load      # k6 (see /benchmark)
bun run db:migrate     # Drizzle up
bun run db:rollback    # Drizzle down
bun run seed           # Default 100k users, pass N for more
```

## How we work together

Every non-trivial task runs in three phases, in this order. Do not
skip ahead — especially the first one.

1. **Discussion.** Before any code or plan, talk through the problem.
   What is the goal? What are the failure modes? What options exist
   and what are their trade-offs? Surface the "why" first. If I
   cannot re-state the problem in my own words, we are not ready to
   move on.
2. **Decision.** Once the space is clear, state the choice explicitly:
   *"We will do X because Y, not Z because W."* One sentence. If the
   decision is architectural, it also gets an ADR via `/adr <slug>`
   before implementation starts.
3. **Integration.** Only now do we write code. Implementation
   references the decision by name, tests verify the behaviour, and
   the commit message points back to the ADR or discussion summary.

I use plan mode regularly, but this sequence applies even inside plan
mode. Plan mode answers "how"; Discussion answers "why" and
"whether". Do not collapse them.

**Why this matters:** I need to understand the code we ship, not just
accept it. A skipped discussion step means a future conversation
where I cannot defend a design choice. That is not acceptable.

## Workflow rules

- Before every commit: `/review-changes`.
- Before every commit to `main` and before delivery: `/check-case`.
- New architectural decision → `/adr <slug>` and write it *before* the code.
- Schema change → `/migrate <slug>`, never hand-edit a committed migration.
- Schema conventions → the `postgres-patterns` skill auto-loads when
  touching `migrations/` or `src/db/`. Same for `redis-patterns`,
  `mongo-patterns`, `node-patterns`. Don't fight them.
- Prize distribution or money math → I read every line before commit.
  Do not ask me to "just merge it".

## Things we don't do

- No ORMs beyond Drizzle (no Prisma, no TypeORM).
- No `try/catch` around every `await`. One error middleware, structured
  JSON errors, let bugs be loud.
- No comments explaining *what* the code does. Only *why*, and only
  when the why is non-obvious.
- No WebSockets for the leaderboard. Polling is enough; decision in
  ADR-007 when we get there.
- No mixing frontend concerns into this repo. Separate project.

## Commits

- Never add `Co-Authored-By` footers.
- One decision per commit when possible; one ADR per decision.

### Pre-commit review (mandatory)

Before every `git commit`, show me what's about to land:

1. Stage specific files (never `git add -A` / `git add .`).
2. Run `git status` and `git diff --cached`.
3. Present a summary: files, draft commit message, what changes.
4. Wait for explicit "commit / evet at / tamam at" from me.
5. Only then run `git commit`.

No exceptions, even for one-line changes. If it's trivial, the
review is quick — that's fine. The review step is what makes
AI-assisted work reviewable.
