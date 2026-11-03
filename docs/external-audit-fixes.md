# November 2 audit fixes and retest handoff

This is a sanitized remediation record, not a reproduction of the private audit.
The raw reviewer files remain local, unchanged and ignored by Git.
The November 3 retest that answers the second private audit is recorded at the end of this document.

## Target and safety boundary

- Branch: `recovery/stabilize-2026-11-01`. No merge, default-branch change or production publication.
- Tested application: https://cheery-axolotl-689.convex.site/
- Frontend publication: `d4a6ad61-31b5-4b17-b286-8468d83d491c`.
- Preserved reference: `A401-DEMO-PAY-20261101-02`, guided run `nx74k1sdcnsmqzvkr97kf0ts598hch6p`.
- The reference project now has a server-enforced read-only flag for normal project-scoped workflow and financial writes. Its financial records were not reset or rewritten.
- Provider webhooks and internal settlement reconciliation remain authoritative. The shared contractor/license record is not an immutable snapshot; the reference UI hides its refresh control. This is not a claim that every shared demo record is frozen.
- Retests used isolated GC, Sub and Owner browser contexts. Ordinary demo authentication was the only remote write during the final browser retest. No new funding, payout, invoice payment, draft, email or provider refresh was submitted.

## Finding-by-finding result

| Finding | Result and verification |
| --- | --- |
| F01: writable settled reference | Protected the existing reference project. Scoped write guards reject workflow/payment changes; UI removes reference continuation, funding, editing, review and invoice-refresh controls. Backend denial tests also verify a fresh, unprotected run still works. See the shared-record limitation above. |
| F02: Owner report looked empty despite paid invoice | Subcontract payouts and Owner change-order income are separate measures. The Owner report now shows the $1,850 paid change order and its history without needing a subcontract agreement. Component tests and the live Owner view pass; Owner ledger access remains denied. |
| F03: contradictory submission identity | One attribution helper prioritizes guided-demo provenance. It explicitly labels human/agent stand-ins, suppresses the driver's non-demo email and does not imply an independent AgentID sign-in. Real AgentID account ownership is distinguished from the construction Owner. Tests cover both paths. |
| F04: submission/source gaps | Corrected the first payment-work commit to `c7986da` and disclosed the earlier Convex-hackathon base and recovery range. README points to the matching recovery branch. Public video upload, Devpost submission, repository About/default-branch decisions and sponsor-access issues still require the owner. |
| F05: malformed run link exposed raw error | URL IDs are normalized as untrusted strings; bad or wrong-table IDs return a missing-record result. Malformed percent encoding is caught. Live invalid bookmarks show the friendly missing state. Unexpected query failures show a generic retry message rather than raw internals. |
| F06: default demo selected unfinished latest run | With no explicit selection, the demo prefers the preserved reference belonging to the demo GC. Explicit run selections still work. Live default-reference check passes. A bare URL can remain bare during an already-mounted navigation; it is not proof that every navigation rewrites the URL to a pinned run. |
| F07: missing payment identifiers | Ledger shows copyable order, authorization, capture, payout batch/item and retainage receipt IDs. Capture IDs are correctly joined from authorization capture history to release payments. Backend regression and live receipt checks pass. IDs are business receipts, not credentials. |
| F08: inbox difficult to locate/filter | Added agreement, project, company, period and pay-app-ID search, status filter and direct pay-app/ledger links. Search explicitly covers loaded records only: up to 60 recent applications across up to 200 agreements. Live filtering of the two reference applications passes. |
| F09: horizontal/mobile overflow | Responsive shell/menu, wrapping receipt IDs, review amounts and agreement terms, and bounded keyboard-focusable table regions. Positioning table scroll regions also prevents hidden headers from widening the document. Final tests cover 320, 360, 390, 768 and 1440 CSS pixels on the listed routes, not every legacy page or real device. |
| F10: thin Owner change-order details | Added party-authorized detail links, associated agreement label, scope/amount/status, schedule impact, UTC lifecycle dates and invoice receipt. The app's first observation of payment is explicitly not represented as PayPal's transaction timestamp. No unauthorized subcontract ledger link is added. Live Owner detail check passes. |
| F11: Sub could not explain reduction | Pay-app history shows submission, review and GC decision timestamps, requested versus approved gross, reduction and the recorded GC explanation. Legacy approval history is reconstructed from stored records. Missing explanations are stated as missing; AI review reasons are not relabeled as GC-authored. Live $13,500 request versus $288 approval check passes. |
| F12: excluded $4,500 unclear | Ledger presents the bid's excluded-scope estimate separately and explicitly outside the awarded contract/SOV. Live reference check passes. It is an estimate, not a billed amount or payment. |
| F13: notification `[hidden]` placeholders | Sanitization preserves narrowly recognized generated business references while retaining secret/email redaction. Older irreversible redactions display understandable omitted-reference text without reconstructing private values. Secret-protection tests and live notification-placeholder check pass. |
| F14: sign-in lacked safe-demo context | Sign-in explains the product, shared synthetic demo data and PayPal sandbox/no-real-money boundary, with a demo-guide link. Signed-in demo workspaces repeat the warning. This does not enable arbitrary-email signup or bypass the existing allowlist. |
| F15: navigation labels/priority | GC starts in Approval inbox, with Payments prominent; report/summary labels and Owner application labels are clearer. Procurement query deep links still resolve to procurement. Navigation regression tests pass. |
| F16: opening a draft immediately persisted it | New pay app first opens a confirmation with application/period and explicit no-submit/no-money effect. Cancel creates no record. Added a separately confirmed, sub-authorized discard for eligible never-submitted initial drafts without review/payment/proposal history, with an audit event. Backend authorization/state tests and live preview/cancel pass. The audit's accidental $0 draft on `A401-DEMO-PAY-20261101-03` was not deleted automatically. |
| F17: ambiguous funded/captured measures | Replaced the aggregate label with Remaining authorization and explained authorized, captured, awaiting payout, retainage and separate Owner income. Live definitions and unchanged reference totals pass. No claim that the $55,000 subcontract is fully paid. |

