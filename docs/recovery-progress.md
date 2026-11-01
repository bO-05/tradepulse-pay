# Recovery status

## Environments and source

- Recovery branch: `recovery/stabilize-2026-11-01`, based on GitHub `main` at `fb5e416`.
- Isolated recovery dev: **https://cheery-axolotl-689.convex.site**.
- Original production: `earnest-mongoose-745`, unchanged.
- Original development: `exuberant-boar-323`, preserved.
- Frozen legacy deployment: `brainy-skunk-440`, never modify.

The original development deployment contains newer waiver functions and a `lienWaivers` table not present in GitHub. Its agreement and document validators also differ. An attempted push correctly failed schema validation before activation. No records were deleted, validation was not disabled, and the older checkout was not forced over the cloud-only feature.

The managed cloud workspace is unavailable. GitHub is the recoverable source baseline; deployed schema metadata is not a substitute for the missing source. Do not redeploy over the original development environment without a deliberate recovery or migration plan.

## Verified recovery baseline

- Final full regression: **1,913 tests passed across 139 files** (`evidence/recovery-final-regression.json`). The subsequent native procurement adjustment passed focused router/isolation/guard tests and typechecking.
- Frontend provenance/diagnostics follow-up: **42 focused tests passed**, followed by a successful build, guard audit and documentation checks.
- Production build and TypeScript checks passed.
- Guard audit: no reported missing tenancy guards.
- Documentation checks passed; seven historical audit reports rendered offline.
- Isolated backend deployed with schema validation enabled; frontend uploaded separately.
- GC, subcontractor and owner demo logins passed; nine read-only routes loaded without browser errors.
- Account-creation and password-reset forms open on the recovery build.
- PayPal sandbox token acquisition and a $1 AUTHORIZE order creation/read passed through SDK and REST. The order remained `CREATED`: it was not approved, authorized, captured or paid.

These checks do not prove a settled end-to-end payment. Old audit reports are historical evidence, not current functional certification.

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

## Remaining integration work

- Complete guest approval, authorization, capture, payout settlement and ledger reconciliation on the isolated sandbox.
- Register separate PayPal and AgentMail inbound webhooks and an AgentID callback if those features are needed on recovery dev. Original deployment identifiers were not reused as if registered here.
- Keep compliance and license gates intact. An unavailable check is not a verified license.
- The recovery dashboard has an ordinary React ledger view and does not need an AG Studio license. Studio layout/chat still needs valid licensing.
- Build warnings remain for large frontend chunks. The successful build is not a performance certification.
- Recovery `SITE_URL` is the hosted recovery origin. Do not change a shared deployment's auth origin merely to test another browser origin.

## Local checks

Run from the repository root:

```powershell
npm test -- --maxWorkers=2
npm run build
npm run verify:guards
npm run verify:docs
npm run verify:reports
node scripts/qa/recovery-smoke.mjs --url https://cheery-axolotl-689.convex.site/ --demo-login
node scripts/qa/recovery-ai-smoke.mjs
node scripts/qa/recovery-provider-smoke.mjs
```

The browser smoke scripts use the public demo accounts only and create fresh browser contexts. By default, neither performs business writes. The AI script inspects the existing recovery fixture and verifies provenance and pending proposals; its explicit `--submit` flag permits a fixture-scoped draft/submission if none exists. The provider script makes two real, potentially billable Mistral calls using a temporary public demo session held only in memory. None of these scripts approves or sends money. Evidence is stored in the ignored `evidence/` directory. PayPal funds remain sandbox-only, and all production changes need an explicit, target-specific release decision.
