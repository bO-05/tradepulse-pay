# R6 remediation record

Date: 2026-11-04 (Block 0 code record); live R6-A proof appended 2026-11-05
Audit: private R6 retest (kept in the ignored `docs/external-audit/` folder, not reproduced here)
Branch: `recovery/stabilize-2026-11-01`
Code commit: `a0833541140bdbb78d7457168f457c36ac89ed32`
App build deployed to canonical, mirror and Pages: `a0833541140bdbb78d7457168f457c36ac89ed32` (`a083354`)
Scope of this round: R6 Block 0 correctness only. The usefulness work in R6 Blocks 1-6 is not claimed here.

This file maps every R6 correctness finding to code and tests. It does not turn the R6 verdict into a pass. The product is still a tested sandbox build, not a real-money production service, and the ICP gaps the audit ranked remain open.

## Short result

Fixed in code with regression tests:

- Deleting a bid or project can no longer erase pay applications, Owner pay apps, prime change orders or other financial history through a void-then-delete path.
- The Owner invoice demo alias now keys on `isDemoProject || demoSandbox` and on the configured sandbox Owner address, not only the old `@demo.tradepulse` check. It is unit-tested and **live-proven** on a fresh guided run: the PayPal invoice billed the synthetic Owner alias and was confirmed paid.
- A retained-amount reduction at 50% now keeps the earlier hold and applies the reduced rate only to the new increment. G702, the approval-inbox split, the agent proposal split and the agent/review context use the pay app's stored G703 rate, so the confirm-before-money screen agrees with the payout.
- Approving different per-line amounts clears the stale inbox edit reason.
- The payee confirmation is admin-only in the UI, and the server refusal is unchanged.
- Retainage release sends the amount the GC confirmed; the action refuses with `AMOUNT_CHANGED` if the releasable amount moved. The confirm dialog names the payee email.
- Retention-expiry warnings use a human UTC date, warn once, and notify on expiry.
- A blocked sign-up now shows the real test-deployment reason on the Verify screen when the same address is retried.
- The pay-agent prompt labels sub notes as untrusted data, never as instructions.
- Money-trail labels separate this period's withhold from total retainage held; user-facing "AI recommends" wording is gone.

Partial or not fixed in this round:

- R6-A is **live-proven** as of 2026-11-05. On fresh dev run `nx7c971zm1xkfbaccs0wdtqae58hm175`, the Owner invoice `INV2-8DKA-MRJH-6BXD-DFL2` ($1,850) opened from the Owner app billed `owner-q9728ekyzqrb8sm290r6px1b5s8hn23q@example.com`, not the GC. PayPal confirmed it `paid`, the app recorded the payment, and a read-only browser rerun verified the Owner row shows `paid`. See the live proof section below.
- R6-D is partial. The Owner change-order detail labels UTC and PayPal shows its own date zone; there is no single combined timezone display across every Owner invoice surface.
- N-10, the guided-demo canned override reason, is deferred. R6 rule 5 forbids changing the guided-demo driver or runs before 12 Nov.
- Quick start now covers create a job, add a sub, paste a schedule of values and execute a subcontract in one pass. Real sign-up, the demo invite limitation, question a payment, the conditional lien-waiver gate, the 24-case review eval, the Owner job card and nav/inbox trimming remain open.

## R6 correctness findings

Status meanings: **Fixed** = code and regression tests in this branch. **Partial** = a real improvement, but the finding's outcome is not fully delivered. **Deferred** = reproduced and left open. **Architectural** = needs a payment/legal redesign or owner action, not a local patch.

