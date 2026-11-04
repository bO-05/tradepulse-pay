# R5 remediation and release notes

Date: 2026-11-04
Audit: private R5 report (kept in the ignored `docs/external-audit/` folder, not reproduced here)
Branch: `recovery/stabilize-2026-11-01`
App build deployed to canonical, mirror and Pages: `eebfa4467087aac2f45681dc33f38686a23f2165` (`eebfa44`)

This file maps every finding from the R5 report and the code review. It does not turn the audit into a pass. The product is still a tested sandbox demo, not a real-money production service.

## Short result

Fixed in this round:

- A GC override of an agent proposal now requires a written reason, and the reason is shown to the sub and kept in the approval history and audit trail.
- Releasing retainage now requires an explicit confirmation in both the normal billing screen and the guided demo.
- Only a GC company admin can confirm a sub's changed payout email, and the UI warns that the new email must be verified out of band.
- Voiding an executed agreement, deleting a trade package or deleting a project is refused when payments, retainage or pay applications would be erased.
- The contractual retainage reduction at 50% complete is now applied to the G703 calculation, with unit tests.
- The GC is warned in-app once within 24 hours of a funding authorization expiring, and notified when it expires.
- A blocked auth recipient now gets the real "test deployment only emails test addresses" message instead of a generic send failure. `APP_ENV=production` is now supported as a deployment flag.
- UI copy distinguishes rules-computed dollars from model commentary. The normal sign-in page no longer links to the demo guide or shows the build stamp.
- Demo Owner invoices bill a reserved guest-checkout address, so the invoice email is not itself a sandbox login. This is tested in code, not proven against a live invoice.

Not fixed in this round, by design or because they need a larger change:

- Live PayPal mode, multiparty merchant design, fee ledger, Owner-to-GC disbursement, paid email infrastructure and per-tenant limits.
- Lien waivers, two-party subcontract signature, approval chains, disputes/chargebacks, attachments/comments, accounting sync, direct subcontract import and other workflow gaps.
- The recovery deployment still intentionally accepts only allowlisted test email addresses. A real GC cannot sign up on this deployment, and the UI now says so accurately instead of pretending a retry will work.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| Full test suite | 1,990 tests in 151 files passed; `tsc -b` clean | local run on this branch |
| Three-origin browser acceptance | 53/53 passed; all hosts served `eebfa44` | `evidence/dual-host-browser-2026-11-04T09-37-56-407Z/report.json` |
| GC/sub/Owner role smoke on canonical | 6/6 checks passed; GC nav shows `Approvals`; mirror `/api/health` returns `ok` | `evidence/recovery-tradepulse-pay.asynchronope.tech-2026-11-04T09-40-59-750Z/report.json` |
| Blocked sign-up message | 5/5 checks passed; no email was sent; the real test-address message appeared | `evidence/r5-auth-error-check-2026-11-04T09-39-17-499Z/report.json` |
| Guard audit | 258 public functions, 201 internal, 0 problems | `node scripts/tools/guard-audit.mjs` |
| Docs links | `npm run verify:docs` passes | local run |

The blocked-sign-up browser report contains one console error with code `EMAIL_BLOCKED`. That is the refusal being tested, not an unexpected page failure. The screenshot is in the same evidence directory.

## R5 report findings

Status meanings: **Fixed** = code and regression tests in this branch. **Partial** = a real improvement, but the finding's outcome is not fully delivered. **Deferred** = reproduced and left open. **Architectural** = needs a payment/legal redesign or owner action, not a local patch.

