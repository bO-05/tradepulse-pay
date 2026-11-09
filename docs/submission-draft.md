# TradePulse Pay: submission draft and publishing handoff

This is preparation material, **not a submitted entry or a published YouTube video**.
The [official rules](https://paypalaihackathon.devpost.com/rules) set the deadline at
**November 12, 2026, noon Pacific / 3 pm Eastern**. Keep the demo available through December 15.

## Links to use

- Running app and public judge credentials: https://tradepulse-pay.asynchronope.tech/#/demo
- Mirror (same build): https://cheery-axolotl-689.convex.site/#/demo
- Matching source: https://github.com/bO-05/tradepulse-pay/tree/main
- Quick proof: https://tradepulse-pay.asynchronope.tech/#/judge-demo/nx74k1sdcnsmqzvkr97kf0ts598hch6p
- [Judge field guide](./judge-guide.md), [setup](../README.md#setup-and-run) and [MIT license](../LICENSE).
- Public YouTube URL: **not published**. Add the actual URL only after uploading and checking signed-out access.

The public GitHub repository and MIT license were reachable without authentication on November 1.
On November 6 the default `main` branch was fast-forwarded to the recovery build, so the source link
above and the running app are the same code. `recovery/stabilize-2026-11-01` stays frozen at that
commit as a backup. Production and the original development deployment remain unchanged.

## Copy-ready project description

### Inspiration

General contractors paying subcontractors on commercial jobs must check every progress claim against the
subcontract, catch excluded or premature work, hold retainage, check licensing, and keep an auditable record
before money moves. TradePulse Pay does that with AI review, code-computed amounts, explicit GC approval, and
PayPal Orders, Payouts and Invoicing.

### What it does

TradePulse Pay connects a subcontract's schedule of values to PayPal sandbox authorization, partial capture,
net payouts, retainage and Owner change-order invoices. AI reviews the work claimed and proposes actions,
but deterministic code computes the amounts and the GC retains approval authority.

In the verified example, an intentionally overbilled $13,500 claim received a rules-review recommendation of
$320, with Mistral explaining the evidence. The guided-demo GC explicitly edited that to $288; the change is
shown against the recommendation, with the GC's per-line reasons when entered. PayPal confirmed the capture and the $259.20 net payout. A separate honest claim, a $1,850 Owner invoice
and a $228.80 retainage release also settled. These are real sandbox receipts for partial progress, not
full payment of the $55,000 subcontract.

### PayPal APIs used

- **Orders v2:** AUTHORIZE, partial capture, void, reauthorize, and an hourly honor-period reauthorization.
- **Payouts:** progress payments net of retainage and the closeout retainage release.
- **Invoicing v2:** Owner change-order invoices and payment status.
- **Webhooks:** signature verification and replay-safe event ids.
- **PayPal JS SDK:** funding and checkout buttons.
- **Agent Toolkit:** read-only tools in the pay agent (`list_invoices`, `get_invoice`, `get_order`,
  `list_transactions`).

### AI used

- **Mistral Large** (`mistral-large-latest`) structured per-line review and tool proposals through the Vercel AI SDK.
- **Code, not the model, computes every amount** from the schedule of values.
- **Deterministic offline rules engine** when no provider is available; the UI labels it as not AI.
- **KERNEL** hosted-browser CSLB license check with a visible live view and a 24-hour cache.

### How it differs

Procore Pay, GCPay, Oracle Textura and Siteline automate the pay-app workflow. TradePulse Pay's review is
contract-scope-aware: it flags **excluded scope** and **out-of-sequence** billing against the awarded SOV,
not only arithmetic. A mid-size GC without a Textura/GCPay contract can pay an approved subcontractor through
PayPal Payouts instead of waiting for a 30–60 day check run.

The lien-waiver gate is an opt-in release control, not a form. When an agreement enables it, the sub signs a
conditional waiver for the payment being released and, if the agreement asks for it and an earlier payment
exists, an unconditional waiver for that prior payment. Releasing retainage requires a separate signed waiver
for exactly the amount released. Each signature is tied to recorded evidence: the statement text's SHA-256, the
timestamp, the request's forwarded-address header when present (with the header source the route recorded) and
the browser string that posted it. When no address header is available, the record says so.

### Potential impact

On US commercial jobs, the typical trade partner waits about **50 days** from pay-app submission to payment
(Built's 2026 transaction ledger; Billd's 2026 survey reports 51 days), and **5–10% of each progress payment**
is held as retainage until closeout (Corpay, 2026). TradePulse Pay attacks the review step and keeps the
retainage ledger attached to the same payment record, so the GC, sub and Owner read one history.

### How we built it

The TypeScript/React application uses Convex for reactive data, authenticated roles, functions, scheduling
and audit records. PayPal's Server SDK handles Orders and Payments; REST handles Payouts, Invoicing and
webhook verification. Request IDs and webhook deduplication protect retries.

Mistral provides structured review and bounded proposal tools. Provider provenance and offline fallback are
visible. KERNEL performs California license lookups with a labeled cache. AgentMail supports email verification
and procurement mail; Firecrawl discovers source-linked contractor records, not verified licenses. The core
dashboard is an ordinary reactive React view; the optional AG Studio editor/chat requires valid licensing.

### Challenges and accomplishments

Recovery began from the public GitHub baseline after a managed workspace became unavailable. We isolated
development instead of overwriting a newer deployed schema, repaired model reasoning-budget exhaustion, and
reconciled PayPal receipts against the agreement ledger. The evidence names both successes and limits.

### What we learned

A created order is not authorization, a submitted payout is not settlement, and a passing deterministic
fixture is not proof that a model ran. Reliable agentic payments need explicit approvals, code-computed money,
idempotency and evidence that names both its successes and its limits.

### What's next

The residential reference job is settled end to end: Lopez carries the Ortiz subcontract, the settled
pay app with its line-specific cut, the signed conditional waiver, the net payout, paid Draw #1, the paid
change order and the four-cell GC money strip. The largest remaining gap is a separate prime-milestone
schedule that creates owner draws automatically and an in-app subcontract acceptance step for the sub,
plus real-company validation beyond synthetic fixtures.
Owner-side items: complete AgentID registration, keep the Mistral and KERNEL services funded through
judging, and obtain a legitimate Studio license extension if its editor is demonstrated.

### Scope for this submission

The submitted loop is the residential GC's own: job setup with a prime value, a subcontract with an SOV and
milestones, milestone funding, sub pay-app review, PayPal capture and payout, lien waivers with signing
evidence, and owner billing per period. A milestone-style draw uses the same owner sheet: enter that draw's
amount on the relevant prime line and submit it. The settled Lopez reference shows the whole loop: the Ortiz
pay app with a line-specific cut, the conditional waiver, the net payout, paid Draw #1, the paid change order
and the four-cell GC money strip. Not built, and stated here as roadmap rather than claimed: a separate
prime-milestone schedule that creates owner draws automatically, and in-app subcontract acceptance by the sub.

### Built with

PayPal Orders, Payouts, Invoicing, Webhooks and Agent Toolkit; Mistral; Convex; React; TypeScript; Vite;
Vercel AI SDK; KERNEL; AgentMail; Firecrawl; Postman.
APIMatic's development-time SDK lookups are documented in [the lookup log](./apimatic-log.md).
AgentID and AG Studio integration code exists, but neither is enabled on the hosted demo.

## Testing instructions (paste into Devpost)

1. Open the demo guide: **https://tradepulse-pay.asynchronope.tech/#/demo**. No signup is needed.
   The same build is also at **https://cheery-axolotl-689.convex.site/#/demo**.
2. Sign in as any role from `#/demo`; the collapsed **Manual sign-in and sandbox details** block holds the
   shared demo password:
   - GC: `gc@demo.tradepulse`
   - Subcontractor: `sub4@demo.tradepulse` (Ortiz Plumbing, the settled Lopez pay app)
   - Owner: `owner@demo.tradepulse`
3. Shortest proof path: open the pinned reference run
   **https://tradepulse-pay.asynchronope.tech/#/judge-demo/nx74k1sdcnsmqzvkr97kf0ts598hch6p**,
   then the ledger, the AI review and the PayPal receipt IDs. It is read-only and already settled.
4. To fund a live sandbox authorization yourself, use the public PayPal sandbox card
   `4032031427005060`, expiry `01/29`, CVV `480`. The app uses `api-m.sandbox.paypal.com`; no real money moves.
5. The app is a hash-routed SPA. Deep links work after sign-in and the Back button returns to the previous screen.

## Existing-project disclosure

TradePulse Pro's procurement system predates this entry. PayPal-era work begins after baseline `2ad5543`,
with first PayPal commit `c7986da` on October 7, 2026; see `2ad5543..paypal-hackathon`.
The September TradePulse Pro procurement base was previously submitted to the Convex hackathon.
The November recovery work (on `main` since November 6) adds funded Mistral support, payment-state and
reconciliation corrections,
recovery-only integration setup, public judge access, independent run selection, workflow repairs and
actual multi-role/email/sandbox settlement evidence. Do not claim that the earlier procurement app was
created entirely during this contest.

## Judging evidence map

| Criterion | What to inspect |
| --- | --- |
| Technological implementation | Role/tenant guards, integer-cents calculations, GC-approved proposals, request IDs, verified webhooks and independent receipt reconciliation |
| Design | Public role guide, run history/bookmarks, clear payment states, review explanations and separate GC/sub/Owner workspaces |
| Potential impact | Progress-claim checking, excluded-scope detection, retainage accounting and a single traceable payment workflow |
| Innovation | Contract-bound review and bounded tool proposals with code-computed amounts, not unconstrained AI-authored payments |
| Presentation | Actual running app, short inspectable settled example, public source, honest integration boundaries and the narrated recording |

## Video and final owner steps

A locally generated recording is **171.05 seconds (2:51)** with seven actual-app chapters:
public guide, pinned run, ledger, review, agent trace, separate Owner workspace and dashboard.
It inspects an already-settled sandbox run; it does **not** pretend to film a new checkout or AgentID login.
Narration is the offline synthetic Microsoft Zira voice. Captions identify each chapter.

Recording source: [narration text](./submission-demo-script.json),
[`render-demo-narration.ps1`](../scripts/qa/render-demo-narration.ps1) and
[`recovery-demo-film.mjs`](../scripts/qa/recovery-demo-film.mjs).
Generated media and machine-specific evidence remain in the ignored local `evidence/` directory, not Git.
Final recording: `evidence/submission-film-2026-11-01T19-41-30-725Z/TradePulse-Pay-demo.mp4`.
Frame sampling and audio-level checks passed; the owner should still watch the full recording before publishing.

1. Watch the full MP4, including audio. Check that no private contacts or credentials are visible.
2. Upload it to the owner's YouTube channel as **Public**, not private/unlisted. Suggested title:
   **TradePulse Pay | Contract-aware AI payments on the PayPal sandbox**.
3. Suggested description: “Actual running TradePulse Pay recovery demo. Read-only tour of a previously
   settled sandbox run, not a live payment replay. AI proposes, code computes, the GC approves.
   Public demo and source links are listed above. Narration uses a synthetic voice.”
   Add the actual demo/source URLs and respect any channel or platform disclosure requirements.
4. Test the YouTube URL, hosted app and the `main`-branch source in a signed-out browser.
5. Add the actual YouTube URL to Devpost, review the existing-project disclosure and submit before the deadline.
6. Keep PayPal, Convex and model/service credits available through judging. Do not promise the Studio
   editor after its November 20 trial expiry without a legitimate extension.

No YouTube upload, Devpost submission, AgentID owner approval, production release or prize outcome is claimed.
