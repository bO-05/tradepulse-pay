# R7 remediation record

Date: 2026-11-05
Audit: external R7 retest and usefulness verdict (kept in the ignored `docs/external-audit/` folder)
Branch: `main` since 2026-11-06, when `recovery/stabilize-2026-11-01` was fast-forwarded onto it; the recovery branch is frozen at `e4682a7` as a backup.
First deployed code commit: `991b865`. Every code commit after that has been deployed to all three hosts; `docs/audit-entry.md` explains how to confirm which commit a host is serving.

This file maps every R7 finding to code, tests and what is still open. It does not turn the R7 verdict into a pass. The product is a tested PayPal-sandbox build, not a real-money production service, and the residential/ICP gaps the audit ranked as the biggest score lever are only partly addressed.

## Short result

Fixed in code with regression tests:

- **B1 (P1, money display).** The approval inbox now computes an edited proposal's net and retainage with the same `finalAllocation` → `approvedG702Figures` path the payout uses. A 90% edit at 10% retainage and at the 50%-reduced rate shows the exact net the sub is paid.
- **B8.** `releaseRetainage` requires the confirmed amount (`expectedCents`), and the release dialog is disabled until a confirmed PayPal payee exists.
- **B6.** The full-cycle simulation refuses to delete agreements that have any financial history.
- **B3.** A changed approved amount creates a replacement waiver instead of a dead end. The old signature is kept as superseded, the panel shows "Amount changed", and the gate reads only the live signature.
- **B11.** Turning the lien-waiver gate off asks the GC for a reason and notifies the sub company with it.
- **B4.** Quick start keeps its draft in `localStorage` under `tradepulse.quickStart.v1.<companyId>` for 12 hours, so a reload restores the ids it already created. Retrying skips the approved SOV, the execution record and an invite that already went out instead of repeating them; a step whose record exists locks its inputs and links to where the record can be edited; **Start over** forgets the draft and never deletes a created job. Sign-out clears every draft in the browser.
- **B9.** The pay-app question thread has a 10-minute and 24-hour rate limit, and notifications truncate long bodies.
- **B7 (display only).** The agreement ledger, owner summary and dashboard show `10% → 5% after 50% complete` and use the applied rate for the retainage cap.
- **B12 (mostly).** Dev/sponsor strings are gone from user-facing screens: no KERNEL, no "live Convex data / AG Studio", no "recovery build", no `verify-required.invalid` e-mail, no "AI amount" column. Attribution reads "Explanation by Mistral Large (rules set the amount)". Contact e-mails that are `.invalid` are hidden.
- **Sub visibility.** The sub sees the review's suggested gross (`reviewSuggestedTotalCents`) and the approval-history bullet even though per-line review notes stay GC-only.
- **N-10 (new runs only, approved by the owner).** The guided demo's edit reason names line 2 and the excluded seismic bracing, and promises no lien waiver or resubmit path. Existing runs are unchanged.
- **Landing and accessibility.** Signed-out `/` now shows the residential hero beside/above the sign-in card with a link to `#/demo`. The Owner home has zero text-contrast violations in the new measurement. `#/company-settings` resolves to the real company page instead of Not found.
- **B2.** The opt-in gate now covers the closeout retainage release: the sub signs a retainage waiver from the same panel, the release refuses with `LIEN_WAIVER_MISSING` until the balance is covered, and a changed balance asks for a new signature. Gate-off behaviour is unchanged.
- **B10.** A lien-waiver signature now carries real evidence: the statement is built and hashed by the server, shown verbatim in a review step, redeemed once through an HTTP route that records the IP, the trusted header and the browser, and the signing mutation refuses to write a waiver without it.
- **B13.** The 24-case suite is now labelled as what it is: agreement with this app's rules. `docs/pay-app-review-eval.md` adds a rules-only baseline section, the scorecard markdown and console output print that baseline and rename the headline metric to line agreement, and the diagnostics panel says it on screen. The score still cannot prove the rules are right; it reports whether the reviewer reproduces them on hand-picked cases.
- **Copy.** PayPal's sandbox fee note uses the card/wallet rates instead of "3.5% + $0.49"; the sub retainage tile distinguishes this period's withhold from what is still held; the signup wall no longer prints the environment-variable name.
- **Block 1, first half.** `convex/demoResidential.ts` seeds a residential reference job for the Demo company with an `$86,500` prime value, four prime SOV lines, a 10% retainage hold and a billing day, so the GC can open a homeowner pay app with real lines. `convex/demoResidential.test.ts` proves the project is created once, is visible to the Demo GC and owner, and that the pay app opens at `$86,500` with a `10%` hold.

