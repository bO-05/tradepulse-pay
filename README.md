# TradePulse Pay

> Milestone payments, pay-application review and retainage for commercial construction subcontracts, on the PayPal sandbox. Built on the TradePulse Pro procurement app.

TradePulse Pay is MIT licensed (see [`LICENSE`](./LICENSE)).

**Live URL: https://earnest-mongoose-745.convex.site** (the production deployment `earnest-mongoose-745` of the `tradepulse-pay` Convex project, with the demo data and demo accounts seeded). All PayPal calls use the sandbox (`api-m.sandbox.paypal.com`); no real money moves. AgentID billing-agent sign-in works on the live URL as well as the password demo accounts.

> The earlier TradePulse Pro submission for the Convex hackathon lives on a separate, frozen deployment (`brainy-skunk-440`). It is not TradePulse Pay and does not run this code.

---

## The problem

A general contractor (GC) awards a subcontract, then pays it out over months. Every month the subcontractor files a pay application ("we are 40% done with rough-in, pay us $X"). The GC has to check each line against the schedule of values, catch overbilling and billing for excluded scope, hold back retainage (usually 10%), confirm the sub's license is still active, and then actually move the money. Today this is spreadsheets, email and manual bank transfers. Overbilling slips through, retainage is tracked by hand, and change orders are invoiced separately.

## The pitch

TradePulse Pay takes the contract the GC just awarded in TradePulse Pro and runs the money side:

1. **Execute the agreement.** Code generates the schedule of values (SOV) from the leveled bid, including the excluded-scope lines, and four funded milestones.
2. **Fund a milestone.** The GC approves a PayPal `AUTHORIZE` order. The money is held, not captured.
3. **Sub files a pay application**, either a person or the sub's **billing agent** signed in with AgentID.
4. **AI review.** Anthropic Claude returns per-line verdicts (ok, overbilled, excluded scope, front-loaded, out of sequence). **Code computes every dollar** from the SOV; the model never authors an amount. KERNEL checks the sub's California license (CSLB) in a hosted browser.
5. **Pay agent proposes**, the GC approves. The agent can only insert proposals (capture, payout, hold, reschedule). Money moves only after the GC approves: PayPal captures from the authorization, pays the sub net of retainage through Payouts, and credits the retainage ledger.
6. **Change orders** are invoiced to the Owner with PayPal Invoicing. **Retainage** is released at closeout as one payout of the ledger balance.
7. **Dashboard.** An AG Studio dashboard shows payments, pay apps, retainage and change orders, with a chat agent that answers from the Convex ledger.

---

## What changed since Oct 1

The TradePulse Pay work is the commit range **`2ad5543..paypal-hackathon`** on branch `paypal-hackathon` (first commit `fc2f763`, Oct 7 2026). `2ad5543` is the last TradePulse Pro commit (Sep 22 2026). See them with `git log --oneline 2ad5543..paypal-hackathon`.

- **Sign-in and roles (AUTH).** Convex Auth email + password with roles gc, sub and owner; AgentID sign-in for billing agents with GC-managed links; every public Convex function, old and new, is role-guarded (`docs/guard-audit.md`).
- **Payments (PAY).** Payments schema and integer-cents money helpers; PayPal client with token cache, `PayPal-Request-Id` idempotency, backoff and audit logs; SOV and milestones on execution; AUTHORIZE funding; partial capture, void and reauthorize; payouts net of retainage; retainage ledger and closeout release; change-order invoices; signature-verified `/paypal/webhook`; hourly honor-period watcher; payout retry and ledger reconciliation; a read-only milestone funding summary for subs.
- **Pay apps and agent (AGENT).** Sub pay-application submit and withdraw with agent attribution; previous % to date taken from approved billing only, with amounts still pending review shown separately; AI review with structured verdicts and an "Offline rules engine" fallback; KERNEL CSLB license checks with live view and 24 h cache; pay-agent proposals with a GC approval inbox.
- **Dashboard (DASH).** Lazy-loaded AG Studio payments dashboard for the GC and a read-only owner view, with the TradePulse pay agent wired through the auth-gated `/ai/studio` Anthropic proxy.
- **Submission (DOCS, PAY).** Postman collection and APIMatic log, the one-click judge demo, this README, `.env.example`, the secret sweep and the guard audit.

