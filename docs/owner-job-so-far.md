# Owner job so far

The Owner home shows a **Job so far** card for each project with meaningful prime-contract activity.
It is a read-only answer to the question a residential owner actually asks: how much of the job is
complete, how much has been paid, and what is left?

## What it shows

- **Percent complete** — completed and stored work divided by the prime contract sum to date.
- **Contract to date** — the original prime contract value plus approved prime change orders.
- **Completed & stored** — from the latest approved owner pay app. If no owner pay app is approved
  yet, the card can use the latest submitted one but labels it **Awaiting your review** and says it is
  the GC's report, not approved work.
- **Paid to date** — paid owner pay apps plus paid prime change orders. The small print separates the
  two, so a direct invoice such as the R6-A change order is not mistaken for a pay-app payment.
- **Retainage held**, **Balance to finish** and **Change orders** — from the same approved or submitted
  baseline, with the number of change orders awaiting the Owner.
- **Started** and **target completion** dates when project setup recorded them.
- A status line for the latest app: waiting for review, changes requested, approved but not invoiced,
  invoiced and pending, or paid.

The card has no approve, fund, pay or edit control. It is a summary only.

## Which app is the basis

The server prefers the latest **approved**, **approved-invoiced** or **paid** owner pay app. A later
submitted app is named in the status line but does not replace approved progress. If no app has been
approved, a submitted app is shown with an explicit "waiting for your review" label. Drafts are never
used.

## Data and access

`convex/portal.ts` adds `ownerJob` to `portal.ownerOverview`. It is computed only when the caller is
the Owner on that project; a GC receives `ownerJob: null`. The summary reuses the project's existing
owner pay apps and visible prime change orders, so it does not add a new financial read or write path.

A project with no prime contract value, owner pay app, or approved/paid change order returns
`ownerJob: null`; the card is omitted instead of adding an empty card to every legacy project.

## Tests

- `convex/ownerJob.test.ts` — 4 tests: approved baseline with a later submitted app, paid and open
  change orders, empty-project omission, and no summary for a GC.
- `src/payments/OwnerPortal.test.tsx` — 2 static-render tests: Owner card content and no card in the GC
  project summary.
- Browser acceptance `scripts/qa/owner-job-browser.mjs` passed **18/18 checks** on canonical build
  `57fcd50` on 2026-11-05. It opened the shared synthetic Owner account, found the card, checked its
  progress bar, six money/progress labels, explicit paid-to-date sources and absence of controls, then
  checked the GC project summary for the card's absence.
- Evidence: `evidence/owner-job-browser-2026-11-05T09-00-58-465Z/report.json`.

The browser run made no write, payment, PayPal call or guided run.

## Limits

- Percent complete is approved or GC-reported work, not a schedule or earned-value forecast.
- The card does not show invoices individually; the Owner pay-apps page does that.
- A legacy project without a prime contract value legitimately shows `—` for contract to date and
  cannot calculate percent complete.
- Paid to date follows app and change-order statuses recorded in the app; it is not a bank feed.