| ID | Sev | Finding | Status | What changed / why it remains |
| --- | --- | --- | --- | --- |
| R5-01 | P0 | Real sign-up blocked because the deployment only emails test addresses | Partial | `convex/lib/authEmail.ts` now throws `EMAIL_BLOCKED` with the real reason; `convex/lib/recipientAllowlist.ts` accepts `APP_ENV=production`. The recovery deployment is still test-only, so a normal GC still cannot sign up there. Paid email is R5-01's production half. |
| R5-02 | P0 | Platform is merchant of record for GC, sub and Owner money; escrow-like | Architectural | Not changed. `orders.ts` still creates orders without a payee and Owner invoices without an invoicer. Needs PayPal multiparty with each GC as seller, plus legal review. |
| R5-03 | P0 (demo) | Owner invoice step 13 fails with a guest card; merchant shows "Test Store" | Partial, unverified | Demo projects now bill `owner-<projectId>@example.com` through `demoInvoiceEmailFor`; a regression test covers it. The live invoice `INV2-6VQL-5GV8-5PZQ-NWS9` was not retried, and the sandbox merchant display name is still an owner/PayPal-dashboard action. |
| R5-04 | P1 | UI says "AI recommends" while rules set verdicts and amounts | Fixed in UI, partial in README | GC screens now say "Rules recommended", "Review and GC decision", and label model prose as commentary. README now says the model explains and cannot change a dollar. The model still cannot add detections beyond the rules. |
| R5-05 | P1 | Card/wallet fees and 29-day authorizations do not fit monthly draws | Deferred | No fee ledger, ACH rail or longer-lived funding. Expiry warnings were added, but the economics and rail remain open. |
| R5-06 | P1 | No setup path for a normal GC: no add vendor, manual bid or sub invite; CSI code first | Deferred | Not implemented in this round. This is the largest remaining product gap after sign-up and payments architecture. |
| R5-07 | P1 | GC override `$320 → $288` has no reason; sub sees no explanation | Fixed | `convex/payApps/proposals.ts` requires a non-empty `editedReason` on an edited proposal, stores it, exposes it to the inbox and carries it into `finalApproval.reason` and the audit row. The inbox shows the stored reason and links to approval. The guided demo supplies an explicit reason. |
| R5-08 | P1 | Release retainage sends money without confirmation | Fixed | `src/payments/RetainageRelease.tsx` and the guided-demo closeout release open `ConfirmDialog`; the payout runs only on confirm. `src/billing/recoveryConfirm.test.ts` covers both paths. |
| R5-09 | P1 | Lien waivers are a checkbox stub | Deferred | No waiver table, statutory forms, e-signature or pay gate. `billing/payGateHooks.ts` is still a stub. |
| R5-10 | P1 | Sub has no dispute, comment or resubmit path; explanation not shown to sub | Deferred | No comment/dispute table or thread. The sub now sees the GC's edit reason, which is not the same as a dispute path. |
| R5-11 | P1 | Owner change order does not flow into the sub's SOV | Deferred | Not changed. |
| R5-12 | P2 | 50% retainage reduction stored but never applied | Fixed, with caveat | `retainageBpsAtProgress` in `convex/payments/payoutMath.ts` is applied by `g703Context` once approved-to-date reaches 50% of the contract sum. Tests cover before/at/after 50% and invalid inputs. The G703 still applies one rate to total-to-date, so historical certificates are not blended per period. |
| R5-13 | P2 | Single approver; no approval chain | Deferred | Payee confirmation is now admin-only, but approve, pay and release still allow any GC member. |
| R5-14 | P2 | Void agreement and delete project can erase payment/retainage history | Fixed | `payments/cascade.ts` defines the financial-history guards. `voidExecutedAgreement`, trade-package deletion and project deletion refuse when money or retainage exists. Tests cover refusal and the allowed no-money case. |
| R5-15 | P2 | Any GC member can confirm a changed payout email | Fixed in authorization; partial in verification | `confirmPayee` now uses `requireCompanyMember(..., { admin: true, write: true })`. The vendor UI warns the admin to verify the new email out of band. There is still no PayPal ownership check or cool-down. |
| R5-16 | P2 | GC lands on the guided-demo recap; inbox copy is long; 14 nav items | Partial | The demo GC button now opens `#/inbox`; the GC nav label is `Approvals`; the normal sign-in page no longer advertises the demo. The long inbox and full nav trim were not changed. |
| R5-17 | P2 | Developer text in user screens (`Convex`, `KERNEL`, `AG Studio`, camelCase, `fixture`, build footer) | Partial | The build stamp was removed from the normal auth shell and role shell; AI wording changed. Vendor names remain in audit/KERNEL/Studio surfaces, and the demo page still shows build and recovery copy. |
| R5-18 | P2 | Demo password and test card exposed on an ungated `#/demo`, linked from sign-in | Partial | The sign-in link was removed and guarded by `src/auth/SignInPage.test.tsx`. The `#/demo` route is still always reachable and still shows the demo password, test card and canonical/mirror URLs. `VITE_DEMO_MODE` gating is not implemented. |
| R5-19 | P3 | axe color-contrast serious on every page | Not re-tested | Removing the build footer from normal pages may remove one small-text node, but no final axe run was done. Treat as open. |
| R5-20 | P3 | CSLB California check on a Texas project | Deferred | The copy still discloses California/CSLB. No state-aware licence source. |
| R5-21 | P3 | Disabled "Continue this run" after a cancelled checkout; guide says popup but checkout is an iframe | Deferred | No copy or disabled-state fix in this round. |

