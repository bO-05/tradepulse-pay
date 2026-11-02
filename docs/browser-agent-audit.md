# TradePulse Pay: independent browser audit playbook

Prepared November 2, 2026. Application/evidence baseline: November 1, 2026.

This is a testing contract, not a passing audit. A developer's historical tests, this document's expected results and
a green UI badge are not independent proof that a feature works now. Report what you actually observe.

## 1. Run the blind round first

The commissioning owner should give the agent [the blind first-use brief](./browser-audit-start.md) **before** this file.
Return that report before reading the walkthrough below. If you already read this file, disclose that your first-use
assessment is assisted. Use a new agent without this context for a genuinely blind retest.

Assess these separately:

- **Intuitive:** a new user discovers the right task and understands consequences without coaching.
- **Effective:** the intended actor completes the task and the persisted result is correct.
- **Efficient:** the path has reasonable navigation, waiting, interaction cost and recovery effort.
- **End-to-end:** all required actors, provider actions and final states are actually exercised, not inferred.

Use several specialist lenses if helpful: first-use UX, contractor workflow, accounting/payments, accessibility,
privacy/security, performance and skeptical judging. Label these as review lenses, not fabricated human auditors.
Read-only checks can run independently; only **one designated writer** may run the sandbox write round.

## 2. Target, source and access

| Item | Value |
| --- | --- |
| Only application origin in scope | `https://cheery-axolotl-689.convex.site` |
| Public demo access guide | https://cheery-axolotl-689.convex.site/#/demo |
| Public health check | https://cheery-axolotl-689.convex.site/api/health |
| Matching application source baseline | https://github.com/bO-05/tradepulse-pay/tree/533a5df15a3b48c5c799eb51e99bcd9fe3bc57a5 |
| Recovery branch | https://github.com/bO-05/tradepulse-pay/tree/recovery/stabilize-2026-11-01 |
| Reference frontend publication | `635d0934-2b12-49c6-bb12-69037b3673ba` |
| Observed reference main asset | `index-RGkj5_mO.js` |
| GC login | `gc@demo.tradepulse` / `TradePulseDemo!2026` |
| Subcontractor login | `sub1@demo.tradepulse` / `TradePulseDemo!2026` |
| Owner login | `owner@demo.tradepulse` / `TradePulseDemo!2026` |
| Optional other-sub read-only isolation comparison | `sub2@demo.tradepulse` / `TradePulseDemo!2026` |

The matching source is on the recovery branch, **not the older `main` branch**. If the app is updated, record the new
observed fingerprint and ask the commissioning owner to associate it with the correct commit before final certification.
The health response's `version: 1.0.0` is not a Git commit and does not establish exact-source correspondence.
You may inspect an asset filename without executing or modifying code. Record “not observable” if unavailable.

Use truly isolated profiles/contexts, not just tabs. Chrome private windows commonly share one private session.
Never attach to a personal authenticated browser. If the browser service supports only one identity, test sequentially
with ordinary sign-out and explicitly mark concurrent-role testing unavailable.

No personal paid account or provider API key should be needed for the core demo. Shared demo roles are ordinary
password-authenticated accounts, not a bypass. Never reset their passwords or “fix” their memberships.

## 3. Permissions and stop conditions

Possession of credentials is not permission for consequential actions. Assign a round explicitly:

| Round | Assignment and permitted effects |
| --- | --- |
| 0 | Blind read-only audit, using the separate brief. |
| 1 | Assisted read-only inspection, all three roles, mobile/accessibility, links and truthful claims. |
| 2 | **Owner-assigned only:** one new guided sandbox run, one `$5,500` mobilization authorization, its two guided pay-app capture/payout workflows, one `$1,850` Owner invoice payment, and optionally its one retainage release. |
| 3 | **Separately assigned:** one new `QA-<UTC timestamp>-MANUAL` project for standard/manual workflow testing, with controlled test counterparties; no payments, outbound email or legal attestations by default. |
| 4 | Fix verification. Read-only by default; financial repetition needs its own fresh round-2 assignment and budget. |

The guided driver in round 2 performs labeled fixture writes and GC approvals. Starting it explicitly authorizes those
demo approvals. It is not proof that the subcontractor used the normal portal or that an independent agent had authority
to spend. The normal production controls must not be bypassed to make round 3 pass.

### Always prohibited

- Production, other Convex deployments, provider consoles, deployment/configuration changes, database operations,
  seeding/resetting, deletion, account-role edits and API-key inspection.
- Real cards, personal PayPal accounts, real customer data, third-party RFQ/invite emails, marketing consent,
  account creation at PayPal, subscription purchases or surprise top-ups.
