# AI Workflow — Backend (API)

This document describes how I worked with AI — specifically Claude Code
(Opus 4.7, 1M context) running inside cmux — to deliver this case at a
level I could not have reached alone in the same window.

It is deliberately honest. I am not going to claim I caught AI mistakes
in areas where I have no experience. I am going to explain how I got
professional output from a toolchain, in domains where my own depth
was uneven.

---

## Starting honesty

Before I describe the process, the baseline:

- I have strong TypeScript, React, Node.js, and general web-backend
  experience.
- I have **limited hands-on Redis** experience. Before this project I
  had used it for basic caching, not sorted sets, not distributed
  locks, not real leaderboards.
- I have **limited hands-on MongoDB** experience in production.
- I have never shipped a weekly prize-payout system before.

So the question was never "can AI help me?" It was: *how do I use AI
to deliver a production-grade system in areas where my experience is
shallow, without producing something I do not understand?*

The rest of this document is that answer.

---

## The operating principle

**AI writes drafts. I own decisions and understanding.**

Concretely, for every non-trivial piece of this system I worked in
three passes:

1. **Ask why before how.** Before any code, I ask Claude to explain
   the *problem space* — failure modes, trade-offs, standard
   solutions, what breaks at scale. I do not move to implementation
   until I can re-state the problem in my own words.
2. **Draft and dissect.** Claude writes a first version. I do not
   accept it as a black box — I read it line by line and ask "why
   this over that" for each non-obvious choice. If I cannot defend
   a line in an interview, it does not ship.
3. **Verify with a test, not a vibe.** Every critical piece
   (distribution, ranking, own-rank cluster) has a test that fails
   if the behaviour drifts. Passing tests are the only acceptance
   signal — "the code looks right" is not.

This produced code I can explain, even in areas I learned on this
project.

---

## Tooling

- **Claude Code (Opus 4.7, 1M context)** in cmux, terminal-first.
  No IDE-embedded assistants. All AI interactions happen in a
  terminal pane next to my editor pane.
- **Backend and frontend are in separate cmux sessions.** Mixing
  them caused the model to conflate React and Node concerns in a
  previous project, so I isolate contexts now as a rule.
- **Slash commands I actually use:**
  - `/review-changes` before every commit — lint, type-check,
    tests, security pass.
  - `/check-case` before every commit to `main` and before delivery —
    requirement-by-requirement diff against the brief.
  - `/simplify` after a feature lands — reuse and redundancy review.
  - `/loop` for polling long-running operations (seed, deploy).

---

## The biggest multiplier: project-specific skills

The single highest-leverage thing I did with AI on this project was
**not writing code with it.** It was building a per-project skill
system so that every future AI interaction in this repo is already
framed by the project's invariants.

I wrote twelve skills in `.claude/skills/`:

- `postgres-patterns` — schema conventions, BigInt money, append-only
  `earning_events`, idempotency-key rules.
- `redis-patterns` — key naming, TTL policy, pipelining rules, what
  Redis must NOT be used for.
- `mongo-patterns` — which collections are write-mostly vs read-mostly.
- `node-patterns` — Fastify route layout, error middleware, BigInt
  JSON serialisation.
- `seed`, `benchmark`, `rebuild-redis`, `replay-week`, `check-case`,
  `migrate`, `adr`, and more.

These mean I do not have to explain "store money as BigInt" or
"earning_events is append-only" every time I start a new Claude
conversation. The invariants are encoded once, applied everywhere.

Without this, AI-assisted development in a multi-database system
produces inconsistent code across files, because each session starts
from zero context. With this, every session inherits the same
professional baseline.

This is the single idea I would bring into a team: **don't prompt the
same rules repeatedly, codify them.**

---

## Prompt patterns that produced the best output

1. **Contract-first.** Before any implementation, I ask Claude to
   write the TypeScript types and an OpenAPI-style sketch of the
   endpoint. Once the contract is agreed, the implementation prompt
   references it by name. This stops the model from reinventing the
   schema mid-file.

2. **Failure-modes-first.** For anything touching money or cron,
   my first prompt is: *"Do not write code yet. Walk me through the
   failure modes."* This suppresses the model's default to produce
   working-looking code before the problem is understood.

3. **Red-team prompts.** After writing prize distribution I asked:
   *"Pretend you are trying to steal money from this system. What are
   three attack vectors?"* It surfaced a race condition between
   earning credit and the weekly reset cutoff that I then guarded
   with a transaction-level lock. This kind of adversarial prompting
   is where AI excels — it is faster at enumerating failure cases
   than I am.

4. **Teach-me prompts.** For Redis sorted sets specifically, I asked
   Claude to explain the difference between `ZRANGEBYSCORE`,
   `ZREVRANGE`, and `ZRANGE ... REV` *before* writing any code,
   including what each one returns for ties and empty sets. I can
   now defend the choice, not just recite it. Anything I cannot
   defend does not ship.

---

## Areas I explicitly verified myself

For these, AI drafts were not enough:

- **Prize distribution.** The weekly cron moves real in-game currency
  to the top 100. A bug here is not cosmetic — it is double-payout or
  missing-payout. I read every line, and I wrote `/replay-week` so
  that any past week's distribution can be recomputed deterministically
  and diffed against what actually ran.
- **Money math.** All currency is stored as BigInt integers in the
  smallest unit. No floats anywhere — the `/postgres-patterns` skill
  enforces this at review time.
- **Distributed lock on the cron.** A Redis `SETNX` with TTL, so
  horizontal scaling does not double-fire the payout. This is
  described in ADR-003.
- **Ranking edge cases.** Player at rank 2 (no "3 above"), last-ranked
  player (no "below"), tied on zero, never-earned. Each one has a
  dedicated test.

The rule for these areas is simple: **green tests or it does not ship.**

---

## What I did without AI

- The three-database role split (PG / Redis / Mongo). Documented in
  ADR-001 with the trade-offs I walked through.
- The decision to store currency as BigInt.
- The delivery-date strategy around the 1 May holiday (see `TIMING.md`).
- The tie-breaking rule for equal scores (earliest earning timestamp
  of the week wins).
- The skill system itself — twelve per-project skills, which is the
  scaffolding the rest of the work sits on.

## What I did with AI

- Fastify + TS scaffolding, `tsconfig`, ESLint, Drizzle setup.
- Seed script for 2M users (Pareto distribution to mimic idle-game
  economies — few whales, many casuals). Claude wrote the bulk-insert
  chunks; I tuned batch sizes empirically.
- Test fixtures and happy-path unit tests.
- First draft of Dockerfile and `fly.toml`.
- README prose polish.
- This document — structure and voice are mine; Claude helped with
  phrasing passes that I then edited line by line.

---

## The honest summary

Without AI I could still build this system, but not at this depth and
not in this window. Redis sorted-set expertise, MongoDB aggregation
pipelines, and k6 load-test scripting would have each cost me a day
of ramp-up. With AI they cost me hours.

AI did not make the decisions. It made me faster at learning the
material I needed to make them well. Every architectural call in this
repo has an ADR with my name on it and a reason I can defend in a
review.

That is the workflow I would bring to a team: **AI as an accelerant
on understanding, not a substitute for it.**