The procurement features of TradePulse Pro (CSI scoping, Firecrawl discovery, AgentMail RFQ inboxes, bid leveling, scope clash detection, A401-style drafts) are unchanged in behavior. They now require the GC sign-in.

---

## Architecture

```
Browser (Vite dev server, http://localhost:3150)
  ├─ Convex Auth sign-in: password (gc, sub, owner) or "Continue with AgentID" (billing agents)
  ├─ Procurement (TradePulse Pro views, GC only)
  ├─ Payments workspace (src/payments/): ledger, fund milestone (PayPal JS SDK buttons),
  │    sub portal, GC approval inbox (AI review, KERNEL live view, approve/edit/reject),
  │    owner portal (change-order invoices), judge demo
  └─ AG Studio dashboard (src/dashboard/, lazy route) → POST /ai/studio with the Convex Auth token

Convex (convex/)
  auth.ts, auth.config.ts     Convex Auth: Password + AgentID OIDC provider
  lib/roles.ts                requireRole / requireRoleInAction / requireAgreementAccess
  lib/money.ts                integer cents; the only place amounts become PayPal strings
  payments/                   SOV, orders, captures, payouts, retainage, invoices, webhook, crons
  payApps/                    submit, withdraw, AI review, proposals, approval
  agent/                      pay agent (AI SDK v7 + @ai-sdk/anthropic + read-only PayPal agent-toolkit tools)
  kernel/                     CSLB license check in KERNEL browsers
  dashboard/                  dashboard queries and the /ai/studio Anthropic proxy
  judgeDemo/                  one-click judge demo runner
  http.ts                     /api/auth/*, /paypal/webhook, /ai/studio, /llms.txt, /api/health, demo PDFs
        │
        ▼
PayPal sandbox · Anthropic · KERNEL → CSLB website · AgentID · AgentMail · Firecrawl
```

Rules the code enforces:

- No money moves without an explicit GC action (fund) or a GC-approved proposal (`approveProposal`).
- Amounts are integer cents (`*Cents` fields). Conversion goes through `convex/lib/money.ts` only.
- Every PayPal write sends a `PayPal-Request-Id` and writes an `auditLogs` row without secrets. A duplicate webhook event id is a no-op.
- A sub sees only its own agreements. The owner can read and pay invoices but cannot approve or fund.
- Secrets stay in the Convex environment. Only the PayPal client id and the AG Studio license key reach the browser.

---

## Setup and run

### Prerequisites

- Node.js 20+ and npm
- A Convex account (or a deploy key for an existing deployment)
- A PayPal developer account with a **sandbox** REST app, and sandbox accounts for the GC buyer, three subs and the owner
- Optional, for the full flow: Anthropic, KERNEL, AgentID, AgentMail and Firecrawl keys

### 1. Install

```bash
git clone https://github.com/bO-05/tradepulse-pay.git
cd tradepulse-pay
git checkout paypal-hackathon
npm ci
```

### 2. Environment variables

[`.env.example`](./.env.example) lists every variable name the code reads, with no values. There are two groups:

- **Browser (`.env.local`, gitignored):** `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`, `VITE_PAYPAL_CLIENT_ID` (public by design), `VITE_AG_STUDIO_LICENSE_KEY` (client-side by design).
- **Convex deployment:** `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL=claude-sonnet-5-5`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV=sandbox`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_SANDBOX_{GC_BUYER,SUB1,SUB2,SUB3,OWNER}_EMAIL`, `KERNEL_API_KEY`, `FIRECRAWL_API_KEY`, `AGENTMAIL_API_KEY`, `AUTH_AGENTID_ID`, `AUTH_AGENTID_SECRET`, `SITE_URL`, plus `JWT_PRIVATE_KEY` and `JWKS` (generated below).

Names marked `# optional` in `.env.example` are unset on dev and production and the code works without them. [`docs/prod-env-names.md`](./docs/prod-env-names.md) reconciles every backend-read name against the production deployment (names only).

Keep real values in a secrets file outside the repo. The setup scripts read it, pipe each value to `npx convex env set` on stdin and print names only. They refuse the frozen `brainy-skunk-440` deployment.

### 3. Convex deployment (sandbox setup)