- Changing the preserved settled reference run, its proposals, change order, compliance documents or payment state.
- Arbitrary email signup/reset requests. Recovery mail is restricted to owned allowlisted inboxes.
- Fake compliance attestations, forged insurance/W-9/license evidence, signature claims or manual verification overrides.
- Hidden API calls, tampering with JWTs/cookies, brute force, broad fuzzing, load testing, changing browser responses,
  or injecting state to skip workflow steps.
- Publishing reports containing personal data/secrets; uploading a public video; submitting/editing Devpost; merging,
  pushing source or otherwise writing to an outside platform.

If origin, identity, record, sandbox status, amount or authority is uncertain, **stop before confirming**.
After a timeout on a payment action, its result is **unknown**, not automatically failed. Inspect status on the same
record; never create another run, invoice or payment just to clear uncertainty.

Bound round 2 to one run. Record the app's actions even if they fail; do not keep creating fresh runs to obtain a clean
sample. Stop on unexpected extra financial requests, unexpected recipients, production checkout, requests for real
identity/credentials, unavailable guest checkout or unexpected money amounts. Report the blocker rather than improvising.

## 4. Recording protocol

Create one audit identifier, for example `TPP-20261102-A`. Record UTC time, local timezone, browser/version, viewport,
device/emulation, input method, network condition if known, tested role and assigned round.

For every check use one result:

- **PASS:** directly observed the required outcome.
- **FAIL:** observed a mismatch; include reproduction evidence.
- **BLOCKED:** attempted, but access, provider, fixture or environment prevents completion.
- **NOT TESTED:** not attempted or outside the assigned permission boundary.
- **NOT OBSERVABLE:** cannot establish it with the available browser-only tools.

Also record evidence class: browser observation, public source/document observation, developer-provided historical
evidence, or owner attestation. Do not promote a developer report into your own live verification.

Capture small, relevant screenshots at important boundaries, not indiscriminate account dumps. Sanitize console
errors before saving. Record network timing/status/counts if available, but do not export HAR files, request headers,
cookies, auth payloads or session storage. Redact non-demo email addresses, personal data, invitation bearer links,
OAuth codes and tokenized checkout/payer URLs. Business record IDs below are intentionally provided for correlation.

Keep a run ledger:

| Audit/run | Role/context | Agreement | Pay apps | Invoice | Actions attempted | Final observed states |
| --- | --- | --- | --- | --- | --- | --- |
| Reference, read-only | Fill in | Reference ID below | Reference IDs below | Reference ID below | View only | Fill in |
| Fresh, if round 2 assigned | Fill in | Copy from your run | Copy from your run | Copy from your run | Include unknown/failed actions | Fill in |

## 5. Round 1: independently inspect the settled reference

### Exact records

- Run: `nx74k1sdcnsmqzvkr97kf0ts598hch6p`
- Run URL: https://cheery-axolotl-689.convex.site/#/judge-demo/nx74k1sdcnsmqzvkr97kf0ts598hch6p
- Agreement: `jn78x0j5xeh7q9gb55p26r7pdh8hdmjx`
- Agreement label: `A401-DEMO-PAY-20261101-02`
- Ledger: https://cheery-axolotl-689.convex.site/#/payments/jn78x0j5xeh7q9gb55p26r7pdh8hdmjx
- Honest pay app: `ph72dz348hz9fdsbrj7t46qrgd8hdd3c`
- Adversarial pay app: `ph7fh2dpqnx82kq1dn3gwcp8yx8hcem6`
- Change order: `kx79veecm7m5m0gqw5mz1nmb718hch9t`
- Owner invoice: `INV2-34SZ-2MQV-HYR9-TCRG`

Use these IDs to disambiguate shared-account records. Do not select “the latest” and assume it is this case.
Do not click **Run**, **Continue**, **Approve**, **Refresh status**, **Release**, **Send**, **Check license** or **Pay**
on this reference. Some apparently harmless refresh/check buttons invoke provider calls and persist state.

### Historical financial oracle

These are the verified November 1 values, not a guarantee against changes by other public demo users.

| Item | Expected reference value |
| --- | --- |
| Contract / SOV | `$55,000`; four base lines `$22,000`, `$18,000`, `$10,000`, `$5,000` |
| Excluded scope | `$4,500` seismic bracing, not included in payable base scope |
| Mobilization | `$5,500` authorization, partly captured |
| Honest claim / approved gross | `$2,000` / `$2,000` |
| Honest payout / retained | `$1,800` / `$200` |
| Adversarial claim | `$13,500` |
| Model recommendation / GC-edited gross | `$320` / `$288` |
| Adversarial payout / retained | `$259.20` / `$28.80` |
| Total captured gross | `$2,288` |
| Progress payouts before retainage release | `$2,059.20` |
| Retainage released | `$228.80` |
| Total paid after release / still held | `$2,288` / `$0` |
| Remaining authorized funds | `$3,212` |
| Remaining base contract balance | `$52,712` |
| Separate Owner change-order invoice | `$1,850`, PAID |

