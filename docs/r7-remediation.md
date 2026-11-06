# R7 remediation record

Date: 2026-11-05
Audit: external R7 retest and usefulness verdict (kept in the ignored `docs/external-audit/` folder)
Branch: `main` since 2026-11-06, when `recovery/stabilize-2026-11-01` was fast-forwarded onto it; the recovery branch is frozen at `e4682a7` as a backup.
First deployed code commit: `991b865`. Final deployed build (canonical, mirror and Pages): `4567602`. Documentation-only commits after that build do not change the app.

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
- **Copy.** PayPal's sandbox fee note uses the card/wallet rates instead of "3.5% + $0.49"; the sub retainage tile distinguishes this period's withhold from what is still held; the signup wall no longer prints the environment-variable name.

Partial or deferred in this round:

- **B2 (gate retainage release)** is deferred. A correct fix needs a release-specific waiver slot and a sub signing surface; a partial guard would create a new dead end like B3. Not shipped before 12 Nov.
- **B5 (subcontract executed before sub acceptance)** is partial. The step now says "Record the GC's execution" and states that the sub's signature and acceptance happen outside the app and are not replaced by the record. There is still no in-app sub acceptance step.
- **B10 (waiver evidence)** is deferred. The record still stores the signer's user id, server time, amount and through-date, but not a rendered-statement hash, IP or user agent. Convex mutations do not expose the request headers, so IP capture needs an HTTP action.
- **B13 (eval honesty)** is deferred. The 24 cases are still self-authored and the ground truth is the app's own rules. The "rules-agreement" framing and a rules-only baseline are not shipped.
- **Block 1 (residential reference job)** is deferred. The demo still leads with the commercial Austin/Rosendin job. A residential seeded job with a prime value, milestone draws and the waiver gate on is the largest remaining score lever, but it needs a new seed path plus financial writes that were not authorised in this session.
- **Owner "Test Store"** is a PayPal sandbox merchant setting, not app code.

## Finding map

Status meanings: **Fixed** = code and regression tests in this branch. **Partial** = a real improvement, but the finding's outcome is not fully delivered. **Deferred** = reproduced and left open.