```bash
export SECRETS_FILE=/path/to/secrets.env          # must define CONVEX_DEPLOY_KEY for your dev deployment
export EXPECTED_DEPLOYMENT=<your-deployment-name>  # the scripts refuse any other deployment

# Load only the deploy key into this shell. The two scripts read the secrets file in their own
# child shell, so nothing they load reaches this shell; the `npx convex` commands below need the key here.
export CONVEX_DEPLOY_KEY="$(set -a; . "$SECRETS_FILE"; printf '%s' "${CONVEX_DEPLOY_KEY:-}")"
case "$CONVEX_DEPLOY_KEY" in *":$EXPECTED_DEPLOYMENT|"*) echo "deploy key targets $EXPECTED_DEPLOYMENT";; *) echo "deploy key missing or for another deployment";; esac

bash scripts/sync-convex-env.sh            # target: EXPECTED_DEPLOYMENT. App env incl. ANTHROPIC_MODEL and SITE_URL=http://localhost:3150
bash scripts/setup-convex-auth-keys.sh     # target: EXPECTED_DEPLOYMENT. JWT_PRIVATE_KEY + JWKS (skips if already set)
npx convex dev --once                      # target: the deployment named in CONVEX_DEPLOY_KEY. Pushes functions
npx convex run demoAccounts:seedDemo '{}'  # target: the deployment named in CONVEX_DEPLOY_KEY. Demo project, accounts and role profiles
```

Neither command prints a secret. If you keep the key in another secret store, `export CONVEX_DEPLOY_KEY=...` from that store instead of the `$(...)` line; `set -a; . "$SECRETS_FILE"; set +a` also works but exports every value in the file to your shell. Each `npx convex` command targets the deployment encoded in `CONVEX_DEPLOY_KEY` (a `dev:<name>|...` key); the scripts additionally refuse a key that does not match `EXPECTED_DEPLOYMENT`. A production key (`prod:<name>|...`) is deployed with `npx convex deploy` instead of `npx convex dev --once`.

Run the env sync before the first push: the Firecrawl component requires `FIRECRAWL_API_KEY`, and the push fails without it.

Then add the remaining browser values to `.env.local`: `VITE_CONVEX_SITE_URL=https://<deployment>.convex.site`, `VITE_PAYPAL_CLIENT_ID` and `VITE_AG_STUDIO_LICENSE_KEY`.

PayPal sandbox setup:

1. In the PayPal developer dashboard, create a sandbox REST app and enable Payouts and Invoicing for it.
2. Add a sandbox webhook pointing to `https://<deployment>.convex.site/paypal/webhook` with the authorization, capture, payouts and invoicing events. Put its id in `PAYPAL_WEBHOOK_ID`.
3. Put the sandbox account emails in `PAYPAL_SANDBOX_*_EMAIL` before seeding. The seed copies them onto the sub and owner profiles; they are not stored in this repository.

### 4. Run

```bash
npm run dev        # Vite on http://localhost:3150 (strict port)
```

Open **http://localhost:3150** (not `127.0.0.1`). Convex Auth redirects to `SITE_URL`, so sign-in only works on that exact origin.

---

## Demo accounts and password

TradePulse Pay requires sign-in. Signed-out visitors only see the sign-in page; `/llms.txt` and `/api/health` stay public.

**New accounts.** The sign-in page has **Create account** (name, email, password of at least 10 characters mixing two kinds of characters) and **Forgot password?**. Both email an 8-digit code from "TradePulse Pay" (`cleverneed464@agentmail.to`); codes are typed in and expire after 15 minutes, and a new code can be requested every 30 seconds. After verifying, a person with no company or invite sets up their general contractor company (name, address, state, phone) and becomes its admin. Resetting a password signs the account out everywhere else. Code emails count against the deployment's daily email budget (`EMAIL_DAILY_BUDGET`); when it is used up, the screen says no code was sent.

**Demo access.** The sign-in page shows no demo credentials. The seeded demo accounts below sign in with email and password only (they are marked verified, so no code is sent). All demo accounts share the public demo password **`TradePulseDemo!2026`**.

