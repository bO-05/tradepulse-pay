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
subcontractor invite. Pressing the button with invalid fields returns to the first step that needs
attention and names the problem; progress is shown step by step.

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

## Resume after a reload or a failed step

The wizard keeps its draft in this browser's `localStorage` under
`tradepulse.quickStart.v1.<companyId>` for 12 hours: the typed fields, the SOV rows, the ids of the
records it already created, and which steps finished. Nothing else is stored, and the key is scoped to
the company id, so two accounts on one browser never see each other's draft.

- After a reload the wizard reopens on the same step and shows a **Resumed a saved quick start**
  banner naming what already exists, for example "Already created: the job, the trade package and the
  sub."
- Retrying continues where it stopped. The approved SOV, the GC's execution record and the sub invite
  are recorded as finished steps, so a retry does not import an approved SOV a second time, and a draft
  whose invite already went out does not send a second invite.
- A step whose record already exists locks its inputs and explains where to edit it instead: **Project
  settings** for the job, **People** for the sub, and the SOV screen for an approved schedule. Before
  this, edits made after a failure were silently ignored because the retry reused the existing record.
- **Start over** in the banner forgets the draft and its ids. A job that was already created stays in
  Projects and is never deleted by this control.
- The invite link is deliberately not stored, because it is a one-use link. If the page reloaded after
  the invite was created, the final screen says so and links to People to copy it.

The draft is cleared when the wizard reaches its final screen and when the GC signs out.

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
- Unit tests: `src/projects/gc/quickStartProgress.test.ts` (19 tests) covers the saved draft, the
  12-hour expiry, another company's draft, corrupt JSON, invalid document ids, the resume copy, the
  step locks and the sign-out sweep; `src/auth/signOutAndReset.test.ts` (4 tests) covers the sweep.
- Browser acceptance: `scripts/qa/quick-start-resume-browser.mjs` passed all 15 checks against the
  canonical build `f55d8eb` on 2026-11-06 (evidence in
  `evidence/quick-start-resume-browser-2026-11-06T13-36-00-929Z/report.json` with screenshots). It
  signs in as the demo GC, types a project name, reloads, and checks the restored value, the resume
  banner and **Start over**. It never presses a create button, so it writes no record.
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
  That script creates a real demo job, so it is not part of the routine read-only sweep.
- `npx tsc -b`, the production `vite build` and the full suite (159 files, all passing) ran before the
  `f55d8eb` deploy on 2026-11-06.

## Limits

- One subcontract per Quick start run. Add another sub from the project afterwards.
- No document upload, insurance parsing or bid leveling in the short path. Use **New project** for
  those.
- Invite creation is a real action and is subject to the same allowlist and rate limits as the rest
  of the app.
- Quick start does not move money. Funding and pay applications start from the usual agreement and
  ledger screens.
