# TradePulse Pay: judge field guide

## Start without setup

Open **https://tradepulse-pay.asynchronope.tech/#/demo**.
The same build is also served at **https://cheery-axolotl-689.convex.site/#/demo**; either address works.
This is the tested recovery-dev sandbox, not production. The guide signs into ordinary public demo accounts:

| Role | Email | Where to begin |
| --- | --- | --- |
| GC | `gc@demo.tradepulse` | Guided demo, approval inbox, agreement ledger |
| Subcontractor | `sub1@demo.tradepulse` | My agreements & pay applications |
| Owner | `owner@demo.tradepulse` | Home, change orders, invoice payment |

All three use `TradePulseDemo!2026`. Use isolated browser contexts/profiles for simultaneous roles;
two tabs or private windows can share one login and are not sufficient isolation.
Do not put personal information or real payment details in these shared accounts.
The app does not require your own PayPal, model, AgentID or Studio account for the core demonstration.

For independent QA, give a new reviewer the [blind first-use brief](./browser-audit-start.md) first,
then the [detailed browser audit playbook](./browser-agent-audit.md). Those are audit assignments,
not claims that the independent checks have already passed.

## Two-minute inspection, no new payment

1. Enter as GC. In **Guided demo**, select `A401-DEMO-PAY-20261101-02` from the run history.
   Direct bookmark: https://tradepulse-pay.asynchronope.tech/#/judge-demo/nx74k1sdcnsmqzvkr97kf0ts598hch6p
   (mirror: https://cheery-axolotl-689.convex.site/#/judge-demo/nx74k1sdcnsmqzvkr97kf0ts598hch6p).
2. Read the steps. Open the agreement number to inspect the authoritative agreement ledger.
3. In **Approval inbox**, open the two pay applications for that agreement. Compare the honest claim and the
   deliberately overbilled claim. Inspect model/provider attribution, verdicts, proposals, the GC decision and PayPal IDs.
4. Check **Dashboard** against the agreement ledger. Dashboard totals across all projects can be higher;
   compare the selected agreement, not a global total to one contract.
5. Enter as Owner in a separate browser. The same agreement's `$1,850` change-order invoice is paid.
   Do not pay a different shared-account invoice by mistake.

The November 1 independent PayPal check verified:

| Record | Amount/status |
| --- | --- |
| Contract award | `$55,000`, seismic bracing excluded |
| Mobilization authorization | `$5,500`, partially captured |
| Honest pay-app gross | `$2,000`, capture COMPLETED; net payout `$1,800` SUCCESS |
| Overbilled pay-app gross | `$288` after model recommendation and explicit GC edit; net payout `$259.20` SUCCESS |
| Owner change-order invoice | `$1,850`, PAID |
| Retainage release | `$228.80`, SUCCESS |
| Agreement totals after release | Captured `$2,288`; paid `$2,288`; retainage held `$0` |

This is a real sandbox settlement of **partial progress**, not completion of the `$55,000` contract.
The `$1,850` Owner revenue is separate from the subcontract sum. Historical proof and limitations are in
[recovery progress](./recovery-progress.md). Live state can change when public demo users act.

## Hands-on run, approximately 5–10 minutes

1. GC → **Guided demo** → **Run TradePulse Pay demo**. This creates a fresh, labeled project and `$55,000` award.
   Starting explicitly authorizes the driver to file demo stand-ins and approve the displayed fixture proposals as the GC.
   This is a demo convenience, not autonomous production authorization.
2. Bookmark the resulting run-specific URL. Another judge starting a run will not switch your selected run.
3. Click **Fund** on Mobilization, choose card/guest checkout and authorize **`$5,500`**.
   Select **United States** if PayPal guesses another country.
4. Use the public sandbox card `4032031427005060`, expiry `01/29`, CVV `480`.
   Synthetic billing details: Sandbox Buyer, 123 Test Street, San Jose, CA 95131, phone 2025550100.
   Use a unique `@example.com` email. Choose guest payment; do not create an account, accept marketing or use real details.
5. Keep the GC tab open. It files two labeled pay applications, requests real AI review/license checks,
   obtains proposals, approves the honest amount, explicitly edits the other amount down and submits capture/payout requests.
6. The driver stops after sending the Owner invoice. **Submitted is not settled.**
   Inspect real states: captures COMPLETED, payout **items** SUCCESS, invoice PAID. Pending/UNCLAIMED/failed is not paid.
7. In a separate Owner browser, open the change order for **your exact agreement**, open PayPal and pay **`$1,850`** as guest.
   Back in the GC tab, **Refresh status** performs a real PayPal status read. Do not repeatedly create new invoices.
8. Optionally release retainage as GC once appropriate for this demo closeout. A platform top-up is only needed if funds are
   insufficient, not an obligatory fee. Wait for the retainage payout's real SUCCESS status.

If a browser/model/provider step fails, read its error and use **Continue this run** after resolving it.
Do not start another run just to hide a failure. An expired authorization needs an actual new authorization.

## How a real user starts

The public accounts above are not required for normal use:

1. On your own configured deployment, create an account with your reachable email, enter the eight-digit email
   verification code, and create a GC company. **The public recovery-dev mailer only sends to allowlisted test
   addresses**, not arbitrary personal/work email. Use the public demo roles unless you have an authorized test inbox;
   do not relax the allowlist to email discovered businesses. Codes expire after 15 minutes.
2. **Projects → New project**. Add a manual trade package, or use AI scoping. Dates default to two weeks ahead.
3. Add a vendor and **Enter bid on behalf** with permission. Discovery and RFQ email are optional, not prerequisites for a first award.
4. Open Procurement's leveling view, award the bid, generate the agreement, record actual execution and approve its SOV.
5. **People → Invite subcontractor**. Check the selected vendor's recipient email. The invited person verifies that exact email
   and accepts the invitation **before** creating a separate GC company.
6. The sub enters and submits a pay application. The GC reviews and decides.
   Funding, confirmed payee and compliance are genuine payment gates, not automatically cleared for real companies.
7. Invite the Owner similarly. Configure real company billing details before invoicing.

Do not use the demo fixture flags as proof of insurance, tax compliance, license validity, signature or actual work performed.

## Integration boundaries

- **PayPal sandbox + Mistral:** live settlement and real model/tool calls verified. Fallback review is labeled
  “Offline rules engine”, never represented as a live AI response.
- **KERNEL / CSLB:** a genuine active result was used from the 24-hour cache in the settled run.
  That is not a new registry lookup for every run or legal advice.
- **AgentMail:** actual verification-email delivery, code redemption, the signed inbound webhook and the delivery-status
  webhook were verified with an already-owned test inbox. The unmatched auth message acquired no tenant scope.
- **AgentID:** recovery needs owner-approved OAuth client registration, so the hosted demo hides the button
  instead of showing a disabled control. A labeled billing-agent stand-in is not evidence of successful AgentID login.
- **AG Studio:** optional licensed editor/chat. Its existing trial ends November 20, before December judging;
  a legitimate license extension is needed to promise its availability then. The core live React dashboard remains
  usable without it and no license warning is shown.
- **Firecrawl:** web-derived records remain unverified until a human checks them. Do not infer licensing or email consent from discovery.
  Recovery's live scrape and bounded search both returned genuine source content after the title-parsing fix.

## Official submission checklist, not a claim of submission

Sources: [official rules](https://paypalaihackathon.devpost.com/rules) and
[hackathon overview](https://paypalaihackathon.devpost.com/), checked November 1, 2026.

- Deadline: **November 12, 2026, noon Pacific / 3 pm Eastern**.
- Meaningful PayPal sandbox and AI integration, a nontrivial working build, and English documentation.
- Public open-source repository, visible license, necessary source/assets and complete setup instructions.
- Functional hosted demo or reproducible setup. Private apps need credentials and free judge access.
- Public **YouTube video under three minutes**, showing the actual running app.
- Explain significant work during the contest, since this extends an earlier project.
- Keep judge access and funded services working through **December 15, 2026**.

Technological implementation, design, potential impact, innovation and presentation are equally weighted.
Sponsor tools are optional; only claim prizes for tools actually used and lawfully licensed.
Public repository access and the MIT license were checked without authentication on November 1.
Use the recovery-branch source link in the README; `main` is not this build.
A local narrated actual-app recording is 2:51. The public YouTube URL, final Devpost submission and
ongoing service funding still need owner action. See [the submission draft and video handoff](./submission-draft.md).
No video upload, Devpost submission, production change or guarantee of a prize is implied by passing tests.