## Code-review findings

| ID | Sev | Finding | Status | Note |
| --- | --- | --- | --- | --- |
| P0-1 | P0 | PayPal client refuses any environment except sandbox | Architectural | Not changed. Live mode must wait for P0-2/P0-3. |
| P0-2 | P0 | Platform is merchant of record; no payee/invoicer/multiparty onboarding | Architectural | Not changed. |
| P0-3 | P0 | PayPal fees are not modelled; payouts assume gross was received | Architectural | Not changed. |
| P0-4 | P0 | Owner payments never reach the GC | Architectural | Not changed. |
| P0-5 | P0 | Non-prod allowlist and generic blocked-recipient error | Partial | Accurate `EMAIL_BLOCKED` and `APP_ENV` flag added; deployment remains test-only. |
| P0-6 | P0 | One shared free inbox; global email and sign-up caps | Deferred | Needs a paid ESP, own domain and per-tenant budgets. |
| P1-1 | P1 | Lien waivers are a stub | Deferred | See R5-09. |
| P1-2 | P1 | Sub never signs the subcontract | Deferred | `agreements.ts` remains GC-only execute. |
| P1-3 | P1 | 50% retainage reduction not applied | Fixed, with caveat | See R5-12. |
| P1-4 | P1 | Authorization expiry has no notification | Fixed | `schema.ts` adds `funding_expiring` and `funding_expired`; `honorPeriodDb.ts` warns the project's GC company once within 24 hours and notifies on expiry. Existing honor-period tests pass. |
| P1-5 | P1 | Any GC member can confirm a changed payout email | Partial | Admin-only confirmation and warning; no PayPal ownership check or cool-down. |
| P1-6 | P1 | No separation of duties for approve/pay/release | Deferred | Not changed. |
| P1-7 | P1 | Void/delete can erase financial rows | Fixed | See R5-14. |
| P1-8 | P1 | No dispute, chargeback or reversal handling; no clawback | Deferred | `webhookEvents.ts` still misses dispute and reversal events. |
| P1-9 | P1 | No import of an existing subcontract/SOV | Deferred | See R5-06. |
| P1-10 | P1 | In-app notifications only; no transactional email | Deferred | Expiry notifications are in-app only. |
| P2-1 | P2 | Model cannot add detection beyond the rules | Deferred | Wording is now honest; the capability is unchanged. |
| P2-2 | P2 | Sub text reaches the prompt; model prose shown even when overridden | Partial | `reviewModel.ts` names sub-controlled fields as untrusted, adds a SECURITY instruction, and the UI labels model notes as commentary. It cannot move money, but free-text injection remains possible prose-level. |
| P2-3 | P2 | Pay-app evals are four demo-only fixtures | Deferred | No new fixture set or CI gate. |
| P2-4 | P2 | Open LLM proxy and Firecrawl scrape with no per-tenant quotas | Deferred | Not changed. |
| P2-5 | P2 | Webhook verifies a re-serialized body; unverified POST writes/calls without rate limit | Deferred | Not changed. |
| P2-6 | P2 | Global cron scans and audit noise | Deferred | Not changed. |
| P2-7 | P2 | No pay-app attachments/photos or comment threads | Deferred | Not changed. |
| P2-8 | P2 | Retainage release has no closeout gate | Deferred | Confirmation added; substantive gate still missing. |
| P2-9 | P2 | Payment terms not enforced or tracked | Deferred | Not changed. |
| P2-10 | P2 | No QuickBooks/Xero/Sage sync | Deferred | Not changed. |
| P2-11 | P2 | One company and one global role per user | Deferred | Not changed. |
| P2-12 | P2 | USD hardcoded; no PayPal limit checks or payout splitting | Deferred | Not changed. |
| P2-13 | P2 | No structured TIN/1099 handling | Deferred | Not changed. |
| P3-1 | P3 | Demo password/test card/recovery copy not gated | Partial | Sign-in link removed; `#/demo` still reachable and ungated. |
| P3-2 | P3 | Build stamp on every page | Fixed for normal pages | Removed from `AuthLayout` and `RoleShell`; retained on `DemoAccessPage`. |
| P3-3 | P3 | Vendor/internal names in user copy | Deferred | Partial AI wording only. |
| P3-4 | P3 | Public synthetic PDFs with `ACAO: *` | Deferred | No deletion; owner/repo presentation decision. |
| P3-5 | P3 | Unused `canViewAgreement` cross-tenant helper | Fixed | `convex/lib/roles.ts` helpers removed; guard sweep and guard-audit regex updated; audit remains 0 problems. |
| P3-6 | P3 | Placeholder `not-published@verify-required.invalid` stored as an email | Deferred | Not changed. |
| P3-7 | P3 | Payee emails in audit text; prompts persisted indefinitely | Deferred | Not changed. |

