---
name: adr
description: Create a new Architecture Decision Record in docs/adr/ with the next sequential number. Use whenever a non-trivial architectural decision is made, especially when AI is involved in proposing or evaluating the options.
---

# Architecture Decision Record

Produce a new ADR in `docs/adr/ADR-NNN-<slug>.md` where `NNN` is
the next three-digit sequential number after the highest existing
ADR in the directory.

## Arguments

- `<slug>` — short kebab-case identifier. Example:
  `idempotency-keys-for-earnings`.

## Procedure

1. **Find the next number.** List `docs/adr/`, extract numbers
   from `ADR-NNN-*.md`, use the max + 1 (zero-padded to 3 digits).
   If the directory doesn't exist or is empty, start at `001`.

2. **Create the file** at `docs/adr/ADR-NNN-<slug>.md` using the
   template below. Today's date (ISO-8601) goes in the Status line.

3. **Open the file for editing.** Do not populate the body
   automatically — the whole point of an ADR is that a human
   wrote the reasoning. You may propose a skeleton outline for
   each section as comments (`<!-- ... -->`) but leave the prose
   for the author.

## Template

```markdown
# ADR-NNN: <Title>

- **Status:** Proposed | Accepted | Deprecated | Superseded
- **Date:** YYYY-MM-DD
- **Deciders:** Mehmet Akif Arslan
- **Tags:** [#backend] [#postgres] [#redis] [...]

## Context

<!--
What is the forcing function? What constraints exist? What did
we know when we made this decision? Include AI involvement if any.
-->

## Decision

<!--
State the decision in the present tense, imperative voice:
"We use X for Y."
-->

## Consequences

### Positive
<!-- What gets easier? -->

### Negative
<!-- What gets harder? What are we accepting as a trade-off? -->

### Neutral
<!-- What changes but isn't better or worse? -->

## Alternatives Considered

### Alternative A: <name>
<!-- Why not? -->

### Alternative B: <name>
<!-- Why not? -->

## AI involvement

<!--
- Was an AI tool consulted? Which one?
- What did it suggest?
- What did you override, and why?
- Leave blank if no AI involvement.
-->

## References

<!-- Links to discussions, related ADRs, external docs. -->
```

## Rules

- ADR numbers never get reused, even if an ADR is deprecated.
- One decision per ADR. If you're tempted to combine two, they're
  probably not the same decision.
- "AI involvement" is not optional — even "No AI input; manual
  design call" is a valid entry. The point is to be traceable.

## Expected ADRs for this project

At minimum, ship with these (create lazily as decisions get made):

- `ADR-001-three-database-split.md`
- `ADR-002-dual-write-pg-then-redis.md`
- `ADR-003-distributed-lock-with-db-guard.md`
- `ADR-004-idempotency-keys-for-earnings.md`
- `ADR-005-bullmq-over-node-cron.md`
- `ADR-006-bigint-money-arithmetic.md`
- `ADR-007-polling-over-websockets.md`
