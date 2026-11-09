# Recovery status

## Environments and source

- Source branch: `main` since 6 November 2026. The work was developed on `recovery/stabilize-2026-11-01` (based on GitHub `main` at `fb5e416`) and fast-forwarded onto `main`; the recovery branch is frozen at that handoff commit (`e4682a7`) as a backup.
- Isolated recovery dev backend and mirror: **https://cheery-axolotl-689.convex.site**.
- Canonical frontend: **https://tradepulse-pay.asynchronope.tech** (Cloudflare Pages project
  `tradepulse-pay`, CNAME to `tradepulse-pay.pages.dev`, same build). `CONVEX_SITE_URL` and
  the protected reference check are unchanged.
- Original production: `earnest-mongoose-745`, unchanged.
- Original development: `exuberant-boar-323`, preserved.
- Frozen legacy deployment: `brainy-skunk-440`, never modify.

The original development deployment contains newer waiver functions and a `lienWaivers` table not present in GitHub. Its agreement and document validators also differ. An attempted push correctly failed schema validation before activation. No records were deleted, validation was not disabled, and the older checkout was not forced over the cloud-only feature.

The managed cloud workspace is unavailable. GitHub is the recoverable source baseline; deployed schema metadata is not a substitute for the missing source. Do not redeploy over the original development environment without a deliberate recovery or migration plan.

## Canonical frontend acceptance, 3 November 2026

- The proxied CNAME `tradepulse-pay` → `tradepulse-pay.pages.dev` is live, the Cloudflare Pages certificate is active, and **https://tradepulse-pay.asynchronope.tech** serves the recovery build.
- The three-origin read-only acceptance passed **53/53 checks** at commit `2ad24ff82c00a8eb62b324b1938f169e8865a71c` on the canonical domain, `tradepulse-pay.pages.dev` and `cheery-axolotl-689.convex.site`. Evidence: `evidence/dual-host-browser-2026-11-03T23-54-12-496Z/report.json`.
- All three origins served the same commit. The demo guide and build stamp rendered; GC, subcontractor and owner sign-ins worked in fresh contexts; the pinned read-only run `A401-DEMO-PAY-20261101-02` loaded; reports and the $55,000 agreement ledger loaded; seeded archive files downloaded through the Convex site with `Access-Control-Allow-Origin: *`; no console or CORS errors were recorded.
- Backend functions, webhooks, `/api/health`, the Convex Auth issuer and the AgentID callback remain on `cheery-axolotl-689.convex.site`. `CONVEX_SITE_URL` is unchanged; `SITE_URL` is the canonical domain.
- Final regression after these changes: **1,982 tests across 149 files**, `tsc -b` clean, guard audit 258 public / 201 internal / 0 problems, and 65 relative documentation links resolve.
- The acceptance performed no guided run, PayPal popup, financial write or reference-run mutation.

## Pay-app review eval, 5 November 2026

- The review suite now has **24 fixtures** covering honest, overbilled, excluded, front-loaded and
  out-of-sequence verdicts, their precedence, stored materials, missing funding tranches, review
  flags, zero progress, prior baselines and a prompt-injection note.