Additional accessibility changes include a functional skip link, visible focus, mobile Escape/focus return, larger controls, main headings on tested screens and improved funding-hint contrast. This is not WCAG certification or a complete screen-reader/contrast audit. Seed/demo provenance labels remain explicit. AgentID recovery approval remains an owner dependency, not a simulated success.

## Validation

- `npm test -- --maxWorkers=4 --reporter=json --outputFile=evidence/audit-fixes-regression.json`: **1,965 passed, 0 failed**. Expired bid-deadline fixtures were made relative to the test date; explicit past-deadline rejection tests remain.
- `npm run build`: passes, including TypeScript. Existing large-bundle and mixed static/dynamic SOV import warnings remain.
- `npm run verify:guards`: **258 public, 200 internal functions; 0 guard problems, 0 missing tenancy guards**. This is a static guard check, not a whole-application security certification.
- `npm run verify:docs`: relative links and build-log order pass. Private reviewer files are intentionally outside the public-doc scan.
- `node scripts/qa/audit-fixes-browser.mjs`: **97 checks passed, 0 unexpected page/console errors**. Recovery-dev-only, fresh isolated browser contexts and masked screenshot emails. Covers reference receipts/controls/totals, inbox filtering, menu/skip behavior, Sub reduction history, Owner income/detail/isolation, bad bookmarks and draft preview/cancel. An expected Owner ledger-denial console event is recorded separately from unexpected errors. Final local report: `evidence/audit-fixes-browser-2026-11-02T06-05-11-716Z/report.json`.
- Responsive route scope: GC ledger, inbox, Payments, agreement, SOV, project summaries, billing agents and notifications; Sub portal, pay-app list and pay-app detail; Owner reports and change-order detail. Each has exactly one main heading and no document overflow at the five tested widths.

Local evidence is under ignored `evidence/`; do not upload raw browser profiles, auth material or the private audit. The browser harness is reproducible and refuses alternate deployment arguments. These retests do **not** establish a fresh live end-to-end payment, real-device/screen-reader coverage, provider certification, legal compliance or recovery of the old cloud-only waiver implementation.

The preserved reference remains partial progress: $55,000 contract, $2,288 captured and paid including $228.80 released retainage, $3,212 remaining authorization, $0 currently held retainage, $1,850 paid Owner change order recorded separately, and $52,712 subcontract balance. Earlier independent PayPal checks remain historical evidence, not a new provider reconciliation in this retest.

## Retest instructions

