# Quick start: a job and a subcontract in one pass

Quick start is the short path for a general contractor who has a real job but has not set up a
project, trade package or subcontract yet. The full **New project** wizard still exists; Quick start
is an additive route at `#/all-projects/quick-start` for GC companies.

It creates one project and one subcontract in four steps:

1. **Job** – project title, location, project type and start date.
2. **Sub** – company name, contact name and email, and the trade.
3. **Schedule of values** – three to eight lines, typed or pasted from a spreadsheet.
4. **Review** – total, effective retainage and the exact records that will be created.

The final step creates the project, trade package, vendor and direct bid, generates the agreement,
imports and approves the schedule of values, executes the agreement, and then tries to create the
subcontractor invite. The button is disabled until the required fields are valid; progress is shown
step by step.

## What the schedule of values accepts

- Three to eight lines. A line needs a description and a positive dollar amount.
- A minimum total of **$1,000.00**. This is a bid-plausibility floor, not a legal or accounting limit.
- Typed entry, or pasted rows separated by tabs, pipes or commas. A header row is skipped. `$` signs,
  thousands separators and quoted values are handled.
- The accepted total becomes both the bid base and the schedule-of-values total.
- Retainage is inherited from the project and company defaults; the review step shows the effective
  rate before anything is created.

If a step fails after some records exist, retrying reuses the project, package, vendor, bid and
agreement instead of creating duplicates. Agreement execution is idempotent.

## Demo companies cannot create the invite

The shared demo GC is intentionally read-only for company identity and recipient settings.
`invites.prepareCreate` calls `requireCompanyMember(ctx, { write: true })`, which refuses with
`DEMO_READ_ONLY`.

Quick start detects a demo company, skips the invite step, and says so plainly:

> Demo companies cannot create invites because shared demo identity and recipient settings are
> read-only. The job and subcontract are still created.

The success title becomes **Job and subcontract ready**. The job, subcontract and approved SOV are
real records inside the demo project. A real GC account does not take this branch and creates the
invite normally.

## Verification

- Unit tests: `src/projects/gc/quickStartPlan.test.ts` (8 tests) covers totals, the 3–8 line bounds,
  per-row errors, paste formats, header skipping, quotes, sub validation and the UTC bid deadline.
- Navigation tests: `src/auth/navigation.test.ts` covers the `quick-start` route (19 navigation tests
  pass in the targeted run).
- Backend integration: `convex/quickStart.test.ts` runs the full mutation sequence, including rate
  limiter registration, SOV approval and execution, invite creation, and invite acceptance by a
  synthetic sub user. It asserts project membership and the vendor link.
- Browser acceptance: `scripts/qa/quick-start-browser.mjs` passed all 23 checks against the canonical
  build `2629233` on 2026-11-05. Evidence is in
  `evidence/quick-start-browser-2026-11-05T05-59-52-092Z/report.json` with screenshots alongside it.
  The run created demo project `q97evdpy3xv5842dwybgcgjjjn8hnsvp` and agreement
  `jn7eqczfmhfs8w012wxv55q4jx8hny7m`, total $49,750.00, retainage 5%, with the demo invite note shown.
- `npx tsc -b` and the production `vite build` passed before deploy. The full test suite has not been
  rerun since Quick start; the earlier Block 0 full-suite pass belongs to build `a083354`.

## Limits

- One subcontract per Quick start run. Add another sub from the project afterwards.
- No document upload, insurance parsing or bid leveling in the short path. Use **New project** for
  those.
- Invite creation is a real action and is subject to the same allowlist and rate limits as the rest
  of the app.
- Quick start does not move money. Funding and pay applications start from the usual agreement and
  ledger screens.
