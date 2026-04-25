---
name: check-case
description: Verify the codebase satisfies every requirement in docs/case/case-en.html. Use before every commit to main and before final delivery. Returns a requirement-by-requirement checklist with file:line references for each implemented item.
---

# Check Case Compliance

Walk through `docs/case/case-en.html` line-by-line and produce a
compliance report. This skill is the executable version of the
case brief — it should fail loudly if a requirement has silently
drifted during refactoring.

## Procedure

1. **Read the case brief.** Load `docs/case/case-en.html` and
   enumerate every explicit requirement. Use these canonical
   categories:

   - **General:** Node.js / PostgreSQL / MongoDB / Redis stack,
     TypeScript on both sides, separate client and server repos.
   - **System:** Stateless architecture, PC + mobile tested,
     separate projects.
   - **Designer:** 2% pool collection, 20/15/10/55 distribution,
     top 100 + own-rank cluster (3 above, 2 below), automatic
     weekly reset, automatic prize payout.
   - **Interface:** Own rank visible on open, easy comparison,
     sample data, responsive.
   - **Technical Criteria:** Scenario fit, tech-stack use,
     scalability, performance, code quality, cloud usage,
     reusable React components.
   - **AI-Assisted Development:** AI workflow documentation
     present and substantive.
   - **Delivery:** Working production build deployed to an
     accessible domain.

2. **For each requirement, search the codebase.** Grep, read files,
   inspect tests. Do not accept "looks implemented" — require a
   concrete reference: `path/to/file.ts:LINE` or a test assertion
   that proves the behaviour.

3. **Categorise each item:**

   - ✅ **Implemented** — include file:line or test name.
   - ⚠️ **Partial** — explain what's covered and what's missing.
   - ❌ **Missing** — list as a blocker.

4. **Cross-check deliverables:**

   - `AI_WORKFLOW.md` exists in both repos and has substantive
     content (not a placeholder).
   - `TIMING.md` exists and references the delivery plan.
   - `docs/adr/` contains at least 3 ADRs.
   - README contains architecture diagram, deploy URL, and
     benchmark numbers.
   - Deployed URL returns 200 on `GET /healthz`.

5. **Output a markdown checklist** ready to paste into a PR
   description or pre-delivery sanity check. Include a final
   summary line: `X/Y requirements complete, Z partial, W missing`.

## Rules

- Do not mark anything complete unless you have a concrete
  code reference. Intent is not implementation.
- Treat "separate projects" as two distinct git remotes, not
  two directories.
- Treat "stateless" as "no module-level mutable state in the API
  process" — grep for anti-patterns (`const sessions = {}`,
  `let cache = ...` at module scope).
- If a requirement is ambiguous, flag it as ⚠️ with a
  clarification question rather than guessing.

## When to use

- Before every push to `main`.
- Before any commit that touches `src/routes/` or `src/services/`.
- **Mandatory** before the final delivery email on 4 May 09:30.