Partial or deferred in this round:

- **B5 (subcontract executed before sub acceptance)** is partial. The step now says "Record the GC's execution" and states that the sub's signature and acceptance happen outside the app and are not replaced by the record. There is still no in-app sub acceptance step.
- **Block 1 (residential reference job)** is partial. The Demo company now carries a second, ordinary project, "Lopez Kitchen Remodel": a residential kitchen with an $86,500 prime value, a 10% retainage hold, a monthly billing day and the Demo owner as a project member, seeded by `convex/demoResidential.ts`. That turns the GC's "New owner pay app" button on for a homeowner draw, which the commercial walkthrough could not do because it has no prime contract value. Still open: milestone draws on the prime side, the GC collected/paid/owed strip, and turning the waiver gate on for that job.
- **Owner "Test Store"** is a PayPal sandbox merchant setting, not app code.

## Finding map

Status meanings: **Fixed** = code and regression tests in this branch. **Partial** = a real improvement, but the finding's outcome is not fully delivered. **Deferred** = reproduced and left open.

| ID | Sev | Finding | Status | What changed / why it remains |
| --- | --- | --- | --- | --- |
| B1 | P1 | Inbox net/retainage ignores the edited amount | Fixed | `convex/payApps/proposals.ts` adds `pendingPayoutSplit` using `finalAllocation` and `approvedG702Figures`, cached per amount in `listInbox`. `convex/agent/payAgent.test.ts` edits to 90%, checks the 10% retainage parts sum to gross, then approves and asserts `payFiguresFor` equals the inbox split. `convex/payApps/g703.test.ts` covers the 50%-reduced rate. |
| B2 | P2 | Gate does not cover retainage release or final payout | Fixed (retainage release) | `convex/lib/lienWaivers.ts` adds a retainage slot on the latest paid pay app, computed with the same `availableRetainageCents` math the release uses; `convex/payments/retainageDb.ts` refuses `beginRetainageRelease` with `LIEN_WAIVER_MISSING` while the gate is on and no live retainage waiver covers the balance; `api.lienWaivers.signWaiver` and `api.waiverEvidence.issueTicket` accept the `retainage` kind through the same statement and evidence path; `src/billing/LienWaiverPanel.tsx` renders the signing slot, so the blocker is always clearable; `convex/billing/payGate.test.ts` covers the refusal, the signature, the release going through and a changed balance. The final-payout path outside retainage is unchanged. |
| B3 | P2 | A changed approved amount makes the signed waiver a dead end | Fixed | `convex/schema.ts` adds `supersededAt`/`supersededByWaiverId`; `convex/lib/lienWaivers.ts` reads the latest live signature; `convex/lienWaivers.ts` inserts a replacement and supersedes the old row; `src/billing/LienWaiverPanel.tsx` shows "Amount changed" and "Sign a new waiver". `convex/billing/payGate.test.ts` asserts the replacement, the superseded row and the cleared reason codes. |
| B4 | P2 | Quick start partial failure orphans ids; edits after failure are ignored | Fixed | `src/projects/gc/quickStartProgress.ts` persists the draft (fields, SOV rows, created ids, finished steps) for 12 h under `tradepulse.quickStart.v1.<companyId>`; `QuickStartWizard.tsx` restores it, skips the approved SOV, execution and invite on retry, locks a step whose record exists, and offers **Start over**; `src/auth/signOutAndReset.ts` sweeps every draft on sign-out. `quickStartProgress.test.ts` (19) and `signOutAndReset.test.ts` (4) cover corrupt, expired and foreign drafts, the locks and the sweep; `scripts/qa/quick-start-resume-browser.mjs` proves the reload without creating a record. |
| B5 | P2 | Quick start marks the subcontract executed before the sub accepts | Partial | The step reads "Record the GC's execution" and the note says the sub's signature and acceptance happen outside the app and are not replaced by the record. No in-app acceptance exists. |
| B6 | P2 | Full-cycle simulation can erase money history | Fixed | `convex/simulation.ts` refuses to delete any package agreement with billing history via `agreementHasFinancialHistory` / `moneyHistoryRefusal`. |
| B7 | P3 | Retainage display shows the base rate after the 50% reduction | Fixed (display) | `convex/payments/ledger.ts` adds `retainagePercentApplied`; `ledgerValidators.ts`, `src/payments/AgreementLedgerView.tsx`, `convex/portal.ts` and `src/payments/AgreementSummaryView.tsx` show the applied rate; `convex/dashboard/queries.ts` uses it for the retainage cap. `convex/lib/money.ts` adds `bpsToPercent` so the money-boundary test stays green. Contracts register and bid leveling still show the base rate only. |
| B8 | P2 | Retainage release can send a different amount; payee not named | Fixed | `convex/payments/retainage.ts` makes `expectedCents` required; `src/payments/RetainageRelease.tsx` disables the control without a confirmed payee and names the masked e-mail; the judge-demo page sends the ledger amount. `convex/payments/release.test.ts`, `roleGuardSweep.test.ts` and `paymentsIsolation.test.ts` cover the new argument. |
| B9 | P3 | Question thread has no rate limit; notifications copy the whole body | Fixed | `convex/payApps/questions.ts` adds `QUESTION_RATE_WINDOW_MS`, `QUESTIONS_PER_WINDOW`, `QUESTIONS_PER_DAY` and a 160-character notification excerpt; `convex/schema.ts` adds `by_authorUserId_and_createdAt`; `convex/payApps/questions.test.ts` fills the window and asserts the refusal, `canPost` reason and short notification. |
| B10 | P3 | Weak waiver evidence | Fixed | `convex/lib/waiverStatement.ts` builds the statement and hashes it; `convex/waiverEvidence.ts` issues a single-use hashed ticket and refuses a swapped, reused or expired one; `convex/waiverEvidenceHttp.ts` (route `/api/waivers/evidence`) is the only writer and records the SHA-256, IP, trusted header, user agent and time; `api.lienWaivers.signWaiver` now requires matching, unspent, unexpired evidence and writes the hash and address into the audit text; `src/billing/LienWaiverPanel.tsx` shows the exact statement before the signature; `convex/billing/payGate.test.ts` covers the lifecycle and the refusals. |
| B11 | P3 | Gate disable is silent to the sub | Fixed | `convex/lienWaivers.ts` accepts a reason, records it in the audit log and notifies the sub company; `src/payments/LienWaiverGateCard.tsx` asks for the reason in the confirm dialog; `convex/billing/payGate.test.ts` asserts the notification. |
| B12 | P2 | Dev/sponsor copy leaks | Fixed (mostly) | `src/lib/aiProvenance.ts` centralises attribution; `PayAppReviews`, `PayAppDecision`, `DashboardFallback`, `PaymentsDashboard`, `StudioDashboard`, `LicenseCheck`, `PayAppEvalPanel`, `ReferenceNotice`, the judge-demo screens, `PackageBidders` and `BidLevelingMatrixView` were rewritten. The G703 column is "Recommended amount". Remaining "Test Store" is a PayPal sandbox merchant name. |
| B13 | P3 | Eval honesty | Fixed (framing and baseline) | `docs/pay-app-review-eval.md` states that every metric is agreement with this app's rules, adds a rules-only baseline section (24/24 and 100% by construction) and explains what that baseline cannot detect; `scripts/qa/pay-app-review-scorecard.mjs` renames the headline metric to line agreement and prints the baseline in the markdown and the console; `src/dashboard/PayAppEvalPanel.tsx` says the same on screen. No eval case or rule changed. |
| N-10 | P2 (demo) | Canned guided-demo override reason | Fixed (new runs only) | `src/payments/judgeDemo/useJudgeDemoDriver.ts` names line 2 and the excluded seismic bracing. `src/payments/judgeDemo/driverCopy.test.ts` forbids waiver/resubmit/90% wording. |
| Owner contrast | P2 | 15 serious axe contrast nodes on Owner home | Fixed | `src/payments/OwnerPortal.tsx` lifts the 11–12 px slate-500 text to slate-400. `scripts/qa/owner-landing-browser.mjs` measures every visible text/background pair on the signed-in Owner home and reports 0 violations. |
| Root `/` | P2 | Signed-out root is only a sign-in card | Fixed | `src/auth/ResidentialHero.tsx` is shared by `#/demo` and `src/auth/AuthLayout.tsx`; `SignInPage` passes it as `hero`. The page keeps one `h1` (the hero) and the card title becomes `h2`. |
| Route/nav | P3 | `#/company-settings` is Not found; nav naming differs | Fixed | `src/auth/navigation.ts` resolves `/company-settings` to the company page; `navigation.test.ts` covers every role. The GC nav still says "Payment reports" because that is the page title; the Owner nav says "Reports". |
| Sub view | P2 | Sub cannot see the review suggestion | Fixed | `convex/payApps/g703ViewValidators.ts` and `convex/payApps/g703.ts` expose `reviewSuggestedTotalCents`; `src/billing/PayAppPage.tsx` uses it for the money trail and approval history. |
| Fees | P3 | Wrong PayPal fee copy | Fixed | `src/payments/judgeDemo/SandboxTopUpPanel.tsx` and the `convex/payments/sandboxTopUp.ts` comment use the card rate (2.99% + $0.49) and the wallet rate (3.49% + $0.49). |
| Signup wall | P3 | Allowlist refusal prints the env var name | Fixed | `convex/lib/recipientAllowlist.ts` now says "ask the operator to approve this one"; no `EMAIL_RECIPIENT_ALLOWLIST` in user-facing text. |
| Retainage tile | P3 | "Total retainage held $0.00" contradicts this period's withhold | Fixed | `src/billing/PaymentPanel.tsx` labels "Retainage still held on this agreement" and explains when this period withheld money but the ledger shows nothing still held (a release is on record). |