| Account | Role | What it sees |
|---|---|---|
| `gc@demo.tradepulse` | General contractor | Everything: procurement (award, execute, reset, 1-click demo), payments, approval inbox, billing agents, dashboard, judge demo |
| `sub1@demo.tradepulse` | Subcontractor | Only Rosendin Electric's agreements and pay applications |
| `sub2@demo.tradepulse` | Subcontractor | Only TDIndustries' agreements and pay applications |
| `sub3@demo.tradepulse` | Subcontractor | Only Clarke Kent Plumbing's agreements and pay applications |
| `owner@demo.tradepulse` | Owner | Read-only projects, agreements and change-order invoices, and the read-only dashboard; no award, approve or fund controls |

A sub's portal and agreement summary include a read-only **Milestone funding** section per agreement (Not funded, Funded (authorized), Captured or Paid); the GC ledger shows the same label under each milestone. On the pay-application form, each line shows the **% approved to date** (approved billing only) and any amount **pending review** from pay apps not yet approved.

## Guest test card (PayPal sandbox)

There is no buyer password. Fund milestones and pay invoices with PayPal guest checkout:

- Choose **Debit or Credit Card** in the PayPal window.
- Card `4032031427005060`, expiry `01/29`, CVV `480`. Any name and address.
- If PayPal offers to create an account, turn off "Save info & create your PayPal account" and continue as guest.

The PayPal sandbox sends no real emails and moves no real money.

## Billing-agent sign-in (AgentID)

A subcontractor can let an AI billing agent file pay applications for it. The agent signs in with [AgentID](https://agentid.com), using its AgentMail inbox as its identity.

1. **The GC links the agent.** Signed in as `gc@demo.tradepulse`, open **Billing agents**, enter the agent's inbox email (the demo agent is `boldlevel182@agentmail.to`) and pick the subcontractor (sub1's contractor, Rosendin Electric). The GC can revoke the link at any time; the agent loses access on its next request.
2. **The agent signs in.** On the sign-in page, click **Continue with AgentID**. The browser goes to AgentID's "Waiting for your agent to authorize an inbox" page. The `jti` value in that page's URL is the auth token.
3. **The agent's owner authorizes.** The inbox owner approves the sign-in with the AgentMail API, `POST https://api.agentmail.to/v0/inboxes/{inbox}/authorize` with body `{"auth_token": "<jti>", "accept_disclosure": true}` and their own AgentMail API key. AgentID redirects back and the agent lands on the sub workspace.
4. **What the agent can do.** It sees the linked sub's agreements and can submit or withdraw that sub's pay applications. It can never approve, fund, capture, pay or manage links. Its pay apps and audit rows record the agent email and its owner, and the GC inbox shows "Submitted by billing agent <email> on behalf of <owner>".

An AgentID account without an active link sees **Agent not authorized**, naming the agent email and its owner, with a sign-out button.

The AgentID client is registered per deployment with the redirect URI `https://<deployment>.convex.site/api/auth/callback/agentid`. Its id and secret go in `AUTH_AGENTID_ID` and `AUTH_AGENTID_SECRET` on the Convex deployment, never in the repo.

---

## TradePulse Pay judge demo (PayPal sandbox, about 1–3 minutes)

Sign in as `gc@demo.tradepulse`, open the **Demo simulator** and click **Run TradePulse Pay demo** (or use the **Guided demo** item in the navigation). The simulator, guided tour, guided demo and model checks exist only for the Demo company and are labeled "Demo"; real companies never see them. Each run creates a fresh, labeled demo award for sub1's contractor (Rosendin Electric, $59,500 with an excluded $4,500 seismic bracing line) and then uses the app's regular functions:

1. Execute the agreement; the schedule of values and four milestones are generated.
2. **You** fund Mobilization ($5,950.00) in the PayPal popup with the guest card above. The demo waits for the real authorization.
3. The demo files two pay applications as stand-ins: an honest one for sub1 and an overbilled one (billing early closeout work and the excluded scope, no lien waiver) for the billing agent `boldlevel182@agentmail.to`. Both are labeled **"Judge demo · filed by <GC>"** on every screen.
4. AI review (Anthropic; code computes every dollar), the KERNEL CSLB license check, and the pay agent's capture and payout proposals.
5. The GC approves the honest pay app as proposed and edits the agent's proposal down to 90% before approving. PayPal captures from the authorization and pays sub1 90% net; 10% goes to the retainage ledger.
6. A $1,850.00 change order is invoiced to the Owner through PayPal Invoicing. The dashboard step turns green once its totals match the ledger.
7. **The Owner** pays the invoice in their own browser (sign in as `owner@demo.tradepulse`, **Projects & change orders**, **Open PayPal invoice**, pay with the guest card and a guest email), then clicks **Refresh status**.

