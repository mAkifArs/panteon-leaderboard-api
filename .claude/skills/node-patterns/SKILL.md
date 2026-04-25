---
name: node-patterns
description: Project-specific Node.js / Fastify / TypeScript conventions for the leaderboard API. Loads when working on routes, services, repositories, error handling, logging, BigInt serialisation, validation, config, or anything in src/.
---

# Node.js Patterns — Leaderboard Project

Conventions for the **backend API** specifically. Claude knows
Node and TypeScript; this skill teaches the choices made here.

## Framework: Fastify, not Express

- Chosen for 2-3x throughput over Express, native JSON schema
  validation, and TypeScript-first plugin ecosystem.
- All route handlers are **async** and return the response
  object (no `res.send()` style).
- Request/response validation is **mandatory** on every route —
  Zod schemas compiled via `fastify-type-provider-zod`.

## Project layout

```
src/
├── app.ts                 // Fastify app factory, no side effects
├── server.ts              // Entry point: build app + listen
├── config/
│   └── env.ts             // Zod-validated env schema, single source
├── plugins/               // Fastify plugins (db connections, auth, etc.)
├── routes/
│   ├── earnings.ts        // POST /earnings
│   ├── leaderboard.ts     // GET /leaderboard/top100, GET /leaderboard/me
│   └── healthz.ts
├── services/              // Business logic, framework-agnostic
│   ├── earning.service.ts
│   ├── leaderboard.service.ts
│   └── distribution/
│       ├── calculate.ts   // Pure function, no I/O
│       ├── execute.ts     // Orchestrator: lock + tx + write
│       └── replay.ts      // Audit replay (used by /replay-week)
├── repositories/          // DB access, one subfolder per DB
│   ├── postgres/
│   ├── redis/
│   └── mongo/
├── workers/
│   └── distribution.worker.ts  // BullMQ processor
├── errors/
│   └── index.ts           // Typed error classes
├── lib/
│   ├── logger.ts          // pino instance
│   ├── bigint-json.ts     // JSON (de)serialisation helpers
│   └── week.ts            // ISO week utilities
└── db/
    └── schema.ts          // Drizzle schema
```

## Rules

### Separation of concerns

- **Routes** validate input, call services, format output. No
  business logic, no DB calls directly.
- **Services** implement business rules. Stateless. Take
  repositories as constructor dependencies (or passed as args).
- **Repositories** wrap DB clients. One class per aggregate
  (users, earnings, payouts, snapshots, leaderboard).

A route must never import from `src/db/` or call redis/pg
clients directly. Test: grep routes for `import.*db` — zero
results.

### Dependency injection

- Fastify plugins register clients (pg pool, redis client, mongo
  client, BullMQ queue) on the app instance.
- Services access them via `app.pg`, `app.redis`, `app.mongo`.
- Tests replace these with fakes via plugin overrides. No global
  singletons.

### BigInt handling

- Money amounts flow through as `bigint`.
- JSON.stringify does not support bigint natively. Use the
  project's serialiser in `src/lib/bigint-json.ts`:

  ```typescript
  BigInt.prototype.toJSON = function () { return this.toString() }
  ```

  Registered once globally in `src/server.ts`. API responses
  return amounts as strings; clients parse back to BigInt or
  display directly.

- **Never** cast bigint to Number for arithmetic. Only for
  Redis scores (which are doubles) where values are known-safe.

### Error handling

- All errors extend `AppError` (in `src/errors/index.ts`):

  ```typescript
  class AppError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode: number,
      public cause?: unknown,
    ) { super(message) }
  }
  ```

- Concrete classes: `LockContendedError`, `DistributionAlreadyRunError`,
  `IdempotencyKeyReusedError`, `UserNotFoundError`, etc.
- Route handlers do not wrap in try/catch. Errors bubble to the
  single error handler plugin which:
  - Logs with request ID and error code.
  - Returns JSON `{ error: { code, message } }`.
  - Sets status from `error.statusCode`.

**Anti-pattern:** wrapping every `await` in try/catch with a
generic `"something went wrong"` response. Delete these on
sight.

### Logging

- `pino` via `fastify-pino`. One logger instance per request,
  accessible as `request.log`.
- Structured fields always — never string interpolation of data:

  ```typescript
  // Good
  request.log.info({ userId, amount }, "earnings recorded")
  // Bad
  request.log.info(`earnings recorded for ${userId}: ${amount}`)
  ```

- Log levels:
  - `debug` — dev-only detail.
  - `info` — business events (earning recorded, distribution started).
  - `warn` — expected failure modes (idempotency key reused).
  - `error` — unexpected failures. Paged in prod.

### Config

- `src/config/env.ts` defines a Zod schema for all env vars.
- Parsed once at startup. Invalid config fails hard before
  listening.
- **No** `process.env.X` access outside this file. Anywhere else
  is a lint error.

### Validation

- Every route defines its schema via Zod:

  ```typescript
  const earningBody = z.object({
    userId: z.string().uuid(),
    amount: z.string().regex(/^\d+$/).transform(v => BigInt(v)),
    idempotencyKey: z.string().uuid(),
  })
  ```

- Body, query, params, headers all validated.
- Responses also have schemas. Fastify validates outbound.

### Stateless guarantee

- No module-level mutable state in request-serving code. Grep
  test: `grep -rn "^let " src/routes src/services` must return
  nothing but imports.
- No in-memory caches. If caching is needed, it goes in Redis
  with a TTL.
- `BullMQ` for any deferred work. Never `setTimeout`/`setInterval`
  in the main process.

### Horizontal scale test

Every PR touching core logic should be manually verified with
two instances:

```bash
docker-compose up --scale api=2 -d
# Hit the LB. Ensure both instances serve requests and behave
# identically. No session errors, no drift.
```

If a feature fails this test, it's not stateless.

## Tooling baseline

- **Build:** `tsx` for dev, `tsup` for production bundle.
- **Lint:** `@typescript-eslint` with strict rules, `no-floating-promises`
  enabled.
- **Format:** `prettier`, 2 spaces, no semicolons (team preference
  — tbd, set once and enforced).
- **Test:** `vitest`. Unit tests colocated (`foo.test.ts` next to
  `foo.ts`). Integration tests in `tests/integration/` using real
  DBs via docker-compose.
- **Types:** `tsconfig.json` with `"strict": true`,
  `"noUncheckedIndexedAccess": true`.
- **Pre-commit:** husky + lint-staged. Runs eslint, prettier,
  typecheck on changed files.

## Forbidden patterns

- Top-level `await` outside the entry point.
- `any` type — use `unknown` and narrow.
- `process.exit()` outside the entry point.
- Mutable default arg values (`function f(x = [])`).
- `JSON.parse(JSON.stringify(x))` for deep clone — use structured
  clone or a library.
- Untyped errors — every thrown value is an `AppError` subclass.
- Importing from `src/db/` outside of `src/repositories/`.

## Further reading

- `docs/adr/ADR-002-dual-write-pg-then-redis.md`
- `docs/adr/ADR-005-bullmq-over-node-cron.md`
- `src/app.ts` for the assembled structure.
