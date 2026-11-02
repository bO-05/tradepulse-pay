# TradePulse Pay: submission draft and publishing handoff

This is preparation material, **not a submitted entry or a published YouTube video**.
The [official rules](https://paypalaihackathon.devpost.com/rules) set the deadline at
**November 12, 2026, noon Pacific / 3 pm Eastern**. Keep the demo available through December 15.

## Links to use

- Running app and public judge credentials: https://cheery-axolotl-689.convex.site/#/demo
- Matching source: https://github.com/bO-05/tradepulse-pay/tree/recovery/stabilize-2026-11-01
- Quick proof: https://cheery-axolotl-689.convex.site/#/judge-demo/nx74k1sdcnsmqzvkr97kf0ts598hch6p
- [Judge field guide](./judge-guide.md), [setup](../README.md#setup-and-run) and [MIT license](../LICENSE).
- Public YouTube URL: **not published**. Add the actual URL only after uploading and checking signed-out access.

The public GitHub repository and MIT license were reachable without authentication on November 1.
The preserved default `main` branch is not the recovery build. Link the recovery branch unless its owner
separately approves merging it. Production and the original development deployment remain unchanged.

## Copy-ready project description

### Inspiration

Construction payments are not simply “send money.” A general contractor must compare each progress claim
against the subcontract, detect excluded or premature work, hold retainage, check licensing and keep an
auditable record. Those decisions often live in disconnected spreadsheets, email and payment tools.

### What it does

TradePulse Pay connects a subcontract's schedule of values to PayPal sandbox authorization, partial capture,
net payouts, retainage and Owner change-order invoices. AI reviews the work claimed and proposes actions,
but deterministic code computes the amounts and the GC retains approval authority.

In the verified example, an intentionally overbilled $13,500 claim received a real Mistral recommendation of
$320. The guided-demo GC explicitly edited that to $288. PayPal confirmed the capture and the $259.20 net
payout. A separate honest claim, a $1,850 Owner invoice and a $228.80 retainage release also settled.
These are real sandbox receipts for partial progress, not full payment of the $55,000 subcontract.

### How we built it

The TypeScript/React application uses Convex for reactive data, authenticated roles, functions, scheduling
and audit records. PayPal's Server SDK handles Orders and Payments; REST handles Payouts, Invoicing and
webhook verification. Request IDs and webhook deduplication protect retries.

Mistral provides structured review and bounded proposal tools. Provider provenance and offline fallback are
visible. KERNEL performs California license lookups with a labeled cache. AgentMail supports actual email
verification and procurement mail; Firecrawl discovers source-linked contractor records, not verified licenses.
The core dashboard is an ordinary reactive React view. An optional AG Studio editor/chat requires valid licensing.

### Challenges and accomplishments

Recovery began from the public GitHub baseline after a managed workspace became unavailable.
We isolated development rather than overwriting a newer deployed schema whose waiver source was missing.
We repaired model reasoning-budget exhaustion, distinguished completed captures from pending/refunded states,
and independently reconciled PayPal receipts against the agreement ledger.

We also tested actual account creation, emailed-code redemption, signed email webhooks, onboarding, project
and package creation, three-role access, and two judges using independent run bookmarks.
The public guide removes setup friction without bypassing authentication or real payment approvals.

### What we learned

A created order is not authorization, a submitted payout is not settlement, and a passing deterministic
fixture is not proof that a model ran. Reliable agentic payments need explicit approvals, code-computed money,
idempotency and evidence that names both its successes and its limits.

### What's next

Recover the missing cloud-only waiver implementation before planning any original-deployment migration.
Complete owner-approved AgentID registration, maintain service funding through judging, obtain a legitimate
Studio license extension if demonstrating its editor, and expand real-company validation beyond synthetic fixtures.

### Built with

TypeScript, React, Vite, Convex, PayPal Server SDK, PayPal React SDK, PayPal Agent Toolkit,
Mistral, Vercel AI SDK, KERNEL, AgentMail, Firecrawl, AG Studio, Postman.
APIMatic's development-time SDK lookups are documented in [the lookup log](./apimatic-log.md).
AgentID integration code exists, but recovery OAuth registration is **not certified**.

## Existing-project disclosure

TradePulse Pro's procurement system predates this entry. PayPal-era work begins after baseline `2ad5543`,
with first PayPal commit `c7986da` on October 7, 2026; see `2ad5543..paypal-hackathon`.
The September TradePulse Pro procurement base was previously submitted to the Convex hackathon.
The November recovery branch adds funded Mistral support, payment-state and reconciliation corrections,
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
4. Test the YouTube URL, hosted app and recovery-branch source in a signed-out browser.
5. Add the actual YouTube URL to Devpost, review the existing-project disclosure and submit before the deadline.
6. Keep PayPal, Convex and model/service credits available through judging. Do not promise the Studio
   editor after its November 20 trial expiry without a legitimate extension.

No YouTube upload, Devpost submission, AgentID owner approval, production release or prize outcome is claimed.
