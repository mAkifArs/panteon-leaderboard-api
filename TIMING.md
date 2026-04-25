# Timing & Delivery Strategy

**Delivery target: Monday, 4 May 2026, 09:30 local time.**

Not 7 days from kickoff, not "as soon as possible" — a specific slot,
chosen deliberately.

## Why Monday 09:30

A "7-day" delivery lands on **Friday 1 May**, which is Labour Day in
Turkey. The email would sit unread through a public holiday and a
weekend. By Monday it is three days old, buried under HR's backlog.

Delivering on Monday 09:30 instead means:

- Email lands near the top of an unread inbox, freshly timestamped.
- No "rushed before the holiday" or "sent at 2am" signal. 09:30 Monday
  reads as **working-hours, planned, professional**.
- The three-day gap between last commit and delivery is used for
  polish, deploy verification, and docs review — not panic.

I confirmed with HR (Dilaynaz) that sticking to a stated plan matters
more than raw speed. *"Bizim için önemli olan verdiğin süre planına
uyumlu olabilmen."* That closed the decision.

## Schedule

| Date        | Day | Hours | Focus                                                  |
|-------------|-----|-------|--------------------------------------------------------|
| 24 Apr (Thu)| 0   | 2     | Planning day — structure, ADRs, CLAUDE.md, this file   |
| 25 Apr (Sat)| 1   | 6     | DB schemas, API scaffold, DB connections               |
| 26 Apr (Sun)| 2   | 6     | Redis leaderboard core (ZADD/ZREVRANGE/own-rank + tests)|
| 27 Apr (Mon)| 3   | 3     | Prize pool + weekly cron + distributed lock            |
| 28 Apr (Tue)| 4   | 3     | Frontend scaffold + reusable primitives                |
| 29 Apr (Wed)| 5   | 3     | Leaderboard UI + own-rank cluster view                 |
| 30 Apr (Thu)| 6   | 3     | Responsive polish, mobile verification                 |
| 1 May (Fri) | 7   | 4     | Deploy (Fly.io + Vercel + Upstash + Neon + Atlas)      |
| 2 May (Sat) | 8   | 3     | AI_WORKFLOW.md + README + inline doc pass              |
| 3 May (Sun) | 9   | 2     | Final bug hunt + 2M-user seed benchmark                |
| 4 May (Mon) | 10  | —     | Send at 09:30                                           |

~33 planned hours against a 22–28 hour base estimate. The extra is
absorption capacity for three predictable blockers: prize distribution
atomicity, Redis rank off-by-one, and proving stateless behaviour
across two Fly.io instances.

If the work finishes earlier, the email still goes at 4 May 09:30.
The window was chosen for HR's calendar, not mine.