The page shows each step's status from Convex and PayPal, and the time from start to the change-order invoice. "Continue this run" resumes after a reload or re-sign-in, including a change order left as a draft; that step finishes only once the invoice is sent and has a payer link.

**Sandbox-only setup step: top up the platform balance before releasing retainage.** PayPal keeps about 3.5% + $0.49 of every capture, so after paying subs 90% the sandbox platform account holds less than the retainage it owes, and a retainage release fails with `INSUFFICIENT_FUNDS`. The demo page's optional closeout section has a GC-only **Sandbox setup: top up the platform balance** panel (`payments/sandboxTopUp:createTopUpOrder` / `captureTopUpOrder`). It creates a PayPal CAPTURE order (suggested amount: 110% of the retainage held), opens the PayPal checkout in a new tab (pay as guest with the card above), and then **Capture top-up** moves the funds into the platform account. If PayPal reports the capture as `PENDING`, the top-up stays pending and does not count as funding; **Check capture status** reads the same capture again (it never captures twice) until PayPal marks it `COMPLETED` or denies it. Wait about 15 s, then click **Release retainage**. The top-up is not linked to any agreement and is never counted in ledger or dashboard totals. It refuses to run unless `PAYPAL_ENV` is `sandbox`.

### Agreement ledger totals

The ledger (`#/payments/<agreementId>`) shows these totals, all in integer cents formatted as dollars:

- **Paid** = net of successful payouts plus successful retainage releases.
- **Retainage held** = balance of the retainage ledger (credits on accepted payouts, debits on releases).
- **Balance** = contract sum to date (original contract sum plus approved change orders) − (paid + retainage held). The same formula is printed under the totals.
- Reconciliation row: funded but not captured, captured, captured but not paid out (for example a failed payout waiting for "Retry payout"), retainage released, and change orders invoiced and paid.

Funded authorizations are watched hourly (`convex/crons.ts`): after the 3-day honor period they are reauthorized once, and an authorization that reaches its expiry marks the milestone "Funding expired" so it can be funded again.

---

## Which integrations are live and which fall back

| Integration | Live behavior | Fallback or limit (labeled in the app) |
|---|---|---|
| PayPal (sandbox) | Orders `AUTHORIZE`, authorize, capture, void, reauthorize; Payouts; Invoicing v2; webhook signature verification. All real sandbox calls. | Sandbox only. An unverified webhook gets 400 and is recorded `verified=false`. PayPal's webhook simulator events fail verification by design. Retainage release needs the sandbox top-up above. |
| Anthropic | `claude-sonnet-5-5` (from `ANTHROPIC_MODEL`) for pay-app review, the pay agent and the AG Studio chat proxy. | If no provider responds, the review and the agent fall back to a deterministic rules engine labeled **"Offline rules engine"**. The Studio proxy returns 503 when no key is set. |
| KERNEL | Hosted browser runs the CSLB license lookup, with the live view embedded in the inbox. Results are cached 24 h. | On timeout or failure the check is **"unverified"**; a license is never shown as verified unless CSLB returned it. |
| AgentID | Billing-agent sign-in (OIDC, PKCE) on the deployment whose redirect URI is registered. | Unlinked agents get "Agent not authorized". Each new deployment needs its redirect URI registered. |
| AgentMail | Inbox identity for billing agents; RFQ inboxes and outbound email for procurement. | The free plan is at its 3-inbox limit, so new trade packages reuse an existing inbox and the UI labels it **shared**. Inbound `/agentmail/webhook` requires `AGENTMAIL_WEBHOOK_SECRET` (Svix verification) and returns 503 when it is not set. |
| Firecrawl | Subcontractor discovery by web search, with per-record provenance. | When a search returns nothing usable, no records are created; records stay "Unverified" unless the source is a registry page. |
| AG Studio | Payments dashboard and chat agent with a STUDIO-PRO-AI trial license (expires 20 Nov 2026). | The chat agent needs the Anthropic key on the deployment (the `/ai/studio` proxy). |
| OpenAI, Gemini, Vertex | BYOK adapters in the procurement router (`convex/llmRouter.ts`). | Not configured on the TradePulse Pay deployment; procurement AI uses Anthropic or its deterministic fallback. |

