---
name: migrate
description: Create a new Drizzle migration file with forward and rollback SQL. Use whenever the database schema needs to change. Enforces the project rule that every migration must be reversible.
---

# Migrate

Create a new schema migration for PostgreSQL using Drizzle Kit.
Every migration in this project must include a rollback; this
skill enforces that.

## Arguments

- `<name>` — snake_case migration name. Example:
  `add_idempotency_keys_table`.

## Procedure

1. **Update the Drizzle schema.** Before generating, make sure
   the user has already edited `src/db/schema.ts` to reflect the
   desired end state. If not, stop and ask.

2. **Generate the migration:**

   ```bash
   pnpm drizzle-kit generate --name=<name>
   ```

   This produces `drizzle/NNNN_<name>.sql` with the forward
   migration only.

3. **Add the rollback.** Open the generated file and append a
   rollback block at the bottom:

   ```sql
   -- +++ FORWARD (generated above) +++

   -- +++ ROLLBACK +++
   -- To reverse this migration, run the statements below.
   -- DROP TABLE ...
   -- ALTER TABLE ...
   ```

   Fill in the rollback SQL manually; Drizzle does not produce it.

4. **Dry-run.** Run the migration against a disposable local DB
   to verify it applies cleanly:

   ```bash
   pnpm db:migrate:dry
   ```

5. **Document.** If the migration involves data transformation
   (not just schema change), write an accompanying note in
   `docs/migrations/NNNN_<name>.md` explaining:
   - Why the change is needed
   - Data backfill strategy
   - Downtime expectations (should be zero — use expand/contract)
   - Rollback procedure

## Rules

- **No destructive migrations without an expand/contract plan.**
  If you need to drop a column, first stop writing to it, ship,
  verify, then drop. Never in one step.
- **Money columns are `BIGINT`, never `NUMERIC` or `DECIMAL`.**
  All amounts stored as smallest currency unit.
- **Append-only tables** (`earning_events`, `prize_payouts`) never
  get columns that change their row count. Use a side table instead.
- **Rollback must restore the exact prior state.** If you can't
  write a clean rollback, the forward migration is wrong.

## Forbidden patterns

- `DROP TABLE` with data in it, without prior backup confirmation.
- `ALTER COLUMN ... TYPE` on a table with > 100k rows without a
  `USING` clause and a load-test plan.
- Adding a `NOT NULL` column without a default, to an existing
  populated table.