The app's `fundedCents` reference value is `321200`: remaining authorization after captures, **not** the original
`550000` authorization. Determine whether the UI labels this understandably.
The Owner's `$1,850` is separate change-order revenue, not a subcontract payout or full-contract completion.
Global dashboard totals can legitimately include other agreements.

Reference provider identifiers:

| Record | Identifier / verified state |
| --- | --- |
| Funding order / authorization | `0WV193651L210315U` / `94G95136J6812154U` |
| Honest capture | `4HL52442UH4760109`, COMPLETED |
| Honest payout batch / item | `7VG6NTD87W2JJ` / `8P8CUQQA4RBV8`, item SUCCESS |
| Adversarial capture | `9X249756PN047684B`, COMPLETED |
| Adversarial payout batch / item | `RFQ4YLNXPXL8S` / `ZFJ6GVLK6C44U`, item SUCCESS |
| Retainage batch / item | `SUQPHFZK3KLSG` / `HQ6GL4NYM9D32`, item SUCCESS |

An app screenshot alone cannot independently verify a PayPal API response or webhook. Compare what the app exposes;
label independent provider reconciliation NOT OBSERVABLE unless the owner supplies separate read-only verification.
Never request business API credentials from the owner for this browser audit.

### Inspection checks

| Check | Task and expected property |
| --- | --- |
| R1-01 | Public guide is reachable signed out, fits the viewport, explains roles, sandbox and limitations, and offers ordinary sign-in. |
| R1-02 | All three credentials work. Confirm identity/role after each login. No silent identity replacement from public role buttons while already signed in. |
| R1-03 | GC opens the exact bookmarked run. Reload and Back/Forward preserve the selected run, rather than jumping to a newer shared run. |
| R1-04 | Guided history and the agreement/ledger link refer to the same IDs. Do not resume the driver. |
| R1-05 | Agreement scope, exclusions and SOV totals are intelligible. No implication the entire contract is paid. |
| R1-06 | GC finds both exact pay apps in Approval inbox; compare requested, recommended, approved, captured and paid amounts. |
| R1-07 | Adversarial findings distinguish excluded scope, overbilling, sequencing and missing-waiver issues. Separate model advice from GC decision and payment execution. |
| R1-08 | Trace identifies actual provider versus “Offline rules engine”, evidence and executed/pending tools. No exposed hidden reasoning or secrets. |
| R1-09 | Rescheduling is a proposal/pending action where applicable, not falsely shown as accepted just because it was suggested. |
| R1-10 | Ledger reconciles the historical totals; capture completion and payout-item success are distinct. |
| R1-11 | Owner finds the exact agreement's invoice, sees PAID `$1,850`, and has no GC approval controls. Open only; never pay again. |
| R1-12 | Sub1 finds its own agreement/pay apps and readable payment status. It cannot approve its own claim as GC. |
| R1-13 | Optional Sub2 same-record URL check shows no Sub1-only pay-app content. A denied page must not briefly flash protected content. |
| R1-14 | Dashboard aggregation is understandable and not confused with the selected agreement's totals. |
| R1-15 | Opening and canceling forms does not persist or send anything. Required fields, recipient selection and cancellation are clear. |
| R1-16 | Normal sign-out removes protected content; direct signed-out links require authentication without exposing data. |

Absence of a button is not backend authorization proof. The optional cross-sub test is a small UI negative case,
not authorization to enumerate IDs or conduct a penetration test.

## 6. Route and role coverage

Use the menu first. Use these route hints only after evaluating discoverability. Expected labels may vary by role.
Record page-specific data, empty states, broken links, loading/error handling and whether the next action makes sense.
Do not count “page shell loaded” as functional completion.