- Live Mistral `mistral-large-4` run `eval_payapp_1793864125712` scored **24/24 cases, 71 lines and
  15 issue lines** on fixtures whose expected verdicts were written alongside the rules. That is a
  regression result (agreement with this app's rules), not an accuracy estimate; see
  [pay-app-review-eval.md](./pay-app-review-eval.md). All fixtures reported Mistral, not the offline
  fallback.
- The run is recorded in `evalRuns.reviewMetrics` with per-verdict TP/FP/FN counts. Scorecard:
  `evals/results/pay-app-review-scorecard.md`; JSON:
  `evals/results/pay-app-review-scorecard-2026-11-05T07-39-28-584Z.json`.
- The pinned command is `npm.cmd run eval:payapps`; it refuses any deployment other than
  `dev:cheery-axolotl-689`. See [pay-app-review-eval.md](./pay-app-review-eval.md).
- Full regression after the change: **2,034 tests across 153 files** passed; guard audit 262 public /
  201 internal / 0 problems; 90 documentation links resolve.
- No PayPal call, guided run or financial write was made by this eval.

## Pay-app question thread, 5 November 2026

- The sub can now **Question this amount** on a submitted pay app and the GC can reply. The thread
  stores its entries in `payAppThreadEntries`, not on the pay application, so the G702/G703,
  approval, ledger and PayPal state are untouched.
- Drafts stay private to the filing sub; the Owner and other companies get `Not found.` Billing
  agents and preserved read-only demo runs can read but not post. Archived projects and withdrawn
  pay apps are read-only.
- Each post writes `pay_app_question` or `pay_app_reply` to the audit log and sends an in-app
  notification to every active human member of the other company. The notification links back to
  `#/pay-apps/<id>`.
- `convex/payApps/questions.test.ts` passed **7/7 tests**, including the no-financial-write check,
  draft visibility, role refusals, agent read-only behaviour, body validation and in-app
  notification recipients.
- Browser acceptance `scripts/qa/pay-app-thread-browser.mjs` passed **21/21 checks** on canonical
  build `0ba5d11`: sub question, GC reply, both views, an unchanged money trail, and a read-only
  reference pay app with no composer. Evidence:
  `evidence/pay-app-thread-browser-2026-11-05T08-14-04-182Z/report.json`.
- The run wrote two synthetic thread entries to R6-A dev run `nx7c971zm1xkfbaccs0wdtqae58hm175`; it
  made no PayPal call, financial write or guided run, and did not mutate the preserved reference.
- Full regression after the change: **2,041 tests across 154 files** passed; guard audit 264 public /
  201 internal / 0 problems; 92 documentation links resolve. See
  [pay-app-questions.md](./pay-app-questions.md).

## Owner job-so-far card, 5 November 2026

- The Owner home now shows a read-only **Job so far** card for projects with meaningful prime activity:
  percent complete, contract to date, completed and stored, paid to date, retainage held, balance to
  finish and change orders. It names whether the progress basis is approved or still awaiting the
  Owner's review.
- Paid to date separates paid owner pay apps from paid prime change orders, so a direct invoice such
  as the R6-A $1,850 change order is not presented as a pay-app payment.
- The summary is computed only for the Owner in `portal.ownerOverview`; a GC receives `ownerJob: null`.
  Projects with no prime value or activity return null, so the card is not repeated as empty chrome on
  every legacy project.
- Focused tests: **4/4** in `convex/ownerJob.test.ts` and **2/2** in
  `src/payments/OwnerPortal.test.tsx`. Browser acceptance `scripts/qa/owner-job-browser.mjs` passed
  **18/18 checks** on canonical build `57fcd50`: Owner progress bar and six summary labels, explicit
  paid-to-date sources, no controls, and no card in the GC summary. Evidence:
  `evidence/owner-job-browser-2026-11-05T09-00-58-465Z/report.json`.
- The browser run made no write, payment, PayPal call or guided run. See
  [owner-job-so-far.md](./owner-job-so-far.md).

## Residential landing, nav and inbox focus, 5 November 2026

- The public `#/demo` landing now leads with residential remodel GCs: catching overbilling, deciding
  with the evidence, and keeping a clean owner or lender trail. The judge checklist and sandbox test
  card remain available behind collapsed disclosures, so they no longer dominate the first screen.
- The GC primary bar is five daily areas — Approvals, Billing, Projects, Change orders, Payments — plus
  Guided demo for the demo company. Procurement, compliance, project summaries, people, vendors,
  billing agents and payment reports moved under More. Sub and Owner nav are unchanged.
- The approval inbox now groups entries into Needs your attention, Approved · awaiting payment, and
  collapsed History. Filters still search all loaded entries, and the history section opens itself
  when the filter leaves no open work.
- Focused tests: **26/26**. Full regression on the deployed build: **2,052 tests across 157 files**,
  build clean, guard audit **264 public / 201 internal / 0 problems**.
- Read-only browser acceptance `scripts/qa/landing-nav-inbox-browser.mjs`: **41/41 checks** on
  canonical build `517be73`, including the six-item primary bar, all seven More links, the inbox
  buckets, R6-A filtering and a 390px phone layout. Existing Owner-card acceptance stayed **18/18**,
  and the three-role smoke passed with no failures. The three-host acceptance passed **53/53 checks**
  with all hosts serving commit `517be73a93963e836ca11a3befa91da3c23873fb`. Evidence:
  `evidence/landing-nav-inbox-browser-2026-11-05T09-22-03-912Z/report.json` and
  `evidence/dual-host-browser-2026-11-05T09-25-28-884Z/report.json`.
- No approval, payment, PayPal call, guided run or reference-run mutation was made. See
  [landing-navigation-inbox.md](./landing-navigation-inbox.md).

## Verified recovery baseline

- Final judge-access regression: **1,957 tests passed across 144 files** (`evidence/recovery-judge-final-regression.json`), plus **eight Node safety/integration helper tests**. The earlier recovery checkpoint was 1,950 tests across 142 files.
- Frontend provenance/diagnostics follow-up: **42 focused tests passed**, followed by a successful build, guard audit and documentation checks.
- Production build and TypeScript checks passed.
- Guard audit: no reported missing tenancy guards.
- Documentation checks passed; seven historical audit reports rendered offline.
- Isolated backend deployed with schema validation enabled; frontend uploaded separately.
- GC, subcontractor and owner demo logins passed; nine read-only routes loaded without browser errors after the final backend deployment (`evidence/recovery-cheery-axolotl-689.convex.site-2026-11-01T17-42-20-179Z/report.json`). Unconfigured AgentID was disabled with its explanation and email fallback visible.
- Account-creation and password-reset forms open on the recovery build.
- PayPal sandbox token acquisition and a $1 AUTHORIZE order creation/read passed through SDK and REST. The order remained `CREATED`: it was not approved, authorized, captured or paid.

The initial $1 order was not settlement evidence. The subsequent settled sandbox run is documented below. Old audit reports remain historical evidence, not current functional certification.

## Mistral setup

In the recovery deployment's Convex dashboard, open **Settings → Environment Variables** and set:

| Name | Value |
| --- | --- |
| `AI_PROVIDER` | `mistral` |
| `MISTRAL_API_KEY` | Your funded Mistral API key, server only |
| `MISTRAL_MODEL` | `mistral-large-4` (current recovery setting), or another available tool-capable model |

Never put a model API key in a `VITE_` variable, Git, screenshots, or chat. Save it directly in Convex. A Mistral chat subscription is not proof of API access. Modal is not required for the direct API route.

The existing Anthropic model was available, but inference returned insufficient API credits. Four successful deterministic fixture scores were explicitly labelled **Offline rules engine**, not successful AI calls. The recovery work adds Mistral rather than concealing that failure or spending with another provider silently.

Mistral's current model docs deprecate Medium 3.5 and recommend Large 4 for new integrations. Large 4 is public preview. Confirm the configured model is available to the account before relying on it for a demo.

## Live Mistral verification

- Direct account/model checks and real inference succeeded on recovery dev.
- Before the reasoning-budget fix, review fixture runs `eval_payapp_1793540987597` and `eval_payapp_1793541729486` each passed all four correctness checks, but each had **three Mistral results and one explicitly offline fallback**. Different cases fell back. A 100% correctness score is not proof that every case used AI.
- Diagnosis reproduced HTTP 200 with a `length` finish: 4,000 output tokens, 3,999 spent on reasoning, followed by `AI_NoOutputGeneratedError`. This was output-budget exhaustion, not a connection failure.
- Explicit Large 4 model requests now send native `reasoning_effort: "low"`, which the pinned SDK adapter otherwise omits. Large 4 does not accept `none`. Review/procurement calls have bounded 8,192-token headroom; other models keep their previous review limits. Truncation is detected before accessing structured output and receives an accurate offline reason. See [Mistral reasoning controls](https://docs.mistral.ai/studio/conversations/reasoning).
- After deployment, **all four fixtures used real Mistral and passed**, with no offline cases: `eval_payapp_1793546692115`, model `mistral-large-4`, score 100%. A successful run is not a guarantee against future provider failures; the honest fallback remains.
- A real SUB1 browser submission on `A401-DEMO-PAYREVIEW-MISTRAL1` claimed $30,000 of rough-in work. Mistral reviewed it as OK with a $30,000 recommendation.
- The pay agent used **Mistral / `mistral-large-4`** and called `checkLicense`, `proposeCapture` and `proposePayout`. The live KERNEL CSLB check returned active, without a cached result or override.
- Capture and payout proposals remained **pending**: $30,000 gross, $3,000 retainage and $27,000 net. Missing lien waiver and unfunded milestone flags remained visible. No GC approval, funding, capture or payout was performed.
- The GC payment panel also blocked on missing COI, W-9 and contractor-license documents. A live CSLB check does not replace those compliance files.
- Browser evidence: `evidence/recovery-ai-2026-11-01T14-05-39-023Z/report.json`. Screenshots mask email addresses.

The browser test exposed three Anthropic-only UI branches that falsely labelled Mistral as offline. The hosted frontend now recognizes Mistral review/agent provenance. Diagnostics also distinguishes configured keys from verified live inference. Read-only reinspection passed with all three Mistral labels correct and proposals still pending (`evidence/recovery-ai-2026-11-01T14-31-54-836Z/report.json`). All three demo roles and nine routes passed again without browser errors (`evidence/recovery-cheery-axolotl-689.convex.site-2026-11-01T14-33-24-446Z/report.json`).

The final authenticated provider smoke passed live procurement inference and the streaming proxy (`evidence/recovery-provider-2026-11-01T15-37-43-514Z/report.json`). Procurement uses native Mistral HTTP, handles reasoning/text chunks without exposing private reasoning, and retains task sanitizers. The proxy returned a real `readSandboxStatus` function call with token usage. That test did not execute the tool or certify the licensed Studio UI. Its temporary demo session was revoked.

## Recovery integration and demo follow-up

- Separate recovery PayPal sandbox webhook `24481791EX8761338` is registered at `/paypal/webhook` for the 14 events handled by the app. Its deployment setting was read-back verified. Existing registrations were preserved.
- Separate AgentMail webhook `ep_3LVo8QcwoP3zBl5cuFIsSFMgAaY` is registered at `/agentmail/webhook` for exactly the two app inboxes and five handled events, without a pod/catchall subscription. The signing secret was verified in memory, and the endpoint reports signature verification enforced. No emails or inbox changes were made during setup.
- `scripts/qa/recovery-integrations.mjs` defaults to inspection. Its explicit `--apply` mode is fixed to recovery dev and PayPal sandbox, matches registrations by exact URL, preserves existing registrations and writes only the two webhook settings. Three focused helper tests passed.
- AgentID's official registration flow requires organization-owner approval in the browser. Recovery client credentials remain unset; old clients were not copied. Create a new Other/custom integration in [the AgentID console](https://console.agentid.com/) with callback `https://cheery-axolotl-689.convex.site/api/auth/callback/agentid` and `client_secret_basic`, then set its new `AUTH_AGENTID_ID` and `AUTH_AGENTID_SECRET` directly on recovery dev. See [official automation guidance](https://www.agentid.com/docs/cli#automation). Never send those credentials in chat.
- Sign-in now checks a public, credential-free configuration boolean and disables AgentID with an explicit explanation when it is unavailable. Configuration presence is not certification of a valid callback. Eleven focused capability/API tests passed.
- Fresh guided-demo projects now receive only their own marked demo compliance fixtures. Guards require the actual Demo GC/sub companies, matching demo keys, active project membership and consistent vendor ownership. Real companies do not receive those records. Existing records and historical projects are not backfilled by starting a run. Forty-nine focused compliance/run tests passed.
- The guided demo now names the configured AI provider rather than hardcoding Anthropic, and explains that compliance and conditional-waiver flags are demo fixtures, not uploaded legal documents.
- At this checkpoint, **1,941 tests passed across 142 files**, the build/typecheck passed, and backend/frontend were published only to recovery dev. The subsequent award-consistency correction requires its own validation.
- The first fresh checkout exposed an outdated demo award: it included a $4,500 leveling plug in the contract while regular billing correctly omitted excluded SOV lines. `A401-DEMO-PAY-20261101-01` remains unapproved and unfunded, with zero capture/payout. It is preserved as diagnostic evidence, not reused for funding.

## Settled sandbox run, 1 November 2026

`A401-DEMO-PAY-20261101-02` uses the normal award calculation: **$55,000** of base scope, four SOV lines summing to that award, and explicit excluded-scope notes. The $4,500 seismic-bracing plug is comparison-only, not extra payable scope.

- Real guest approval authorized **$5,500** on sandbox order `0WV193651L210315U`, authorization `94G95136J6812154U`.
- The honest $2,000 pay app received a real Mistral Large 4 review and agent trace. Its capture `4HL52442UH4760109` is `COMPLETED`; payout batch `7VG6NTD87W2JJ` is `SUCCESS` for **$1,800**, with $200 retainage.
- The overbilled $13,500 claim received a rules-review recommendation of **$320**, explained by Mistral. The authenticated guided-demo GC action edited it to **$288** before approval. Capture `9X249756PN047684B` is `COMPLETED`; payout batch `RFQ4YLNXPXL8S` is `SUCCESS` for **$259.20**, with $28.80 retainage. Its reschedule proposal remains pending, not silently approved.
- The Owner signed in separately, opened its own app invoice link and paid the **$1,850** PayPal invoice `INV2-34SZ-2MQV-HYR9-TCRG` with synthetic guest details and the public test card. PayPal confirmed `PAID`; the Owner row updated. Evidence: `evidence/recovery-settlement-2026-11-01T17-27-07-740Z/report.json`.
- The GC explicitly used optional **Release retainage**. Batch `SUQPHFZK3KLSG` settled `SUCCESS` for **$228.80**; no separate top-up was needed after the Owner invoice payment. Evidence: `evidence/recovery-settlement-2026-11-01T17-39-45-168Z/report.json`.
- Independent PayPal GETs matched **all seven** stored authorization/capture/payout/invoice records. The independent ledger recomputation had no mismatches or attention items: `evidence/recovery-paypal-2026-11-01T17-41-24-718Z/report.json`.
- Eight matching PayPal authorization, capture and payout webhook records were signature-verified and processed. This proves actual delivery processing, not just registration. It does not certify every subscribed event type; Owner invoice payment was independently verified by PayPal GET.
- Replaying the Owner-payment and retainage paths detected their settled state, opened no duplicate checkout and submitted no second payout. Totals stayed unchanged: `evidence/recovery-settlement-2026-11-01T17-46-43-587Z/report.json`.

Earlier Owner checkout attempts stopped on synthetic-field validation or browser-input errors and did not settle payment. Explicitly clearing prefilled inputs and checking synthetic values fixed the harness. Only the subsequent PayPal-confirmed receipt is counted as paid.

| Final agreement ledger | Amount |
| --- | ---: |
| Contract sum | $55,000.00 |
| Approved / captured | $2,288.00 |
| Captured but not paid | $0.00 |
| Paid to sub, including retainage release | $2,288.00 |
| Retainage held / released | $0.00 / $228.80 |
| Owner change orders invoiced / paid | $0.00 / $1,850.00 |
| Uncaptured authorization remainder | $3,212.00 |
| Contract balance | $52,712.00 |

Dashboard and ledger match. The contract balance remains $55,000 − $2,288; this is partial progress, **not** completion or full payment of the contract. Owner prime-change-order revenue is separate from the subcontract sum. No production money moved.

The current run reused the previous genuine, cached CSLB result; it was not a fresh license lookup. Fileless demo compliance records and the honest pay app's conditional-waiver flag are explicitly labelled fixtures, not legal documents or real compliance certification.

The final ledger fix counts only confirmed `COMPLETED` captures as collected cash. Pending, denied, refunded, partially refunded and unknown statuses are excluded, while consumed authorization capacity remains separate. Eight status cases and pending → completed/denied lifecycle assertions passed. Independent reconciliation applies the same positive status requirement without sharing the sum implementation.

## Remaining integration work

- Complete the owner-approved AgentID registration if billing-agent sign-in is needed.
- Actual AgentMail verification mail, signed inbound delivery and delivery-status processing are now verified below. A complete RFQ-reply-to-bid journey is not certified by that auth-mail test.
- Keep compliance and license gates intact. An unavailable check is not a verified license.
- The recovery dashboard has an ordinary React ledger view and does not need an AG Studio license. Studio layout/chat still needs valid licensing.
- Build warnings remain for large frontend chunks. The successful build is not a performance certification.
- Recovery `SITE_URL` is the hosted recovery origin. Do not change a shared deployment's auth origin merely to test another browser origin.

## Judge and real-user follow-up, 1 November 2026

- Public `#/demo` now exposes three ordinary password role controls and a truthful walkthrough. It preserves an
  existing signed-in identity. Mobile overflow and desktop views were checked.
- Judge runs have explicit bookmarks and bounded recent history. The driver pins its own expected run while waiting;
  an agreement-scoped approval query does not lose an older run behind the shared global inbox cap.
- Two fresh GC browser contexts verified independent runs and the first judge's reload/bookmark stability:
  **13 checks passed**, `evidence/recovery-user-journey-2026-11-01T19-22-35-246Z/report.json`.
  The second judge created one executed but **unfunded** agreement; no checkout, capture, payout or invoice was submitted.
  Earlier concurrency attempts failed because the harness read a loading element before it existed.
  Waiting for the agreement fixed that harness race; the app did not need an authentication or payment bypass.
- The invitation dialog replaces the recipient when selecting a different vendor and clears it for a new vendor.
  Browser checks did not submit an invite. Manual package deadlines use local calendar dates two weeks ahead.
- A genuinely new account in an already-owned allowlisted inbox received and redeemed its actual eight-digit email code,
  created a separate GC company and project, and added a package: **21 checks passed**,
  `evidence/recovery-user-journey-2026-11-01T18-17-42-035Z/report.json`.
  The signed inbound webhook received the message without assigning an unmatched auth message to any tenant;
  the outbound row was sent with a delivered event. Codes, passwords, API keys and message bodies were not exported.
  Recovery's recipient allowlist and daily budget remain intact. This is not arbitrary-email public signup.
- Firecrawl returned **26,012 characters of live scraped content** and one usable source-linked contractor on a bounded
  discovery search: `evidence/recovery-firecrawl-2026-11-01T18-50-21-791Z/report.json`.
  Its SEO title previously caused premature rejection before brand extraction. The parser fix keeps government,
  directory and unrelated-domain exclusions. One unverified demo contractor was inserted; no RFQ or outside email was sent.
  Manual contractor entry also no longer fabricates verified licensing or a registry URL.
- Latest backend query return validators passed Convex typechecking and deployment schema validation.
  A subsequent three-role/concurrency browser run exercised those queries successfully.
- Read-only reinspection preserved the independently settled agreement's totals:
  `evidence/recovery-settlement-2026-11-01T19-17-22-276Z/report.json`.
  The ledger/dashboard still matched, both progress payouts were settled, and paid plus retainage reconciled.
- A **171.05-second actual-app recording** was generated with offline synthetic narration and chapter captions.
  It is an inspection of previously settled receipts, not a recording of new payments. No YouTube upload or
  Devpost submission has been performed. Final media:
  `evidence/submission-film-2026-11-01T19-41-30-725Z/TradePulse-Pay-demo.mp4`.
  See [the publishing handoff](./submission-draft.md).
- Stable focused validation passed **54 tests across six files** and TypeScript. The first full follow-up run
  overlapped an export edit and recorded 1,956/1,957; its one mapper failure passed on the stable rerun.
  Subsequent attempts did not produce a final report within the execution window and are not counted as passes.
  The final stable-source run completed in 490.84 seconds with **all 1,957 tests across 144 files passing**.
- Final TypeScript/build, documentation checks and the guard audit passed: **256 public functions,
  199 internal, zero reported tenancy-guard problems**. The eight Node helper tests passed again.
  The build retains large-chunk and mixed static/dynamic-import warnings.
- The exact frontend was uploaded only to recovery dev as deployment
  `635d0934-2b12-49c6-bb12-69037b3673ba`. Post-upload public health and all three role logins/nine
  routes passed without browser errors:
  `evidence/recovery-cheery-axolotl-689.convex.site-2026-11-01T19-40-36-679Z/report.json`.
  The final public-guide journey passed **12 checks**, including the mobile jump's scrolling/keyboard focus,
  identity protection, bookmarks and invitation-recipient correction:
  `evidence/recovery-user-journey-2026-11-01T19-46-17-505Z/report.json`.

## Historical recovery-era checks

These checks were written for the isolated recovery dev deployment and the pre-residential commercial
flow. They are kept as a record, not as this release's gate: the release gate is the command set in
`AGENTS.md` / `services.yaml`, and the residential reference evidence lives under `docs/evidence/`.
`recovery-user-journey.mjs` still drives the pre-residential flow and is **not** part of this release
gate. Run from the repository root:

```powershell
npm test -- --maxWorkers=2
npm run build
npm run verify:guards
npm run verify:docs
npm run verify:reports
node scripts/qa/recovery-smoke.mjs --url https://cheery-axolotl-689.convex.site/ --demo-login
node scripts/qa/recovery-ai-smoke.mjs
node scripts/qa/recovery-provider-smoke.mjs
node scripts/qa/recovery-integrations.mjs
node scripts/qa/recovery-settlement-smoke.mjs
node scripts/qa/recovery-user-journey.mjs
node scripts/qa/recovery-firecrawl-smoke.mjs
```

The browser smoke scripts use the public demo accounts only and create fresh browser contexts. Their
default modes do not perform business writes. They target the isolated recovery dev host named in each
command; do not point them at a production deployment, and do not read them as coverage of the
residential loop. The AI script inspects the existing recovery fixture and verifies provenance and pending proposals; its explicit `--submit` flag permits a fixture-scoped draft/submission if none exists. The provider script makes two real, potentially billable Mistral calls using a temporary public demo session held only in memory.

The user-journey script's `--concurrency` mode creates one additional unfunded fixture agreement.
Its `--signup` mode creates a new account in one exact already-owned allowlisted inbox and refuses to overwrite it;
that one-time signup has already succeeded and must not be reset merely to rerun a test.
The Firecrawl script's `--discover` mode can insert deduplicated unverified records into its exact demo package.
These explicit modes are not read-only and do not send RFQs or submit payment.

The settlement script is fixed to recovery dev and verifies `PAYPAL_ENV=sandbox`. Its default mode inspects the latest run. **`--start` creates a fresh run; `--resume` drives an existing one. Those modes authorize the guided demo's GC approval/capture/payout actions after real funding.** `--guest` additionally submits the public README sandbox card with synthetic buyer details, never simulates buyer approval, and refuses the outdated award fixture. `--owner-checkout` opens the current invoice through a fresh Owner session without submitting payment; **`--owner-pay` explicitly pays that $1,850 sandbox invoice**, checking the visible total and actual PayPal status. **`--release-retainage` explicitly uses the GC closeout control** only after the demo payouts and Owner invoice settle, then requires payout success. Paid invoices and settled retainage are not submitted twice. Do not interpret an opened checkout, submitted payout, or matching zero totals as settled payment evidence. Evidence is stored in the ignored `evidence/` directory. PayPal funds remain sandbox-only, and all production changes need an explicit, target-specific release decision.