## Audit section 6 recommendations

| Recommendation | Status |
| --- | --- |
| Publish the under-3-minute video and Devpost entry | Owner-only; still missing. This remains a Stage One failure. |
| README live URL, Mistral provider, branch instructions, video link | README already used the canonical URL and Mistral on this branch; AI wording was corrected in this round. Video link still missing. Default-branch presentation is owner-only. |
| Fix Owner invoice step 13 and merchant display name | Partial: code alias and test added; live invoice not retried; merchant name is a PayPal dashboard action. |
| Hide Create account for judges or allowlist their domain; show the real error | The real error is fixed. Hiding sign-up was not done because the product needs a real onboarding path, not a hidden one. Allowlisting a judge's domain is an owner/deployment action. |
| Honest AI wording everywhere | Fixed on the main GC, inbox, dashboard, demo and README surfaces. Some prose in secondary screens may remain. |
| Require an override reason and show it to the sub | Fixed. |
| Confirm retainage release | Fixed. |
| Re-pitch to small residential GCs and homeowner-funded jobs | Documentation direction only; no pricing or landing-page rewrite. |
| Land the GC on the approval inbox; trim nav | Partial: demo GC lands on `#/inbox`, nav says `Approvals`; no nav trim. |
| Remove developer strings or gate them | Partial: build stamp removed from normal pages; other strings remain. |
| Lien-waiver gate, sub question button, glossary, footer contrast | Deferred. |

## What a real pilot still needs

The honest next step is not another copy pass. It is:

1. A production-shaped PayPal design: each GC onboards as a seller through PayPal Commerce Platform, the GC's account receives the Owner's payment, and TradePulse never holds GC, sub or retainage money. Get legal review before writing live credentials.
2. A fee and balance ledger so retainage is never paid from another customer's money.
3. A real ESP on an owned domain with SPF, DKIM, DMARC and per-tenant budgets, then `APP_ENV=production` on a deployment allowed to email real users.
4. A setup path that accepts an existing subcontract and SOV, not only an awarded bid.
5. Statutory lien waivers, two-party signature, approval thresholds and a dispute path.
6. A live end-to-end pilot with one GC, one sub and one Owner, with every PayPal ID and fee reconciled independently.

Until those exist, the correct claim is: **a tested sandbox product that demonstrates contract-aware pay-app review and an auditable PayPal money trail**, not a production payment service.