| Role | Surface | Route hints / read-only audit tasks |
| --- | --- | --- |
| GC | Procurement | `#/procurement`: projects, packages, bids, leveling/award discoverability; do not award. |
| GC | Projects | `#/projects`, `#/all-projects`: understand the distinction, open correct project and agreement. |
| GC | Approval inbox | `#/inbox`: filter/find the exact two reference apps; open details and inspect decisions. |
| GC | Payments | `#/payments`, `#/payments/<agreementId>`: authorization, capture, payout and retainage distinctions. |
| GC | Billing | `#/billing`, `#/billing/owner-billing`, `#/billing/retainage`, `#/billing/documents`: labels, totals, navigation; no settlement actions. |
| GC | Change orders | `#/change-orders`: scope, recipient, invoice status and agreement correlation. |
| GC | Compliance | `#/compliance`: distinguish fixtures, self-report, source-backed checks and expired/unverified evidence. |
| GC | People / Vendors | `#/people`, `#/vendors`: open/cancel invite; see recipient-reset checks below. No send/copy-invite action in read-only mode. |
| GC | Billing agents | `#/billing-agents`: authority and stand-in disclosure; do not issue/revoke keys or change authorizations. |
| GC | Dashboard | `#/dashboard`: basic React reporting works without a paid editor. Optional Studio audited separately. |
| GC | Guided demo | `#/judge-demo`, `#/judge-demo/<runId>`: history, pinned selection, proof links and honest progress. |
| Sub | Home / work | `#/portal`, `#/my-projects`, `#/bids`: own-company scope, actionable status and understandable empty states. |
| Sub | Pay applications | `#/pay-apps`, `#/pay-apps/<payAppId>`: own claim, evidence, approval history and payout status. |
| Sub | Changes / compliance / money | `#/change-orders`, `#/compliance`, `#/payments`: appropriate access and no GC authority. |
| Owner | Home / projects | `#/projects`, `#/my-projects`: correct owned projects and a clear next step. |
| Owner | Applications / changes / reports | `#/owner-pay-apps`, `#/change-orders`, `#/dashboard`: read access, correct invoice, meaningful reports; no GC decision controls. |
| All roles | Company / notifications | `#/company`, `#/notifications`: sensible scope, labels and empty states. Do not edit company or mark messages read if that writes shared state. |

### Focused regression traps

1. Open an invite form, choose vendor A, then B, then the new/blank option. B's email replaces A's; blank does not
   retain A's recipient. Cancel. Never send or save an invitation to test this.
2. Open a new-package form without saving. Deadline defaults to roughly two weeks ahead in the local calendar,
   not an old hard-coded date. Calendar defaults should remain sensible around month/year boundaries; do not change
   the whole machine's clock to test this.
3. Open manual vendor creation without saving. Default license status is self-reported; blank license number/source
   stays blank. A status dropdown is not actual regulatory verification.
4. From a phone viewport, the guide's “Choose a demo role” jump should reveal role choices and move keyboard focus
   meaningfully. Check reduced motion if available.
5. In a second GC context, select a different existing run. The first context stays on its own bookmarked run after
   live updates/reload. Merely sharing a login does not mean selections should collide.
6. Open an unknown non-sensitive app route and a syntactically invalid record link. Expect a recoverable error,
   not a blank crash or unrelated data. Do not guess other tenants' valid IDs.

## 7. Round 2: one fresh guided sandbox settlement

**Do not execute this section until the owner explicitly assigns round 2.**
It creates records, uses paid provider resources and causes actual PayPal sandbox state changes. It does not move
real money, but it is not read-only.

### Preflight

1. Record the write assignment and audit ID. Only one writer, one new run; no cleanup/reset afterward.
2. Use GC and Owner isolated sessions. Preserve a read-only tab of the reference run if checking selection isolation.
3. Confirm the exact in-scope app origin, GC identity and PayPal **sandbox** before authorizing anything.
   The top-level PayPal checkout/payer host must be exactly `www.sandbox.paypal.com` or `sandbox.paypal.com` over HTTPS.
   A “sandbox” label in page text, a query parameter or an unrelated hostname is not sufficient.
4. Verify popups/third-party checkout can open. If your browser service prohibits checkout, report BLOCKED;
   do not use personal logged-in PayPal to get around it.
5. Know where the driver explains its fixture stand-ins and approval authority. If this is not clear before Start,
   record the consent/disclosure defect.

### Start, fund, review and pay

1. GC → Guided demo → **Run TradePulse Pay demo**. Create one fresh run. Immediately record/bookmark its run URL,
   project, agreement and label. Do not substitute the historical reference.
2. Inspect the generated `$55,000` award, scope and exclusions. Watch what is generated automatically versus
   what you actually did. Do not describe generated execution or compliance fixtures as legally verified documents.
3. Open mobilization **Fund**. Confirm the exact new agreement, **`$5,500`**, sandbox and expected payee context.
4. Use guest/card checkout with these **public synthetic sandbox details only**:
   - Card `4032031427005060`; expiry `01/29`; CVV `480`.
   - Name Sandbox Buyer; 123 Test Street; San Jose; California; 95131; United States.
   - Phone `2025550100`; a unique synthetic `qa-<timestamp>@example.com` email.
   - Select United States if necessary and wait for the appropriate state options.
   - No real information, real account login, account creation or marketing opt-in.
   - If CAPTCHA, identity verification or a real phone/email challenge blocks the synthetic flow, report BLOCKED;
     do not evade the challenge or substitute a personal identity.
5. Complete the one sandbox authorization. Return to the same run; verify a provider order/authorization and actual
   funding status. A closed popup is not evidence of success.
6. Keep the GC page open. Observe the two labeled submissions, model review, proposals, explicit demo GC approval
   and edited approval, then capture/payout attempts. Record the model/provider and any honest fallback.