## Verification

- `npm run build` (tsc -b + vite) clean; Convex `dev --once --typecheck enable` on `dev:cheery-axolotl-689` clean.
- Full `vitest run`: 159 files, all passing, including the new `quickStartProgress.test.ts` (19 tests) and the sign-out draft sweep in `signOutAndReset.test.ts` (4).
- `npm run verify:guards`: 264 public functions, 201 internal, 0 problems.
- `npm run verify:docs`: 101 relative links resolve.
- Read-only browser acceptance, against `6ff5476`:
  - `scripts/qa/dual-host-browser.mjs --url https://cheery-axolotl-689.convex.site`: **21/21**.
  - `scripts/qa/dual-host-browser.mjs --url https://tradepulse-pay.pages.dev`: **21/21** (`evidence/dual-host-browser-2026-11-06T13-56-31-414Z/report.json`).
  - `scripts/qa/landing-nav-inbox-browser.mjs`: **41/41** against the canonical host.
  - `scripts/qa/owner-landing-browser.mjs`: **9/9**, 0 contrast violations, signed-out hero and Owner home.
  - `scripts/qa/quick-start-resume-browser.mjs`: **15/15**; a typed project name survives a reload, the resume banner names what exists, and **Start over** clears the form. It presses no create button, so no record was written.
  - The combined two-host run (no `--url`) passed 27 checks and then hit a 30 s Puppeteer navigation timeout on three attempts while the desktop Chrome held about 7 GB of RAM. The same pages answer in under a second over HTTP (`?project=...&tab=packages` in 0.77 s, the entry bundle in 2.7 s) and the per-host runs pass every assertion, so this is machine contention rather than an app fault. It is recorded here as the one check that is not green in a single process on this build.
