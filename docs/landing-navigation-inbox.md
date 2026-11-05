# Landing, navigation and inbox focus

This pass moves the public story from a commercial-procurement pitch to the residential remodel GC's
daily job: checking a sub's pay app, deciding what to pay, and keeping a trail the owner or lender can
follow. It also removes the two places where the product was hardest to scan — the 13-item GC bar and
the long approval inbox.

## Public landing (`#/demo`)

- The hero now leads with **“Pay the right amount. Keep the receipt.”** and names residential remodel
  GCs, owner-run remodels and owner-funded jobs.
- Three outcome cards explain the product in job language: catch overbilling early, decide with the
  evidence, and keep a clean owner trail.
- The judge checklist stays available under **Judge walkthrough**, and the sandbox card details sit
  behind **Test card and checkout details**. Neither is removed; the card number is no longer in the
  first reading surface.
- Demo access, shared-account warnings, the $55,000 / $1,850 guided-demo steps and the honest limits
  remain. The page still says sandbox money only and does not imply full-contract completion.
- The normal signed-out shell now says **“Pay apps for residential remodel GCs. Checked before you
  pay.”** The document title and description use the same audience.

## GC navigation

- The primary bar is now the five daily payment areas: **Approvals**, **Billing**, **Projects**,
  **Change orders** and **Payments**. Demo companies also keep **Guided demo** in the bar for judges.
- **More** holds the back-office registers: Procurement, Compliance & waivers, Project summaries,
  People, Vendors, Billing agents and Payment reports. The menu is a native `<details>` disclosure, so
  keyboard and phone users get the same links without a custom menu widget.
- The More summary turns green when the current route lives inside it, and every existing hash still
  resolves. This is a presentation split, not an authorization change.
- Sub and Owner navigation is unchanged.

## Approval inbox

- Entries are grouped into **Needs your attention** (submitted, under review or ready for a decision),
  **Approved · awaiting payment**, and **History** (paid, rejected or revision requested).
- History is collapsed while open work exists. If a filter leaves only history, the section opens
  automatically, so searching for a settled agreement still shows its entries.
- Status codes now read as labels such as “Ready for decision,” not raw `reviewed` strings. The raw
  value remains in `data-status` for QA and support.
- The search, status filter and Clear control share one compact row. The inbox copy is now two short
  sentences; the long explanation moved out of the daily path.
- Search and the existing 60-application / 200-agreement load cap are unchanged. History is hidden,
  not deleted, and no inbox data or money state is rewritten.

## What did not change

- No schema, Convex function, notification, approval, payment or PayPal change.
- No route was removed. The primary/More split is computed by `navSections()` in
  `src/auth/navigation.ts`; `NAV_BY_ROLE` remains the single route registry.
- No pricing page, custom domain change or `#/demo` access gate was added. The shared demo accounts
  and the public judge material are still visible to anyone who opens the page.
- The app remains a sandbox build. The landing copy is product framing, not a claim that real-money
  settlement, production onboarding or every compliance workflow is complete.

## Verification on build `517be73`

- Focused tests: **26/26** across `src/auth/DemoAccessPage.test.tsx`,
  `src/auth/navigation.test.ts` and `src/payments/inbox/inboxBuckets.test.ts`.
- Full regression: **2,052 tests across 157 files** passed.
- `npm run build` passed; docs links and the guard audit passed (**264 public / 201 internal /
  0 problems**).
- Read-only browser acceptance `scripts/qa/landing-nav-inbox-browser.mjs`: **41/41 checks** on the
  canonical domain. It covers the residential hero, collapsed disclosures, six-item primary bar,
  all seven More links, inbox buckets and counts, collapsed history, R6-A filtering, readable status
  labels, and a 390px phone layout with no horizontal overflow. Evidence:
  `evidence/landing-nav-inbox-browser-2026-11-05T09-22-03-912Z/report.json`.
- Existing Owner-card acceptance stayed green at **18/18** on the same build. The read-only role smoke
  passed all three demo logins and every checked route with no page, console or request failures.
- Three-host acceptance `scripts/qa/dual-host-browser.mjs`: **53/53 checks** on the canonical domain,
  `tradepulse-pay.pages.dev` and `cheery-axolotl-689.convex.site`. All three returned commit
  `517be73a93963e836ca11a3befa91da3c23873fb`. Evidence:
  `evidence/dual-host-browser-2026-11-05T09-25-28-884Z/report.json`.
- The browser runs made no approval, rejection, payment, PayPal popup, guided run or reference-run
  change.