| ID | Sev | Finding | Status | What changed / why it remains |
| --- | --- | --- | --- | --- |
| B1 | P1 | Inbox net/retainage ignores the edited amount | Fixed | `convex/payApps/proposals.ts` adds `pendingPayoutSplit` using `finalAllocation` and `approvedG702Figures`, cached per amount in `listInbox`. `convex/agent/payAgent.test.ts` edits to 90%, checks the 10% retainage parts sum to gross, then approves and asserts `payFiguresFor` equals the inbox split. `convex/payApps/g703.test.ts` covers the 50%-reduced rate. |
| B2 | P2 | Gate does not cover retainage release or final payout | Deferred | `convex/payments/retainageDb.ts` still releases without a waiver check. A correct fix needs a release waiver kind/slot and a sub signing surface; see the short result. |
| B3 | P2 | A changed approved amount makes the signed waiver a dead end | Fixed | `convex/schema.ts` adds `supersededAt`/`supersededByWaiverId`; `convex/lib/lienWaivers.ts` reads the latest live signature; `convex/lienWaivers.ts` inserts a replacement and supersedes the old row; `src/billing/LienWaiverPanel.tsx` shows "Amount changed" and "Sign a new waiver". `convex/billing/payGate.test.ts` asserts the replacement, the superseded row and the cleared reason codes. |
| B4 | P2 | Quick start partial failure orphans ids; edits after failure are ignored | Fixed | `src/projects/gc/quickStartProgress.ts` persists the draft (fields, SOV rows, created ids, finished steps) for 12 h under `tradepulse.quickStart.v1.<companyId>`; `QuickStartWizard.tsx` restores it, skips the approved SOV, execution and invite on retry, locks a step whose record exists, and offers **Start over**; `src/auth/signOutAndReset.ts` sweeps every draft on sign-out. `quickStartProgress.test.ts` (19) and `signOutAndReset.test.ts` (4) cover corrupt, expired and foreign drafts, the locks and the sweep; `scripts/qa/quick-start-resume-browser.mjs` proves the reload without creating a record. |
| B5 | P2 | Quick start marks the subcontract executed before the sub accepts | Partial | The step reads "Record the GC's execution" and the note says the sub's signature and acceptance happen outside the app and are not replaced by the record. No in-app acceptance exists. |
| B6 | P2 | Full-cycle simulation can erase money history | Fixed | `convex/simulation.ts` refuses to delete any package agreement with billing history via `agreementHasFinancialHistory` / `moneyHistoryRefusal`. |
| B7 | P3 | Retainage display shows the base rate after the 50% reduction | Fixed (display) | `convex/payments/ledger.ts` adds `retainagePercentApplied`; `ledgerValidators.ts`, `src/payments/AgreementLedgerView.tsx`, `convex/portal.ts` and `src/payments/AgreementSummaryView.tsx` show the applied rate; `convex/dashboard/queries.ts` uses it for the retainage cap. `convex/lib/money.ts` adds `bpsToPercent` so the money-boundary test stays green. Contracts register and bid leveling still show the base rate only. |
| B8 | P2 | Retainage release can send a different amount; payee not named | Fixed | `convex/payments/retainage.ts` makes `expectedCents` required; `src/payments/RetainageRelease.tsx` disables the control without a confirmed payee and names the masked e-mail; the judge-demo page sends the ledger amount. `convex/payments/release.test.ts`, `roleGuardSweep.test.ts` and `paymentsIsolation.test.ts` cover the new argument. |
| B9 | P3 | Question thread has no rate limit; notifications copy the whole body | Fixed | `convex/payApps/questions.ts` adds `QUESTION_RATE_WINDOW_MS`, `QUESTIONS_PER_WINDOW`, `QUESTIONS_PER_DAY` and a 160-character notification excerpt; `convex/schema.ts` adds `by_authorUserId_and_createdAt`; `convex/payApps/questions.test.ts` fills the window and asserts the refusal, `canPost` reason and short notification. |
| B10 | P3 | Weak waiver evidence | Deferred | No rendered-statement hash, IP or user agent. The attestation wording and disclaimer already existed. |
| B11 | P3 | Gate disable is silent to the sub | Fixed | `convex/lienWaivers.ts` accepts a reason, records it in the audit log and notifies the sub company; `src/payments/LienWaiverGateCard.tsx` asks for the reason in the confirm dialog; `convex/billing/payGate.test.ts` asserts the notification. |
| B12 | P2 | Dev/sponsor copy leaks | Fixed (mostly) | `src/lib/aiProvenance.ts` centralises attribution; `PayAppReviews`, `PayAppDecision`, `DashboardFallback`, `PaymentsDashboard`, `StudioDashboard`, `LicenseCheck`, `PayAppEvalPanel`, `ReferenceNotice`, the judge-demo screens, `PackageBidders` and `BidLevelingMatrixView` were rewritten. The G703 column is "Recommended amount". Remaining "Test Store" is a PayPal sandbox merchant name. |
| B13 | P3 | Eval honesty | Deferred | The 24 cases, their ground truth and the code-set flags are unchanged. |
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
- Read-only browser acceptance:
  - `scripts/qa/dual-host-browser.mjs`: 37/37 on the Convex site and Pages mirror, both serving the same commit, including the pinned reference run.
  - `scripts/qa/landing-nav-inbox-browser.mjs`: 41/41 against the canonical host.
  - `scripts/qa/owner-landing-browser.mjs`: 9/9, 0 contrast violations, signed-out hero and Owner home.
  - `scripts/qa/quick-start-resume-browser.mjs`: 15/15 against the canonical host (`evidence/quick-start-resume-browser-2026-11-06T13-36-00-929Z/report.json`). A typed project name survives a reload, the resume banner names what exists, and **Start over** clears the form. It presses no create button, so no record was written.
- Deployed app code: `f55d8eb` on `cheery-axolotl-689.convex.site`, `tradepulse-pay.pages.dev` and `tradepulse-pay.asynchronope.tech`; all three `/version.json` files returned that commit. Later commits in this record are documentation plus the deploy guard, so the app bundle is unchanged. `npm run deploy:all` now also probes every hashed asset that `index.html` references: one Pages deploy served the new HTML before an asset was reachable, the SPA fallback answered that asset with `index.html`, and the page could not load for about a minute.

## Branch handoff, 6 November 2026

`main` was a strict ancestor of the recovery branch (`fb5e416`, 41 commits behind, 0 ahead), so the handoff is a fast-forward with no merge commit and no history rewrite:

1. `recovery/stabilize-2026-11-01` got one hardening commit: `scripts/deploy-all.mjs` now accepts `main` as well as the recovery branch, and the README no longer prints the shared demo password (it points at `#/demo`, which signs each role in with one button and prints the manual password there).
2. That commit was pushed to `recovery/stabilize-2026-11-01`.
3. `main` was fast-forwarded to the same commit and pushed. The recovery branch stays frozen at `e4682a7` as a rollback, and `paypal-hackathon` keeps the pre-recovery TradePulse Pay work.
4. Deploys now run from `main`: `npm run deploy:all` refuses any other checkout and still refuses a dirty tree, a non-dev `CONVEX_DEPLOYMENT`, or a mismatched `SITE_URL`.

This changes no deployed backend or financial data. It moves the public default branch onto the build that has been under test since 1 November.

## Not done

- Block 1 residential reference job, owner milestone draw and the GC collected/paid/owed strip.
- B2, B10 and B13.
- Statutory California waiver forms, PayPal multiparty, QuickBooks.
- Production deployment, YouTube upload, Devpost submission, a new guided run, PayPal popup, live Owner-invoice retry and any financial write on a new run. Those remain owner decisions.