| ID | Sev | Finding | Status | What changed / why it remains |
| --- | --- | --- | --- | --- |
| R6-A | P1 (demo) | Owner invoice alias never fires; step 13 fails live | Fixed and **live-proven** 2026-11-05 | `convex/payments/changeOrderRecipient.ts` treats `isDemoProject` or `demoSandbox` as a demo project and aliases the Owner email when it ends `@demo.tradepulse` or matches the normalized `PAYPAL_SANDBOX_OWNER_EMAIL`. Tests in `convex/payee.test.ts` cover both the old and the judge-demo-shaped project. Live proof: fresh guided run `nx7c971zm1xkfbaccs0wdtqae58hm175`, invoice `INV2-8DKA-MRJH-6BXD-DFL2`, bill-to `owner-q9728ekyzqrb8sm290r6px1b5s8hn23q@example.com`, PayPal `paid`, app row `paid`. |
| N-1 | P1 | Financial-history guard bypassed by voiding an agreement, then deleting its bid | Fixed | `convex/bids.ts` refuses `deleteBid` when a non-executed agreement still has financial history, before `deleteAgreementCascade`. `convex/payments/cascade.test.ts` adds the void-then-delete regression. |
| N-2 | P2 | Project delete ignores Owner pay apps and prime change orders | Fixed | `convex/projects.ts` refuses when any Owner pay app is not `draft`, or a prime change order is `approved`, `invoiced`, `paid` or has a PayPal invoice. `convex/payments/cascade.test.ts` covers a submitted Owner pay app on delete. |
| N-3 | P3 | Stale `editedReason` after the GC changes per-line amounts | Fixed | `convex/payApps/decisions.ts` clears `editedReason` whenever it rewrites or clears `editedAmountCents`. `convex/payApps/decisions.test.ts` covers the stale-reason case. |
| N-4 | P1 (money display) | Approval split uses the base rate while the payout uses the reduced rate | Fixed for the reviewed and proposed paths | `convex/payments/payoutMath.ts` adds `payAppRetainagePercent`, which prefers the pay app's stored G703 rate. `convex/payApps/proposals.ts` now builds the sheet and uses its G702 figures for the net, `convex/agent/proposalDb.ts` uses the applied rate for the agent split and prompt, and `convex/payApps/reviewContext.ts` uses it for review context. `convex/payApps/g703.test.ts` exercises a 50% reduction through approval, inbox split and agent inputs: $10,000 gross, $500 withheld, $9,500 net. |
| N-5 | P2 | G702 retainage and previous certificates disagree with the ledger after reduction | Fixed | `convex/payApps/g703Math.ts` keeps prior retained dollars and adds retainage only on the new increment when the rate changed; `convex/payApps/g703.ts` derives actual prior retained dollars from the latest approved G703 for previous certificates. Unit and integration tests cover the worked example: $434,626 held and $9,500 due. Same-rate historical rounding is preserved with a one-cent tolerance. |
| N-6 | P3 | Confirm payee is shown to non-admins | Fixed | `convex/partyProfiles.ts` returns `viewerIsAdmin`; `src/vendors/VendorDetailPage.tsx` shows "Only a company admin…" to other members. Server authorization did not change. `convex/payee.test.ts` covers the flag. |
| N-7 | P3 | Retainage-release amount can differ from the dialog; payee not named | Fixed | `convex/payments/retainage.ts` and `retainageDb.ts` accept `expectedCents` and throw `AMOUNT_CHANGED` with old/new amounts. `src/payments/RetainageRelease.tsx` sends it and shows the payee email. `convex/payments/release.test.ts` covers mismatch and payee email. |
| N-8 | P3 | Expiry warning prints a raw ISO timestamp and has no tests | Fixed | `convex/payments/honorPeriodDb.ts` formats a human UTC date/time. `convex/payments/honorPeriod.test.ts` covers warning once and the expired notice. |
| N-9 | P3 | `EMAIL_BLOCKED` copy is wrong under a custom allowlist | Fixed | `convex/lib/recipientAllowlist.ts` uses generic test-deployment text with no hardcoded default domains. Existing auth tests assert the refusal code. |
| N-10 | P2 (demo) | Guided-demo override reason is canned legal-sounding copy | Deferred | The string lives in `src/payments/judgeDemo/useJudgeDemoDriver.ts`. R6 rule 5 forbids changing the guided-demo driver or runs before 12 Nov, so it was not touched. |
| R6-B | P2 | "Retainage this app" shows cumulative retainage | Fixed | `src/billing/PayAppPage.tsx` labels the period withhold separately and labels the cumulative figure "Total retainage held to date… (G702 line 5)", with `data-testid="payapp-retainage-total"`. |
| R6-C | P3 | Blocked account re-sign-in loops to Verify without the reason | Fixed | `src/auth/authScreens.ts` persists the blocked reason in session storage; `SignInPage` and `CreateAccountForm` show it on the Verify step. `src/auth/authScreens.test.ts` covers the same-address retry. |
| R6-D | P3 | Owner invoice date shown in UTC while PayPal shows a local date | Partial | `src/billing/ChangeOrderDetail.tsx` already labels UTC. PayPal's own display zone is outside this app, and the other Owner invoice surfaces were not all audited, so this is recorded as partial. |
| Agent framing | P2 | Sub notes are passed to the pay agent as free text | Fixed | `convex/agent/agentLoop.ts` now frames notes as untrusted data supplied by the sub, never instructions. `convex/agent/agentLoop.test.ts` includes a prompt-injection note and asserts the framing. |
| AI wording | P3 | "AI recommends" implies the model chose dollars | Fixed | `src/billing/PayAppPage.tsx` and `src/billing/PayAppDecision.tsx` say "Review suggests" / "review suggestion". No `AI recommends` strings remain in `src/`. |