- Deployed app code: `f55d8eb` (the B4 fix) plus the deploy-guard fix in `6ff5476`, on `cheery-axolotl-689.convex.site`, `tradepulse-pay.pages.dev` and `tradepulse-pay.asynchronope.tech`. `/version.json` on each host reports the exact commit that is live; documentation commits after that change no app code. `npm run deploy:all` now also probes every hashed asset that `index.html` references: one Pages deploy served the new HTML before an asset was reachable, the SPA fallback answered that asset with `index.html`, and the page could not load for about a minute. The first version of that probe read the previous build's hashes, which is why it refused a deploy it had just made; that is fixed.

## Verification after B10 and B13 (6 November 2026)

- `npx vitest run`: **159 files, 2085 tests, 0 failures**, including five signing-evidence tests and two retainage-release tests in `convex/billing/payGate.test.ts`.
- `node scripts/tools/guard-audit.mjs`: **267 public functions, 202 internal, 0 problems**; the new evidence route is listed as ticket-gated in the audit.
- `npm run verify:docs`: **102** relative links resolve.
- `node scripts/qa/lien-waiver-browser.mjs --url https://tradepulse-pay.asynchronope.tech`: **26/26**, no page or console errors; the review step rendered the server-built statement naming the amount, the recipient and the typed signer.
- `node scripts/qa/quick-start-resume-browser.mjs --url https://cheery-axolotl-689.convex.site`: **15/15**.
- Live probes of `POST /api/waivers/evidence`: an unknown ticket returns `409` with "This signing session is not recognised", the `OPTIONS` preflight returns `204` with CORS on an allowed origin, and an unknown `/api/waivers/*` path still returns the JSON `404`.
- All three hosts serve the deployed build (`/version.json` matches `main`). `docs/audit-entry.md` is the one-page entry point for an external reviewer.