---

## Tools used and how

| Tool | How TradePulse Pay uses it |
|---|---|
| **PayPal** | `@paypal/paypal-server-sdk@2.5.0` for Orders and Payments (`convex/payments/paypalClient.ts`, `orders.ts`); plain REST for Payouts, Invoicing v2 and webhook verification (`payouts.ts`, `invoices.ts`, `webhook.ts`); `@paypal/react-paypal-js@10.6.0` buttons for funding (`src/payments/FundMilestone.tsx`); `@paypal/agent-toolkit@1.11.0` read-only tools (`list_invoices`, `get_invoice`, `get_order`, `list_transactions`) wrapped for AI SDK v7 in `convex/agent/tools.ts`. |
| **Anthropic** | Claude through `ai@7` and `@ai-sdk/anthropic@4` for structured pay-app verdicts (`convex/payApps/review.ts`) and the pay agent tool loop (`convex/agent/`); the `/ai/studio` HTTP action proxies AG Studio chat to the Anthropic Messages API so the key stays server-side. |
| **AG Studio** | `ag-studio-react@3.0.0` and `ag-studio@3.0.0` render the lazy-loaded payments dashboard (`src/dashboard/`) from reactive Convex queries, with custom widgets and a "TradePulse pay agent" that delegates to AG's built-in agents. |
| **APIMatic** | The APIMatic Context Plugin (MCP) was queried while writing the PayPal Server SDK code. Every lookup and the code it informed is in [`docs/apimatic-log.md`](./docs/apimatic-log.md). It covers Orders and Payments only; the app never calls it at runtime. |
| **Postman** | A v2.1 collection and sandbox environment document every HTTP endpoint and PayPal call the app makes (see "API collection" below). |
| **KERNEL** | `@onkernel/sdk@0.119.0` creates a hosted browser, runs the CSLB lookup with Playwright and deletes the browser (`convex/kernel/`). |
| **AgentID / AgentMail** | AgentID is a custom OIDC provider in Convex Auth for billing-agent sign-in (`convex/auth.ts`, `convex/lib/agentAccess.ts`); AgentMail inboxes are the agents' identities, and AgentMail also powers the procurement RFQ inboxes (`@agentmail/convex`). |
| **Firecrawl** | `@firecrawl/firecrawl-convex` searches and scrapes contractor sites for subcontractor discovery (`convex/contractorDiscovery.ts`). |
| **Convex** | Database, queries, mutations, actions, HTTP router, crons (honor-period watcher), file storage, Convex Auth, and `convex-test` for the role-guard and money tests. |

---

## 📮 API collection (Postman) and APIMatic log

- Postman v2.1 collection: [`docs/postman/TradePulse-Pay.postman_collection.json`](./docs/postman/TradePulse-Pay.postman_collection.json), with the sandbox environment [`docs/postman/TradePulse-Pay-sandbox.postman_environment.json`](./docs/postman/TradePulse-Pay-sandbox.postman_environment.json). It covers `/api/health`, `/llms.txt`, an unsigned `/paypal/webhook` replay (documented 400, recorded `verified=false`, one row per event id), `/ai/studio`, and the PayPal sandbox calls the app makes (OAuth token, AUTHORIZE order, authorize, capture, void, payout, payout batch, invoice create/send/get, webhook signature verification). The environment file holds variable names only, with every value empty. Non-secret defaults (`convexSite` = the dev deployment `https://exuberant-boar-323.convex.site`, `paypalBase` = the PayPal sandbox, the replay event id, the payout `sender_batch_id` and the webhook auth algorithm) are collection variables, and a collection pre-request script uses them whenever the environment value is empty. Set your own values locally: `convexSite` for your deployment's `.convex.site` URL, and your sandbox `clientId` / `clientSecret` for the PayPal folder.
- Run the TradePulse endpoints from the CLI (pass `--env-var` for each value you set; drop the `convexSite` flag to use the dev default):

  ```bash
  npx -y newman run docs/postman/TradePulse-Pay.postman_collection.json \
    -e docs/postman/TradePulse-Pay-sandbox.postman_environment.json \
    --folder "TradePulse endpoints" \
    --env-var "convexSite=https://<deployment>.convex.site"
  ```

  The PayPal sandbox folder also needs `--env-var "clientId=$PAYPAL_CLIENT_ID" --env-var "clientSecret=$PAYPAL_CLIENT_SECRET"` (from your own shell; never commit them), plus `subPayPalEmail` / `ownerPayPalEmail` for the payout and invoice requests and the `webhook*` values for signature verification.