7. The driver can wait up to roughly five minutes for model/proposal work, three minutes for payout status and
   twenty minutes for human funding. Record actual elapsed time and visible feedback. A ten-second automation
   timeout alone is not proof the business operation failed; an unexplained long wait is still a UX defect.
8. Verify capture **COMPLETED** and payout **item SUCCESS**, separately. PENDING, UNCLAIMED, batch creation,
   a submitted request or an action toast does not mean the subcontractor has been paid.
9. The driver stops after submitting the Owner invoice. Record that milestone without claiming full settlement.
10. In the isolated Owner session, locate **this new agreement's** change order. Verify its invoice is **`$1,850`**
    and unpaid before opening its sandbox payer page. Pay once with the synthetic guest details above.
11. Return to GC for this exact agreement. **Refresh status** reads the actual provider invoice state. Wait for
    PAID and record the displayed invoice ID and amount. Do not create another invoice to force a green badge.
12. If the assignment includes retainage release, release only this run's accrued positive retainage, once.
    Verify the release payout item reaches SUCCESS and held retainage falls accordingly.
    An extra platform top-up is **not** preauthorized. If requested, stop and report its amount/reason.

### Fresh-run oracles, not hard-coded historical AI output

Do not assume the new model recommends exactly `$320` or the approved adversarial gross will be `$288`.
Those numbers belong to the reference run. Record this run's actual recommendation, GC edit, reasoning summary
and code-enforced results; investigate contradictions rather than dismissing them as model variability.

Verify these identities using cents and the displayed rounding:

- For each pay app: approved captured gross = progress payout net + retained amount.
- Total captured = sum of completed captures, excluding pending/failed requests.
- Total paid = successful progress payouts + successful retainage releases, without counting a release twice.
- Held retainage = accrued retainage minus successfully released retainage.
- Remaining authorization reflects completed captures from the original authorization, not Owner revenue.
- The approved amount must not silently revert to the claimed amount; excluded scope must not become payable
  simply because a model suggested it.
- Owner invoice receipts are separate from subcontractor disbursements.

Observe whether the guided GC edit is genuinely reflected in the final capture/payout, not just in explanatory text.
If the UI cannot expose a necessary reconciliation field, report NOT OBSERVABLE with the exact missing field.

### Resume and idempotency without forcing duplicates

- After the new run is safely at a known state, reload its bookmarked URL. **Continue this run** must resume that
  run, not create a new one. Record IDs before/after.
- Do not blindly re-click confirmation after a network failure. Read persisted status first.
- Once fully settled, reload and inspect whether invoice, capture and payout IDs remain unchanged.
  Do not click financial actions merely to probe duplicate protection.
- Browser observations cannot prove every webhook retry/idempotency path. List deeper backend checks separately.
- No concurrent writers, repeated starts, payment fuzzing or deliberate mid-confirmation network interruption.

Return both success and failure evidence. If you cannot complete Owner payment, the result is partial E2E,
even if the guided GC sequence finished.

## 8. Round 3: standard user workflow, separately from the guided driver

**This is a separately assigned extended round, not permission included in round 1 or 2.**

The driver uses stand-ins; it does not establish that ordinary procurement, subcontractor filing or fresh onboarding
is intuitive. Test those honestly. Use one separate manual QA project, never append extra claims to the reference or
the fresh guided settlement and then try to reconcile the old totals.

### Access requirements

- Normal new-account verification requires an owner-provided, reachable **allowlisted test inbox**. Do not use a
  personal address, request random verification emails or reset a previously created test account.
- The already-tested `dullstreet57@agentmail.to` account exists; its password and mailbox access are **not provided**
  to this external browser audit. Do not reset it or claim to test signup through it.
- Without separately provisioned inbox access, mark fresh signup, delivered code and password-reset completion
  BLOCKED. You may inspect their forms without sending. The public demo accounts remain available for other checks.
- The manual project must use controlled test identities. No discovered real contractor is a consenting recipient.
- The default extended assignment allows one project and drafts, not outbound emails, payment, invite acceptance
  writes or legal attestation. Record additional permissions needed rather than inventing authority.

### Manual journey checklist

