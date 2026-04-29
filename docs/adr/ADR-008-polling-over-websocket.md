# ADR-008: Polling over WebSocket for live leaderboard updates

- **Status:** Accepted
- **Date:** 2026-04-27
- **Deciders:** Mehmet Akif Arslan
- **Tags:** #backend #frontend #architecture #realtime

## Context

The case brief calls the original leaderboard "barely working" with
two recurring complaints:

> "The leaderboard takes forever to load."
> "I can see the top players fine, but I can't find my own rank."
> "My friend is in the top 50 but the page just freezes when I scroll."

The product ask:

> "Make the leaderboard instant. Players should see their own rank
> and the players around them. Rewards should go out automatically
> at the end of the week."

"Instant" here is ambiguous. It could mean:
1. **Fast load** — open the screen, see the data with no delay.
2. **Real-time push** — when someone earns coins, every viewer's
   ranks update immediately, without a refresh.

The reading determines a lot. (1) is solved by Redis sorted sets +
top-100 in single-digit milliseconds. (2) implies WebSocket or
Server-Sent Events with per-user fan-out.

The brief also lists this hard architectural constraint:

> "Architecture of the system should be stateless"

Whatever we choose has to satisfy that.

## Decision

**Frontend polls `GET /leaderboard/current/:userId` every 3-5
seconds. No WebSocket, no SSE, no long-polling.**

The "live" feel comes from:
- Short polling interval (3-5s) backed by React Query's
  stale-while-revalidate (cached UI stays interactive while the
  background fetch refreshes it).
- Smooth UI animations on rank change (Framer Motion `layout`
  transitions on the row list).
- Optional optimistic update on the user's own POST /earnings
  (`newRank` in the response, applied locally before the next
  poll).

If a future product decision demands true push, this ADR is the
inflection point — see ADR-009 (then unwritten) for the path to
SSE or sticky-session WebSocket.

## Consequences

### Positive

- **Stateless invariant preserved.** Any API instance can serve
  any request; load balancer routing is round-robin without
  sticky sessions; horizontal scaling is trivial.
- **Operational simplicity.** No connection pool to manage, no
  per-client memory, no fan-out subscription bookkeeping. A
  Redis outage doesn't disconnect 2M live sockets.
- **Cache-friendly.** Top-100 responses are identical across
  users for the same week and limit; an HTTP cache or CDN can
  absorb ~80%+ of the read traffic for free.
- **Resilient to client failures.** A polling client that goes
  to sleep or loses network just resumes on next interval; no
  reconnect / backoff logic needed.
- **Matches the dominant UX pattern of idle games.** Players
  glance at a leaderboard every few seconds at most; saving the
  delta between "5s ago" and "now" is invisible.

### Negative

- **Update latency = polling interval.** Worst case: a user
  earned coins 4.9s ago and other viewers haven't seen it yet.
  For a leaderboard this is fine; for a chess match clock it
  wouldn't be.
- **Wasted requests when nothing changed.** At 5s polling and
  2M DAU peak, that's 400k req/s of "nothing changed" reads.
  Mitigated by Redis being O(log N) on top-100 (sub-ms) and
  HTTP caching at the CDN edge for shared responses.
- **No way to push admin events to clients.** If we ever add
  "the week just ended, refresh now" or "you won a prize",
  there's no server-initiated channel. We'd have to surface
  these in the next poll's response.

### Neutral

- The decision can be revisited if real-time push becomes a
  requirement. The hot-path code (Redis sorted set + PG truth)
  is unchanged either way; only the transport layer differs.

## Alternatives Considered

### Alternative A: WebSocket with Redis pub/sub fan-out

Each connected client subscribes to a per-user channel; every
POST /earnings publishes an event; subscribed clients receive
the new rank/score. True real-time, dramatic demo.

Rejected on three grounds:

1. **Stateless invariant violation.** WebSocket connections
   live on a specific replica. Either we accept stateful
   replicas (and the operational mess that brings) or we add
   sticky-session routing (cheap to add, expensive to scale —
   one hot key takes down one replica disproportionately).
2. **Fan-out cost.** Determining "who needs to see this earn
   event" is non-trivial: users viewing top-100 (anyone whose
   filtered top changes), users whose own-rank window happens
   to include the earner, etc. The alternative — broadcast
   every event to every client — wastes bandwidth at 2M DAU
   peak.
3. **Brief explicitly says stateless.** Building stateful
   transport then arguing the invariant is "soft" is the wrong
   answer for an interview.

### Alternative B: Server-Sent Events (SSE)

One-way push from server to client, simpler protocol than
WebSocket, works over HTTP/1.1. Same fan-out problem; same
stateless violation. Rejected for the same reasons as A.

### Alternative C: Long-polling

Client opens a request that the server holds until a relevant
event happens (or a timeout). Pseudo-real-time without
WebSocket framing. Still stateful in the sense that the server
holds open connections; still has fan-out cost. Rejected.

### Alternative D: Polling at 1s

Lower the interval to feel more "live". Rejected on cost: 1s
× 2M DAU = 2M req/s baseline, mostly identical responses.
Polling at 3-5s is the sweet spot — low enough to feel current,
high enough to be cheap.

## AI involvement

Claude initially leaned toward "let's add WebSocket for the
demo" because the stateful trade-off was easy to underweight in
a single-instance dev setup. Pushing on the brief's stateless
invariant is what surfaced the real cost. The four-reason
breakdown above came out of a back-and-forth where I asked for
the strongest case against WebSocket — Claude is good at
enumerating trade-offs once the question is framed as
"steelman the alternative".

The decision itself is mine; the case for polling lines up with
the brief's explicit constraint, and the demo polish that the
"Live Demo Panel" wants is achievable purely with smooth UI
transitions on top of polling.

## References

- `docs/case/case-en.html` — brief, "stateless" requirement and
  the load-time complaints that "instant" actually refers to.
- ADR-001 — three-database split; the Redis sorted-set choice
  that makes top-100 sub-ms is what enables polling to feel
  live without push.
- `src/routes/leaderboard.ts` — the `/leaderboard/current/:userId`
  combined endpoint that the polling loop hits.