- APIMatic Context Plugin log: [`docs/apimatic-log.md`](./docs/apimatic-log.md). It lists the plugin tools queried and the Server SDK methods they informed. Plugin coverage is limited to Orders and Payments; Payouts, Invoicing and webhook verification use plain REST.

---

## Verification

Run from the repository root:

```bash
npx tsc -b                      # type-check, no output on success
npx vitest run --maxWorkers=2   # unit, convex-test integration and role-guard tests
npm run build                   # tsc + Vite production build into dist/
npm run verify:guards           # every public Convex function calls a role guard (table: docs/guard-audit.md)
npm run verify:docs             # README and docs links resolve, hackathon log is in order
npm run verify:reports          # the archived audit reports render offline (needs Chrome or Edge)
```

Against your deployment (needs `CONVEX_DEPLOY_KEY` in the shell, loaded as in [step 3](#3-convex-deployment-sandbox-setup); both target the deployment named in the key):

```bash
npx convex run demoAccounts:seedDemo '{}'   # idempotent; re-creates missing demo accounts
curl -s https://<deployment>.convex.site/api/health
```

The end-to-end check is the judge demo above, signed in as the demo GC.

To exercise the procurement award path instead, the internal fixture `procurementScenario:seedProcurementScenario` (args `{"suffix": "<letters-digits-hyphens>"}`, run with `npx convex run` as above) creates a fresh project with one Div 26 package in bid leveling, where sub1's contractor is invited (`tradePackages.invitedContractorIds`) next to a competing bidder. Nothing is awarded; the GC awards and executes it in the Procurement views. It never modifies existing contractors or agreements, and re-running with the same suffix returns the same rows.

### Legacy checks and scripts

These predate TradePulse Pay. They are kept for history, are not part of the checks above, and are not verification commands:

- **Legacy Python tests:** `tests/test_tradepulse.py` and `tests/verify_setup.py` (TradePulse Pro, September 2026). Nothing in `package.json`, Vitest or `scripts/` runs them.
- **Legacy, pre-auth Node scripts:** they call public Convex functions without signing in, or target the old hackathon deployment, and the role guards now refuse them. This covers `scripts/qa/live-smoke.mjs` (`npm run smoke:live`), `scripts/run-expert-evals.mjs` (`npm run evals`), `scripts/run-real-world-benchmark.mjs` (`npm run benchmark`), `scripts/verify-deep-real-world.mjs`, `scripts/verify-real-world-edge-cases.mjs`, `scripts/test-run-model-diagnostic.mjs`, `scripts/test-all-models-live.mjs`, `scripts/inspect-live-db.mjs`, `scripts/inspect-live-prod.mjs`, `scripts/verify-prod.mjs` and everything in `scripts/audit7/`. Each carries a "LEGACY, pre-auth script" header.

---

## TradePulse Pro procurement (the base app)

Signed in as the GC, the **Procurement** area is the original TradePulse Pro app: CSI MasterFormat scoping into trade packages, Firecrawl subcontractor discovery with provenance, AgentMail RFQ inboxes and pre-bid RFIs, forensic bid leveling (base bid + exclusions + lead-time and COI penalties − accepted VE alternates, computed in code), cross-trade scope clash detection, and A401-style subcontract drafts (not an official AIA form). Awarding and executing a contract there is what starts the TradePulse Pay flow. The September audits of that app are archived in [`docs/audits/`](./docs/audits/README.md).

---

## License

MIT License. See [`LICENSE`](./LICENSE).