## Branch handoff, 6 November 2026

`main` was a strict ancestor of the recovery branch (`fb5e416`, 41 commits behind, 0 ahead), so the handoff is a fast-forward with no merge commit and no history rewrite:

1. `recovery/stabilize-2026-11-01` got one hardening commit: `scripts/deploy-all.mjs` now accepts `main` as well as the recovery branch, and the README no longer prints the shared demo password (it points at `#/demo`, which signs each role in with one button and prints the manual password there).
2. That commit was pushed to `recovery/stabilize-2026-11-01`.
3. `main` was fast-forwarded to the same commit and pushed. The recovery branch stays frozen at `e4682a7` as a rollback, and `paypal-hackathon` keeps the pre-recovery TradePulse Pay work.
4. Deploys now run from `main`: `npm run deploy:all` refuses any other checkout and still refuses a dirty tree, a non-dev `CONVEX_DEPLOYMENT`, or a mismatched `SITE_URL`.

This changes no deployed backend or financial data. It moves the public default branch onto the build that has been under test since 1 November.

## Not done

- Block 1 second half: owner milestone draws and the GC collected/paid/owed strip. The residential
  reference job itself now ships (`convex/demoResidential.ts`).
- Statutory California waiver forms, PayPal multiparty, QuickBooks.
- Production deployment, YouTube upload, Devpost submission, a new guided run, PayPal popup, live Owner-invoice retry and any financial write on a new run. Those remain owner decisions.