1. Open the [demo guide](https://cheery-axolotl-689.convex.site/#/demo) in fresh isolated contexts for GC, Sub and Owner. Use ordinary demo sign-in.
2. Inspect the [preserved run](https://cheery-axolotl-689.convex.site/#/judge-demo/nx74k1sdcnsmqzvkr97kf0ts598hch6p) and [ledger](https://cheery-axolotl-689.convex.site/#/payments/jn78x0j5xeh7q9gb55p26r7pdh8hdmjx). Do not try to remove its lock.
3. Repeat F02–F17 as read-only checks. Opening and cancelling the draft preview is safe; do not confirm creation or discard shared records without authorization.
4. Fresh financial testing is a separate, explicitly authorized round on a **new** guided run, never the preserved reference. Do not approve the reference's pending reschedule proposal.

## Owner actions before submission

- Review/publish the desired recovery branch and repository About/default-branch presentation. No merge/default-branch change was performed here.
- Upload an actual-app video shorter than three minutes to public YouTube and complete Devpost. Neither was performed. The existing local film predates these UI changes and needs owner review before upload.
- Obtain legitimate AG Studio access covering the December 1–15 judging period, or remove unsupported licensed-view claims. The recorded trial end is November 20.
- Obtain approved AgentID OAuth client registration for recovery if that independent sign-in is part of the submitted claim. Demo stand-ins do not prove it.
- Maintain free, working judge access through December 15. Keep provider credits and demo email restrictions clear. Do not claim submission readiness, license approval or full settlement from the passing tests alone.

## November 3 second-audit retest (V2)

A second private audit (November 2) was reviewed and answered on the same recovery branch. Its report, screenshots and scripts remain local, unmodified and ignored by Git. No new funding, payout, invoice payment, draft, email, provider refresh or AgentID sign-in was performed; the only remote writes were demo sign-ins and running the fixture-protection operator step described below.

### Shared-demo protection and guided consent

- New optional flags only: `companies.demoReadOnly`, `projects.readOnlyDemoFixture` and `projects.demoSandbox`. The schema push changed no existing field.
- An internal, recovery-dev-only operator mutation marked **5 seeded demo companies and 5 existing demo projects** read-only after the deploy. It is idempotent, never resets records and skips explicitly created `demoSandbox` projects. The preserved reference keeps its original read-only flag and its financial records were not rewritten.
- Company profile/defaults/member/invite, vendor, payee, billing-agent-link and guide-demo writes now require a writable company; reference and fixture projects keep their existing write guards. A stale invite into the shared demo company is refused rather than changing its people.
- The guided run opens a detailed consent dialog before any write: new $55,000 synthetic subcontract, $5,500 PayPal sandbox authorization with checkout approval, $1,850 invoice to the demo Owner, Mistral/KERNEL/PayPal credit use, up to 3 new runs per account per hour, and "Cancel creates nothing". The limit is enforced server-side per account.
- The shared demo UI hides add/revoke/invite/edit/import/remove controls for the seeded fixtures, masks non-demo inbox addresses and explains that a fresh guided run is the writable path.

### Reporting, privacy and quiet reads

- Mobile: the billing-agent table is a keyboard-focusable scroll region, the demo tour bar wraps instead of overflowing at 320 px, and data-table links carry an underline as a non-color cue.
- Owner reports omit subcontract measures instead of printing false zeros, and Owner change orders open on a project that has prime change orders rather than the newest empty project. Prime labels stay PCO.
- Drafts distinguish "created" from "submitted" in the Sub portal; a paid Owner CO is labeled as project Owner prime income, never as a subcontract payout.
- Notifications state the net amount requested after retainage. A historical orphan reference suffix is tidied at display time; no stored financial figure is altered.
- Payment and ledger screens state that statuses are recorded from PayPal API responses and webhooks at the time shown, not read live. Payout batch IDs are copyable, retainage wording distinguishes held from released, and a demo release explicitly does not certify project closeout.
- `formatDateTime` defaults to explicitly labeled UTC, so a local time is never presented as UTC.
- Missing or forbidden detail reads return a blank answer instead of logging Convex errors (`getPayApp`, `getChangeOrder`, `getSov`, ledger, agreement summary) while keeping the same authorization and company scope.
- The license panel explains that a California registry result is advisory context on a Texas demo project, not proof of Texas permission.
- Owner funding rows use a coarse funding state instead of exposing a payout stage.
- Accessibility: darker emerald action color for white text, table link underlines, a top-level procurement heading, and focus return to main content after the mobile menu closes.

### Validation

- `npx vitest run`: **1,970 passed, 0 failed, 146 files**. This includes a new regression file covering fixture protection, demo settings and invite denial, the per-account guided limit, inbox masking and historical notification cleanup.
- `npm run build`: passes, with the same existing large-bundle warnings as V1.
- `npm run verify:guards`: **258 public, 201 internal functions; 0 problems**.
- `npm run verify:docs`: 65 relative links and 28 ordered log entries pass.
- `node scripts/qa/audit-v2-browser.mjs`: **83 checks passed, 0 unexpected console or page errors**, at 320, 360, 390, 768 and 1440 CSS pixels on billing agents, vendors, company settings, people, procurement, the guided demo, inbox, the reference ledger, Owner reports/change orders and the Sub portal. The consent dialog was opened and cancelled; no run was created and the reference totals were re-checked unchanged. Report: `evidence/audit-v2-browser-2026-11-03T09-45-35-158Z/report.json`.
- Recovery-dev backend deployed with typecheck; the served static bundle is `index-BPO2JXhv.js` at https://cheery-axolotl-689.convex.site/. Production (`earnest-mongoose-745`) and `main` (`fb5e4168c984de4e7e6e5d9fe39a14261182f890`, local and remote) were not touched.

### Limits of this retest

- The per-account hour limit is enforced for the protected shared demo company; it is not a claim about every future sandbox company.
- Fixture protection is an operator step after each deploy to a shared demo, not a nightly reset. It preserves existing records.
- Copy buttons and receipt IDs are convenience and business identifiers, not credentials.
- No fresh financial round, real-device or screen-reader pass, WCAG certification, provider certification or independent AgentID success is claimed.
- The Owner-only blockers above (public video, Devpost submission, AG Studio license for judging, AgentID OAuth approval) remain open.