| Stage | What to test / proof needed |
| --- | --- |
| Signup, if provisioned | Reachable email receives the real code; correct code redeems; wrong/expired-code handling is sensible without repeated attempts. Never publish the code or password. |
| Company setup | A new GC understands role/company choice; invitees are not misled into creating unrelated GC companies. |
| Project | Create one `QA-<UTC>-MANUAL` project if assigned. Required fields, save state, navigation and two-week date default are clear. |
| Scoping | Add one manual trade package. Optionally try AI scoping if its paid request is assigned; distinguish live model response from fallback. |
| Vendors / bids | Use controlled test records; enter one permitted manual bid. Discovery is optional, source-linked and unverified, not a license or consent check. Do not dispatch RFQs. |
| Award / agreement | Inspect leveling and award flow. Execute only steps expressly permitted; never falsely claim a real signature. Check scope exclusions survive into contract/SOV. |
| SOV | Check totals, rejected inputs and the approval boundary. Do not approve real-world work or compliance evidence you cannot attest to. |
| Sub invitation | Open/cancel the form; test recipient selection. Sending or accepting a controlled invitation requires a separate explicit assignment and provisioned identities. |
| Sub filing | If provisioned and assigned, Sub signs in independently, locates its own agreement, enters/saves one draft. Submission is a separate consequential step, not inferred from a draft. |
| GC review | If submission/decision testing is assigned, GC sees the actual Sub-filed app and model review; it cannot be counted as “manual” if the demo driver filed it. |
| Funding/payment | Genuine payee, company funding and compliance gates must hold. Do not fabricate evidence or bypass them. Default manual-round permission includes no payment. |
| Owner | Independently provisioned membership/invitation is needed for a new manual project's Owner workflow. The existing demo Owner is not automatically proof of this onboarding path. |
| Attachments | Only if assigned, upload one small supported synthetic QA file marked “TEST ONLY, NOT COMPLIANCE EVIDENCE”. Check filename/visibility and access; no forged legal certificates. |

A blocked real-company payment gate may be correct security behavior. It is not a manual-workflow pass.
If the submission promises an untested or inaccessible path, flag the promise as unsupported.

## 9. UX, accessibility, resilience and performance

Test representative screens, not only the landing page: guide, sign-in, role shell/menu, a long pay-app review,
agreement ledger, a form/dialog, Owner invoice and dashboard.

### Viewports and input

- Desktop around `1440×900`; laptop around `1280×720`.
- Phone widths `390` and `360` CSS pixels; one landscape check if supported.
- Browser zoom at `200%`. A `320` CSS-pixel reflow check where practical.
- Keyboard-only: tab order, visible focus, Enter/Space activation, Escape, modal focus containment and focus return.
- Labels, headings, contrast, errors associated with inputs, non-color status cues, target size and table overflow.
- Screen reader, reduced motion and forced colors if tools support them. Otherwise NOT TESTED, not “accessible”.

Look for clipped money values, obscured submit/cancel buttons, scrolling traps, illegible muted text, unlabeled icons,
hover-only actions, mobile navigation blocking content and jump links that scroll but leave focus behind.
Manual checks and automated scans do not by themselves establish WCAG conformance.

### State and recovery

- Distinguish legitimate empty state, loading, permission denial, provider failure and actual zero balance.
- Validate empty/invalid fields without sending emails or mutating shared records.
- Open/cancel forms and revisit them; check stale recipient/value leakage.
- Reload deep links; Back/Forward; sign out and return to a protected route.
- On an idle read-only page only, temporarily disconnect/reconnect your isolated browser if supported.
  Check that the stale/offline condition is honest and recovers. Never interrupt an active money operation on purpose.
- Check that a missing integration offers an honest explanation and a safe next path, not a permanent spinner.

### Measured efficiency

Record initial-load and warm-navigation times, role-switch effort, task completion time, backtracks, excessive
clicking and time spent waiting without feedback. Use the same conditions for retest.
If browser performance tooling is available, collect LCP/CLS and interaction observations with the method stated.
Do not invent INP or a percentile from a single run, and do not label emulated mobile as a real-device measurement.

Known build concerns include a roughly `1.2 MB` main chunk and a roughly `5.67 MB` lazy optional Studio chunk.
Measure actual compressed transfer and user impact; these build sizes are not a performance score.
The core read-only walkthrough should not require the optional editor bundle or a paid license.

## 10. Integration truthfulness checks

| Integration | What the browser auditor can verify / must not infer |
| --- | --- |
| PayPal | App identifies sandbox, distinguishes authorization/capture/payout/invoice states and exposes useful IDs. App-visible success alone is not an independent API/webhook reconciliation. |
| Mistral / AI | Provider attribution, genuine visible output, bounded proposals, human GC decision, and honest fallback labeling. Do not claim every response is live AI if “Offline rules engine” was used. |
| KERNEL / CSLB | License source and timestamp/cache are understandable. Reference used a real cached active lookup; it is not a fresh legal verification for every visit. Do not rerun on the protected reference. |
| AgentMail | Public recovery mail has an allowlist. Historical real delivery/redemption and signed webhooks do not prove a fresh external user's inbox or an RFQ-reply round trip now. |
| Firecrawl | Discovered records show source and unverified status; failure is not represented as successful discovery. A real business's presence in search is not consent to contact it. Read-only mode does not trigger new searches/scrapes. |
| AgentID | Recovery OAuth credentials are not configured; disabled sign-in should explain this and offer ordinary email login. Billing-agent stand-ins are not actual AgentID identity approval. Do not re-register a client. |
| AG Studio | Optional editor/chat requires a legitimate license. Existing trial ends November 20, before December judging. Audit basic React dashboard separately; do not assume an extension exists. |
| APIMatic / Postman | Development usage and collections are source/document evidence, not demonstrated runtime UI integrations. Never claim sponsor certification or execute collection writes against unspecified targets. |

