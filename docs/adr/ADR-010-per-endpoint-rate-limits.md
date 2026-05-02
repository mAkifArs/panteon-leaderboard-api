# ADR-010: Per-endpoint Redis-backed rate limits

- **Status:** Accepted
- **Date:** 2026-05-02
- **Deciders:** Mehmet Akif Arslan
- **Tags:** #backend #fastify #rate-limit #abuse-protection

## Context

The API is reachable directly from the public internet. The case
brief defines the auth boundary as upstream of this service (the
game backend authenticates the player and forwards `userId`); this
service trusts that boundary and exposes no auth of its own.
Without rate limiting, three abuse vectors remain open even with
the existing money-safety machinery:

1. **`POST /earnings` flood.** Idempotency-Key dedup (ADR-009) is
   per-`(user_id, key)` and only collapses *retries* of the same
   logical earning. A flood that picks a fresh `Idempotency-Key`
   on every request is N distinct PG inserts, not one — dedup
   does not catch it.
2. **`GET /leaderboard/*` scraping.** Top-100 and own-rank are
   essentially free reads (Redis O(log N), see benchmark in
   README) but at attacker volumes still cost CPU, network, and
   the Mongo profile lookup that follows.
3. **Cron-style accidental retries.** A misconfigured client (a
   crashloop, a forgotten `for` loop, a load test pointed at prod)
   can hammer the service in ways no one intended.

ADR-008 commits to the deployment being **stateless** (no sticky
sessions, N round-robin replicas behind a load balancer). That
constraint forces the rate-limit state into a shared store: an
in-memory limiter on N replicas would let through `N × limit`
requests per minute. Redis is already present (ADR-001) and is the
natural shared store.

The remaining open question is *granularity*: one global limit
that covers every endpoint, a small number of "tiers" (read /
write / demo), or a per-endpoint number defined at the route. The
endpoints have meaningfully different shapes — `POST /earnings`
is a write that mutates money, `GET /leaderboard/*` is a polling
endpoint hit every 3–5 seconds by every active client (ADR-008),
`GET /users/sample` is a one-shot demo helper, `GET /health` is
called continuously by the load balancer's liveness probe. A
single number cannot fit all four without being either too loose
on writes or too tight on polls.

## Decision

We use **`@fastify/rate-limit` (Redis-backed) with `global: false`
and per-route `config.rateLimit`**. Each route declares its own
limit at the registration site:

| Endpoint                            | Limit       | Why this number                                                                                          |
|-------------------------------------|-------------|----------------------------------------------------------------------------------------------------------|
| `POST /earnings`                    | 60/min      | An idle-game tick is at most ~one POST per second per real player; 60 leaves room for short bursts.      |
| `GET /leaderboard/top`              | 600/min     | 5 s polling × 2 tabs × ~10 NATed users ≈ 240/min; 2.5× headroom.                                         |
| `GET /leaderboard/me/:userId`       | 600/min     | Same envelope as `/top` — same shared `POLL_RATE_LIMIT` constant in code.                                |
| `GET /leaderboard/current/:userId`  | 600/min     | Same.                                                                                                    |
| `GET /users/sample`                 | 120/min     | Demo picker; mount-time + manual refresh. Tighter than polls because there's no legitimate poll pattern. |
| `GET /health`, `GET /`              | exempt      | Load-balancer liveness probe; rate-limiting it would let the LB mark a healthy replica as down.          |

Configuration:

- `keyGenerator`: default (`req.ip`). `trustProxy: true` is already
  set on the Fastify instance, so `req.ip` resolves through
  `X-Forwarded-For` correctly behind Fly.io's proxy.
- `nameSpace: 'rl:'` — short prefix to keep Redis keys legible
  alongside the existing `lb:week:`, `pool:week:`, and
  `lock:distribution:week:` prefixes.
- `skipOnError: true` — if Redis is unreachable, rate limiting
  fails *open*. Money safety is enforced by the PG idempotency
  UNIQUE constraint (ADR-009), not by the rate limiter; staying
  available during a Redis hiccup is the right trade-off.
- `redis: undefined` when `NODE_ENV === 'test'` — fall back to the
  plugin's in-memory store so unit tests don't require a live
  Redis.
- The three poll endpoints share a single `POLL_RATE_LIMIT`
  constant in `src/routes/leaderboard.ts` so they cannot drift
  apart silently when one is tuned.

## Consequences

### Positive

- **Each limit defends a stated assumption.** A reviewer reads
  the route file and sees both the number and the reason it was
  picked; the table above is the source of truth.
- **Write abuse and read abuse are separated.** A `POST /earnings`
  flood cannot consume the `/leaderboard/*` quota and vice versa,
  because they are different keys in Redis.
- **Stateless invariant preserved.** Redis-backed counter is
  shared across replicas; horizontal scaling does not multiply
  the effective limit.
- **Money safety unchanged.** Rate limit is a pre-check; the PG
  idempotency-key UNIQUE and the `prize_payouts` UNIQUE
  constraints are still the authoritative guards. Removing rate
  limiting would not introduce a money bug, only an availability
  one.
- **Observable.** Plugin emits `x-ratelimit-*` and `Retry-After`
  headers; clients can back off cleanly and log aggregators can
  alert on 429 rate.

### Negative