## R6-A live proof (2026-11-05)

This proof used a fresh guided demo run on dev; it did not touch the preserved reference run or production.

- Run: `nx7c971zm1xkfbaccs0wdtqae58hm175`
- Agreement: `jn759h53ce7h290fmpckyszrwd8hnzpc` (`A401-DEMO-PAY-20261105-07`)
- Change order: `kx76bc3nmm50bp7jymcemykm1x8hmn2b`
- Owner invoice: `INV2-8DKA-MRJH-6BXD-DFL2`, $1,850, opened from the Owner app
- Payer-view bill-to: `owner-q9728ekyzqrb8sm290r6px1b5s8hn23q@example.com` (the synthetic Owner alias, not the GC)
- PayPal status: `paid`; ledger `changeOrdersPaidCents` 185,000 and `changeOrdersInvoicedCents` 0
- Owner app: change-order row and invoice surface show `paid`
- Payment evidence: `evidence/recovery-settlement-2026-11-05T05-09-37-998Z/report.json`
- Read-only verification rerun: `evidence/recovery-settlement-2026-11-05T05-16-02-852Z/report.json`

The first write run paid the invoice, then the QA script timed out on its final Owner-row assertion. The report already showed `finalStatus: paid` and the correct alias. The assertion was fixed to open a fresh authenticated Owner tab (the invoice link had replaced the original tab), and the read-only rerun passed with no duplicate checkout and no errors. The timeout is recorded here rather than presented as a clean first-run script pass.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| Full test suite | 2,001 tests in 151 files passed after the final code change | local run on this branch |
| Type check | `npx tsc -b` clean after the final code change | local run |
| Guard audit | 258 public functions, 201 internal, 0 problems | `node scripts/tools/guard-audit.mjs` |
| Docs links | 83 relative links checked, all resolve | `npm run verify:docs` |
| Three-origin browser acceptance | 53/53 passed; all three hosts served `a083354` | `evidence/dual-host-browser-2026-11-04T13-29-16-412Z/report.json` |
| GC/sub/Owner role smoke on canonical | 6/6 checks passed; GC nav shows `Approvals`; mirror `/api/health` returns `ok` | `evidence/recovery-tradepulse-pay.asynchronope.tech-2026-11-04T13-30-47-467Z/report.json` |
| Blocked sign-up browser check | 5/5 checks passed; no email was sent; the Verify screen showed the generic test-address reason | `evidence/r5-auth-error-check-2026-11-04T13-33-14-482Z/report.json` |
| R6-A live Owner invoice | **Paid and verified** on fresh run `nx7c971...`; alias bill-to correct; Owner row `paid`; read-only rerun clean | `evidence/recovery-settlement-2026-11-05T05-16-02-852Z/report.json` |
| Quick start browser acceptance | 23/23 checks passed on build `2629233`; job and subcontract created, SOV approved, demo invite limitation shown | `evidence/quick-start-browser-2026-11-05T05-59-52-092Z/report.json` |

The blocked-sign-up report contains one console error with code `EMAIL_BLOCKED`. That is the refusal being tested, not an unexpected page failure. The screenshot is in the same evidence directory.

The full suite passed after the final code change. A passing unit suite is not live PayPal proof.

## Usefulness work not claimed

The R6 ranked plan estimated 48-61 hours for the ICP work. This round implements Quick start only:

- Quick start: create job, add sub, paste SOV, retainage and execute a subcontract. A real GC also
  creates the invite; the shared read-only demo company skips it with an explicit note. See
  [quick-start.md](./quick-start.md).
- Conditional lien-waiver gate with recipient and date, not a checkbox.
- 20-30 pay-app review eval cases with precision and recall.
- Sub "Question this amount" thread.
- Owner "job so far" card.
- Nav and inbox trimming.

Those remain the path from a strong demo to a product a real owner-run remodel GC can use. They are not hidden behind a "fixed" claim here.

## Immutable references

The preserved reference run `nx74k1sdcnsmqzvkr97kf0ts598hch6p`, agreement `jn78x0j5xeh7q9gb55p26r7pdh8hdmjx`, pay apps `ph72dz348hz9fdsbrj7t46qrgd8hdd3c` and `ph7fh2dpqnx82kq1dn3gwcp8yx8hcem6`, capture and payout IDs, and the read-only reference flag were not changed in this round. The existing PayPal funding, capture, payout and rules-engine math were not edited except where this record names a retainage display or guard path.