Known limitations are not excuses to hide failures. A provider outage that blocks the claimed core experience still
affects judge readiness; distinguish root cause from user impact and identify who must resolve it.

## 11. Hackathon requirements and judging audit

Official pages reread November 1, 2026:

- [Overview, requirements and criteria](https://paypalaihackathon.devpost.com/)
- [Complete official rules, sections 1–15](https://paypalaihackathon.devpost.com/rules)
- [Resources](https://paypalaihackathon.devpost.com/resources)
- [Schedule](https://paypalaihackathon.devpost.com/details/dates)
- Relevant tool pages: [AG Grid](https://paypalaihackathon.devpost.com/details/aggrid),
  [APIMatic](https://paypalaihackathon.devpost.com/details/apimatic),
  [KERNEL](https://paypalaihackathon.devpost.com/details/kernel),
  [Postman](https://paypalaihackathon.devpost.com/details/postman).

Read official requirements before scoring, but only **after** the blind first-use report. If they changed, record
the change and source. Rules prevail over conflicting promotional copy. This is not an assertion that every linked
SDK document/webinar was reviewed or that legal eligibility is established.

### Mandatory and operational gates

| Requirement | Audit evidence / remaining owner responsibility |
| --- | --- |
| Deadline | November 12, 2026, noon Pacific / 3 pm Eastern. Submission is an owner action, not performed by this audit. |
| Eligibility | Age of majority, eligible jurisdiction, team representative, employment/conflict restrictions and agreements require owner/team attestation. Do not infer eligibility from a working site. |
| Theme / Stage 1 | Nontrivial functioning prototype with **central meaningful PayPal sandbox and AI**, not decorative integrations. Show the causal chain through actual user value. |
| Hosted access / setup | Functional deployed URL or complete reproducible setup, credentials where needed, and free testing. Browser-only testing cannot certify a clean local build. |
| Public open-source entry | Public repository, necessary source/assets/setup and a recognized open-source license visible in GitHub's repository metadata/About area. Check unauthenticated access; match the recovery source, not stale main. Historical check found MIT. |
| Existing project | Significant work during the October 1–November 12 period must be disclosed. Procurement predates the entry; explain the new payments/AI/recovery work rather than claiming a wholly new product. |
| Written submission | English, clear problem/audience/solution, tools and API use, limitations, and material agreement with observed behavior. Draft text is not a submitted entry. |
| Video | Actual running app footage, **under three minutes**, publicly available on YouTube and linked in submission. Local MP4 is not sufficient. |
| Video truthfulness | Final local 2:51 recording is a narrated read-only tour of an already-settled run. It does **not** show a new checkout. Assess whether its storytelling adequately demonstrates E2E; recommend a new capture if needed. |
| Judge access | Keep free access, sandbox/provider resources and stable core experience available through December 15. Judging is December 1–15; a one-day audit cannot guarantee future uptime. |
| Rights / data | Owner verifies source/assets/data/trademark permissions, licenses and privacy, including permitted use of synthetic examples involving real company names. Do not certify legal compliance. |
| Optional sponsors | Claim only real, eligible usage. AG Studio editor availability needs a valid license beyond November 20; a basic grid alone is not evidence of the sponsor page's Studio-agent integration. |
| Submission integrity | Do not invent certifications, approvals, customers, production settlement, paid full contracts, uploads or entries. Rules constrain post-deadline edits; plan the freeze beforehand. |

Recheck final official dates before submission. The schedule and rules differ on the exact winner-announcement time;
that does not change the submission deadline, and conflicting times should not be copied as authoritative.

### Five equally weighted judging criteria

Score each `0–5` for internal triage, with observed evidence and the most valuable improvement. This is not an
official judge prediction or a probability of winning.

| Criterion | Questions |
| --- | --- |
| Technological implementation | Do real AI advice, code-enforced controls, human approval and PayPal settlement form a working chain? Is partial/failure state honest? |
| Design | Is this a coherent, complete-feeling product across roles and mobile, not just a developer harness? Can a first-time user succeed unaided? |
| Potential impact | Is the construction-payment pain credible? Are amounts/time saved supported, or just marketing? Are trust/compliance limits clear? |
| Quality of the idea | Is the AI/payment combination useful and differentiated? What is genuinely agentic rather than a scripted shortcut? |
| Presentation | Is the problem/audience/why clear and the actual product shown E2E within the time limit? Does submission copy match the current build? |

## 12. Required report

Return Markdown with these sections, plus a machine-readable summary if supported:

1. Executive verdict: READY / READY WITH CONDITIONS / NOT READY / INSUFFICIENT COVERAGE.
2. Baseline: time, source/build association, browser, roles, permission rounds and limitations.
3. Blind first-use findings, preserving the uncoached timeline.
4. Task matrix: check ID, role, PASS/FAIL/BLOCKED/NOT TESTED/NOT OBSERVABLE, time and evidence.
5. Fresh-run ledger if assigned, including unknown/failed actions and actual payment identities/totals.
6. Findings ordered by severity and user impact, not screenshot attractiveness.
7. UX improvements separated into must-fix, high-value and polish.
8. Five judging-criterion scores with evidence, no winning guarantee.
9. Submission compliance checklist, owner attestations and license/service availability risks.
10. Exact untested paths and recommended next round. Avoid phrases such as “everything works”.

### Finding template

```text
ID: TPP-UX-001
Title:
Severity: P0 / P1 / P2 / P3
Classification: app defect / UX friction / provider / test environment / unsupported claim
Confidence: reproduced / observed once / suspected
Role, browser, viewport:
App origin and sanitized route:
Run/agreement/pay-app/invoice IDs, if relevant:
Preconditions:
Steps to reproduce, numbered:
Expected:
Actual:
User/business impact:
Evidence filenames and UTC times:
Frequency and whether retry changed persisted state:
Suggested fix, without pretending to know uninspected internals:
Retest steps and acceptance condition:
```

- **P0:** real-money/production exposure, unauthorized data disclosure or action, severe destructive behavior.
  Stop the affected test immediately; report privately to the owner, not publicly.
- **P1:** core assigned journey cannot complete, materially wrong financial state/amount, misleading settlement,
  inaccessible required control or submission requirement failure.
- **P2:** substantial confusion, avoidable detours, weak recovery, broken secondary function or significant mobile issue.
- **P3:** minor copy, alignment and polish that do not obscure meaning or prevent the task.

Keep factual severity separate from whether a fix is easy. An untested path is not automatically a defect.

Optional JSON shape, using real values rather than leaving example findings:

```json
{
  "auditId": "TPP-YYYYMMDD-A",
  "testedAtUtc": "ISO-8601",
  "origin": "https://cheery-axolotl-689.convex.site",
  "sourceCommit": "owner-associated commit or unknown",
  "observedBuild": "asset fingerprint or not observable",
  "roundsAssigned": [0, 1],
  "environment": {"browser": "", "viewport": "", "sessionIsolation": ""},
  "verdict": "INSUFFICIENT COVERAGE",
  "checks": [],
  "findings": [],
  "runs": [],
  "blocked": [],
  "notTested": [],
  "notObservable": [],
  "ownerActions": []
}
```

## 13. Fix, retest and release gates

1. Return the first audit before asking for a rewrite. Reproduce findings on the identified build.
2. Developer triages confirmed defects, unsupported promises and owner/provider actions separately.
3. Fix highest-impact issues with narrow regression tests; preserve reference evidence and unrelated user work.
4. Developer records the fix commit and publishes only to the authorized recovery-dev target.
   A source commit without deployment does not make a hosted defect fixed.
5. Agent retests each finding on the new build using the original steps, then adjacent role/mobile/error cases.
   Record original FAIL → current PASS, or still FAIL/BLOCKED, with new evidence.
6. Run a new blind first-use round with an uncoached reviewer if major navigation/copy changed.
7. Repeat a fresh sandbox E2E only when relevant payment/workflow changes justify it and the owner assigns a new
   one-run budget. Never mutate the preserved baseline to manufacture a retest.
8. Freeze a clearly identified submission build; align demo URL, source, written entry and final video.
9. Recheck public access, credentials, funded services and legitimate license availability before submission and judging.

Suggested release gates:

- Zero open P0/P1 issues in the claimed submission path.
- No undisclosed BLOCKED/NOT TESTED core requirements. Narrow claims honestly if a path cannot be certified.
- Independent three-role read-only verification and representative mobile/keyboard checks.
- A complete, explicitly assigned fresh sandbox run if claiming fresh E2E verification; Owner PAID and successful
  payout items, not only the guided driver's last step.
- Standard-user onboarding and manual workflow reported separately, never “passed” by fixture stand-ins.
- A new user can find access, explain the product and interpret a real receipt without developer coaching.
- Working public source/license, required public YouTube URL under three minutes, accurate submission text and owner
  eligibility/rights attestations.
- A realistic plan for free judge access through December 15 and optional Studio licensing.

Passing these gates improves confidence, not certainty or prize odds. A browser audit cannot certify every backend
authorization path, external webhook, legal obligation, provider retry race or future service availability.

## Supporting documents

- [Judge walkthrough](./judge-guide.md)
- [Submission draft and video handoff](./submission-draft.md)
- [Recovery implementation and historical evidence](./recovery-progress.md)