- **Per-endpoint maintenance burden.** A new route added to the
  service needs an explicit `config.rateLimit` block at registration.
  Forgetting it does **not** raise an error — `global: false` means
  the route is unlimited until a contributor remembers to add a
  limit. This is a silent security regression mode.
  - Mitigation today: PR template note + this ADR's table as a
    checklist; the three poll routes share a `POLL_RATE_LIMIT`
    constant so the most repeated case is centralised.
  - Mitigation tomorrow: a custom ESLint rule that flags any
    `app.get` / `app.post` without a `config.rateLimit` (or an
    explicit `rateLimit: false` opt-out). Worth the effort once
    the route count crosses ~8.
- **Limit numbers are soft estimates.** They are derived from
  the polling cadence in ADR-008 and a single back-of-envelope
  NAT assumption. Real production traffic shape is unknown until
  the service runs against a live frontend at scale; the numbers
  will need a revisit pass.
- **Redis dependency widens.** The rate-limit path now joins the
  hot read path in caring about Redis being reachable.
  `skipOnError: true` keeps requests flowing during a Redis
  outage but does mean the limiter is *off* during one. PG-side
  correctness is unaffected because the money-safety guards live
  in PG.
- **Test boilerplate.** The smoke test for rate limiting needs
  to boot a fresh `buildServer()` per case and exhaust the in-
  memory counter; the existing route-level tests don't go through
  `buildServer` so they're unaffected.

### Neutral

- Choice of `req.ip` over a `userId`-based key: the only signal
  available before validation is the IP, and the upstream auth
  boundary already covers per-user trust. A keyed-by-`userId`
  variant becomes interesting only when paid tiers or a
  trusted-internal-service tier appear.

## Alternatives Considered

### Alternative A: Single global limit (e.g. 1000/min for everything)

One number, one config block, zero per-route maintenance. New
routes inherit the limit automatically.

Rejected because the four endpoint shapes are too different. The
right write limit (60/min) would let a polling client trip itself
within 12 seconds; the right poll limit (600/min) would let a
single attacker fire 1000 `POST /earnings` per minute, which is
1000 PG inserts and 1000 Redis writes per IP per minute. There is
no number that is right for both.

### Alternative B: Tiered limits (read=600, write=60, demo=120)

A small enum of tiers, each route tagged with its tier at
registration. Cuts maintenance by collapsing repeated numbers
and gives a meaningful vocabulary ("this is a write endpoint" →
"oh, write tier is 60").

Rejected for now on cost/benefit grounds. With five endpoints,
two of which already share a constant (`POLL_RATE_LIMIT`), the
tier abstraction adds a layer of indirection without removing
much repetition. **Revisit when the route count exceeds ~8 or
when a fourth tier ("internal/trusted") needs a meaningfully
different number.**

### Alternative C: Edge-layer rate limiting (Cloudflare / Fly.io)

No application code at all; the platform edge enforces the limit
before requests hit the API. Cheaper at runtime, simpler in code.

Rejected because each edge node maintains its own counter (no
shared state), the limit semantics are coarser (usually per-IP
flat), and the edge layer has no knowledge of route-level
context (it would have to be configured per path-pattern, which
is the same maintenance burden moved into a different config
file). Also, an edge-only limit means the service has no
defence if the deployment moves off that platform — a portability
loss.

A future combination of edge (DDoS-class flood) + application
(per-endpoint semantic limits) is the steady-state answer; ADR-010
covers the application half.

### Alternative D: Per-userId (not per-IP) keying

`keyGenerator: (req) => req.body.userId`. Caps abuse from a single
account regardless of which IP it comes from.

Rejected because the trust boundary is upstream — `userId` is
attacker-controlled until upstream auth signs it, and signing is
not in scope for this service. Rate-limiting on attacker-supplied
keys is theatre. IP keying matches what the platform actually
sees.

## Revisit triggers

Re-open this ADR when one of the following holds:

1. Route count crosses ~8 — likely time for tiered limits
   (Alternative B) and an ESLint rule.
2. A paid-tier or internal-service tier appears — `keyGenerator`
   gains a fast path for trusted callers, alongside per-IP for
   anonymous ones.
3. Production p99 traffic exceeds the configured limits by more
   than ~10% on legitimate users — numbers were too tight, retune
   from observed data.
4. Edge-layer rate limiting becomes available on the deployment
   platform — combine; the app-layer numbers can then loosen,
   knowing there's a coarser flood guard upstream.

## AI involvement

Limit values, the per-endpoint vs tiered trade-off, and the
silent-regression failure mode were all worked out in conversation
with Claude. The model initially proposed a single global limit
(Alternative A) on simplicity grounds; pushing on the
write/poll/demo shape difference surfaced the per-endpoint design.
Claude also flagged the `global: false` silent-regression case as
a negative consequence I would otherwise have missed.

The decision and the specific numbers are mine; Claude was an
accelerant on enumerating consequences and turning them into
explicit revisit triggers.

## References

- ADR-001 — three-database split; Redis is already present.
- ADR-008 — stateless deployment; forces shared rate-limit state.
- ADR-009 — per-user idempotency key scope; rate limit is the
  per-IP layer that idempotency dedup cannot give.
- `src/server.ts` — plugin registration, `redis` option, `skipOnError`.
- `src/routes/earnings.ts` — `POST /earnings` per-route config.
- `src/routes/leaderboard.ts` — three poll routes + shared
  `POLL_RATE_LIMIT` constant.
- `src/routes/users.ts` — `/users/sample` per-route config.
- `src/routes/health.ts` — explicit `rateLimit: false`.
