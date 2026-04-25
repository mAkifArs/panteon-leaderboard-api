# ADR-002: Separate repositories for client and server

- **Status:** Accepted
- **Date:** 2026-04-24
- **Deciders:** Mehmet Akif Arslan
- **Tags:** #structure #delivery

## Context

The case brief states — twice — that client and server code should
live in separate projects. Repetition in a brief is a signal, not a
coincidence.

## Decision

Two repositories: `panteon-leaderboard-api` (this repo) and
`panteon-leaderboard-web` (React + Vite frontend). No monorepo, no
shared workspace, no symlinked packages.

Shared TypeScript types are duplicated by hand. There are fewer than
ten of them and they are stable once the contract is locked.

## Consequences

### Positive

- Unambiguous compliance with the brief.
- Independent deploy pipelines — the API can ship without coupling
  to the web build.
- Clearer separation for the evaluator when reading either repo in
  isolation.

### Negative

- Type duplication. Mitigated by the small surface and by having the
  contract locked early (contract-first prompt discipline in
  `AI_WORKFLOW.md`).

### Neutral

- No shared tooling config — each repo has its own ESLint, tsconfig,
  and CI. Fine at this scale.

## Alternatives Considered

### Alternative A: Monorepo with workspaces

Slightly nicer for shared types. Rejected because the brief asks for
separate projects twice. The cost of being judged non-compliant is
higher than the cost of duplicating a handful of interfaces.

## AI involvement

Claude offered both options neutrally when asked. The call to go
strict on the brief's wording is mine.

## References

- `docs/case/case-en.html` — two references to separate projects.
