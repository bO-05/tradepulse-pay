# TradePulse Pro ⚡

> **Autonomous CSI MasterFormat Subcontractor Procurement, Dynamic Pre-Bid Q&A & Real-Time Bid Leveling for Commercial Construction**

[![Convex All Gas Hackathon](https://img.shields.io/badge/Convex-All%20Gas%20Hackathon-f59e0b?style=for-the-badge&logo=convex)](https://vibeapps.dev/judging/convex-all-gas-hackathon-openai)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-brainy--skunk--440.convex.site-10b981?style=for-the-badge)](https://brainy-skunk-440.convex.site)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18.3.1-61dafb?style=for-the-badge&logo=react)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-3.4.19-38bdf8?style=for-the-badge&logo=tailwindcss)](https://tailwindcss.com/)

---

## 🌐 Live Access & Deployment

| Resource | URL |
| :--- | :--- |
| **Official Web Application** | **[https://brainy-skunk-440.convex.site](https://brainy-skunk-440.convex.site)** |
| **LLMs Discoverability Manifest** | **[https://brainy-skunk-440.convex.site/llms.txt](https://brainy-skunk-440.convex.site/llms.txt)** |
| **Convex Cloud Production Backend** | **[https://brainy-skunk-440.convex.cloud](https://brainy-skunk-440.convex.cloud)** |
| **AgentMail Live Webhook Endpoint** | **[https://brainy-skunk-440.convex.site/agentmail/webhook](https://brainy-skunk-440.convex.site/agentmail/webhook)** |

---

## 🎯 The Problem: The $186,000 Scope Exclusion Trap

In commercial construction (hospitals, labs, towers), General Contractors (GCs) solicit bids from trade subcontractors (Electrical, HVAC, Plumbing). Subcontractors frequently submit **deceptive low bids** on paper ($1,100,000 vs $1,225,000), but hide critical exclusions in fine print:
- Excluded crane hoisting to penthouse mechanical rooms (+$45,000 GC cost)
- Excluded UL 1479 rated firestop penetrations (+$22,000 GC cost)
- Excluded seismic engineered structural bracing (+$55,000 GC cost)
- Non-compliant Certificate of Insurance ($1M limit vs required $5M, +$15,000 penalty)
- 16-week long-lead equipment delays (+$24,000 schedule delay impact)

When GCs award purely based on base price, they suffer **six-figure change orders** and schedule blowouts. Furthermore, trades frequently **double-buy equipment** (e.g. both Division 26 Electrical and Division 23 HVAC bidding Variable Frequency Drives — a **$38,500 VFD line item**, part of the demo's **$50,500 total double-buys**, alongside $46,500 in scope voids) or leave **scope voids** (e.g. low-voltage control wiring excluded by both).

---

## ⚡ Solution: TradePulse Pro

TradePulse Pro automates the entire MEP subcontractor buyout lifecycle end-to-end:
1. **CSI MasterFormat Scoping**: Auto-parses architectural specifications into Division 26 (Electrical), Division 23 (HVAC), and Division 22 (Plumbing) packages with dedicated `@agentmail.to` inboxes.
2. **Autonomous Subcontractor Discovery (Firecrawl)**: Searches regional contractor sites for candidate bidders and records the provenance of every data point. License numbers, phone numbers and emails are only stored when the source actually publishes them; records are labeled "Unverified" unless the source itself is a state registry page.
3. **Dynamic Pre-Bid Q&A (AgentMail & OpenAI)**: Ingests subcontractor email RFIs via AgentMail with cryptographic Svix verification, answers technical questions against the spec, and compiles binding **CSI Addendum No. 01** documents stored in Convex File Storage (`_storage`).
4. **Forensic Bid Leveling Engine (ADR-0003)**: Automatically parses proposals, normalizes hidden exclusions, applies lead-time delay adjustments and COI penalties, and accounts for Value Engineering (VE) alternates.
5. **Cross-Trade Scope Clash Engine**: Detects Double-Buys and Scope Voids between electrical and mechanical trades with 1-click buyout deductions.
6. **A401-Style Contract Draft Generator**: Instantly produces a standard 10-article subcontract draft following the AIA A401 article structure (explicitly labeled as not an official AIA-licensed form) with financial attestations, retainage terms, and liquidated damages.

---

## 🏛️ Architecture & Sponsor Synergy Matrix

TradePulse Pro deeply integrates all 4 hackathon sponsors:

```mermaid
graph TD
    A[CSI 3-Part MasterFormat Specs] -->|AI Spec Breakdown| B(Convex Trade Packages)
    B -->|Firecrawl Web Crawler| C[Licensed Contractor Directory]
    B -->|AgentMail API| D[Dedicated Package Inboxes]
    C -->|Outbound RFQ Invites| D
    D -->|Svix Cryptographic Webhook| E[Convex HTTP Router]
    E -->|Pre-Bid Inquiries| F[OpenAI Pre-Bid RFI Engine]
    F -->|Binding Addenda| G[Convex File Storage _storage]
    E -->|Quote Proposals| H[ADR-0003 Bid Leveling Engine]
    H -->|A401-Style Draft Generator| I[Subcontract Agreement Drafts]
    H -->|Cross-Trade Clash Detection| J[Double-Buy & Scope Void Resolver]
```

### 1. Convex (All-Gas Full-Stack Reactive Backend)
* **Real-time WebSockets**: Zero-polling reactive UI updates across all bidders, RFIs, leveling matrices, and audit streams (`useQuery`, `useMutation`).
* **Convex Crons (`convex/crons.ts`)**: Scheduled hourly bid deadline sweeps (`monitor-bid-deadlines`) and 6-hour contractor compliance audits (`audit-contractor-compliance`).
* **Convex File Storage (`_storage`, `convex/files.ts`)**: Secure persistence for CSI specs, BIM drawing PDFs, ACORD 25 COIs, and generated Addenda.
* **Official Static Hosting (`@convex-dev/static-hosting`)**: Unified single-command deployment with production SPA fallback and Wayne Sutton `/llms.txt` discoverability.

### 2. OpenAI & Multi-Model Pipeline (`convex/llmRouter.ts`)
* **GPT-4o Spec Scoping & Pre-Bid RFI Analysis**: Technical inquiry extraction against Division 26/23 specifications.
* **Structured Bid Parsing**: Extracts line items, quantities, unit prices, exclusions, and VE alternates.
* **Multi-Model Support**: Google Gemini and Anthropic Claude run the live pipeline today; OpenAI GPT-4o is a **BYOK adapter** that activates the moment an `OPENAI_API_KEY` is configured (the hackathon provides no OpenAI API credits). A deterministic offline construction-intelligence fallback keeps the pipeline alive even with no provider keys at all.

### 3. Firecrawl (`@firecrawl/firecrawl-convex`, `convex/contractorDiscovery.ts`)
* **Subcontractor Web Discovery**: Autonomous discovery of MEP specialty contractors by location and trade division.
* **Provenance-First Records**: Scrapes contractor domains for published contacts and license numbers and labels each record with its source. Nothing is presented as state-verified unless a registry page was actually the source.

### 4. AgentMail (`@agentmail/convex`, `convex/emailActions.ts`, `convex/http.ts`)
* **Dedicated Project Inboxes**: Auto-provisions `@agentmail.to` inboxes per CSI trade package (Div 26 Electrical, Div 23 HVAC, Div 22 Plumbing) on the AgentMail free tier. When the plan's inbox limit is reached, new packages reuse an existing inbox and the UI labels it as shared instead of claiming a dedicated address.
* **Cryptographic Svix Verification**: Validates `svix-id`, `svix-timestamp`, and `svix-signature` on inbound emails at `/agentmail/webhook`.
* **Two-Way Communication**: Transmits outbound invitations to bid and ingests inbound contractor RFIs and quote proposals directly into the Convex pipeline.

---

## 📊 The ADR-0003 Normalization Formula

$$\text{Leveled Total Cost} = \text{Base Bid} + \sum(\text{Active Exclusions}) + \text{Lead Time Penalty} + \text{COI Deficiency Penalty} - \sum(\text{Accepted VE Alternates})$$

The lead-time term is deterministic: the engine extracts the bidder's lead time in weeks and computes
`max(0, weeks − baseline) × $6,000` in code (Division 26 baseline: 12 weeks; Divisions 22/23: 16 weeks),
rendering the arithmetic on the leveling card. The model never returns a dollar penalty.

### The Alterman vs. Rosendin Electric Case Study:
* **Alterman, Inc.**:
  * Base Bid: $\$1,100,000$ *(Looks like the lowest bidder!)*
  * Crane Hoisting Excluded: $+\$45,000$
  * UL 1479 Firestopping Excluded: $+\$22,000$
  * Seismic Bracing Excluded: $+\$55,000$
  * Schedule Lead Time Penalty (16 wks vs the Division 26 12-wk baseline @ \$6,000/wk, computed in code): $+\$24,000$
  * COI Penalty (\$1M policy vs \$5M required): $+\$15,000$
  * **Normalized Leveled Cost: $\$1,286,000$**
* **Rosendin Electric, Inc.**:
  * Base Bid: $\$1,225,000$
  * Exclusions: $\$0$ *(All mandatory inclusions covered)*
  * VE Alternate 01 (Aluminum MC feeder cable): $-\$35,000$ *(Optional GC savings)*
  * **Normalized Leveled Cost: $\$1,225,000$ (or $\$1,190,000$ with VE accepted)**
* **Financial Decision**: Awarding Rosendin Electric saves the GC **$\$61,000$ to $\$96,000$** and prevents catastrophic site delays.

---

## 🔐 Sign-in and Demo Accounts (TradePulse Pay)

TradePulse Pay requires sign-in (Convex Auth, email + password). Signed-out visitors only see the sign-in page; `/llms.txt` and `/api/health` stay public. Self sign-up is disabled: accounts come from the demo seed.

All demo accounts share the public demo password **`TradePulseDemo!2026`**.

| Account | Role | What it sees |
|---|---|---|
| `gc@demo.tradepulse` | General contractor | Everything: procurement (award, execute, reset, 1-click demo) and the projects overview |
| `sub1@demo.tradepulse` | Subcontractor | Only Rosendin Electric's agreements and pay applications |
| `sub2@demo.tradepulse` | Subcontractor | Only TDIndustries' agreements and pay applications |
| `sub3@demo.tradepulse` | Subcontractor | Only Clarke Kent Plumbing's agreements and pay applications |
| `owner@demo.tradepulse` | Owner | Read-only projects, agreements and change-order invoices; no award, approve or fund controls |

Sub and owner PayPal sandbox emails are read from the Convex environment (`PAYPAL_SANDBOX_SUB{1,2,3}_EMAIL`, `PAYPAL_SANDBOX_OWNER_EMAIL`) when the seed runs; they are not stored in this repository.

Setup on a Convex deployment (idempotent; prints names only, never values):

```bash
bash scripts/sync-convex-env.sh            # app env, including SITE_URL
bash scripts/setup-convex-auth-keys.sh     # JWT_PRIVATE_KEY + JWKS (skips if already set)
npx convex dev --once                      # push functions
npx convex run demoAccounts:seedDemo '{}'  # demo project (if missing) + demo accounts + role profiles
```

### Agreement ledger totals

The ledger (`#/payments/<agreementId>`) shows these totals, all in integer cents formatted as dollars:

- **Paid** = net of successful payouts plus successful retainage releases.
- **Retainage held** = balance of the retainage ledger (credits on accepted payouts, debits on releases).
- **Balance** = contract sum − (paid + retainage held). The same formula is printed under the totals.
- Reconciliation row: funded but not captured, captured, captured but not paid out (for example a failed payout waiting for "Retry payout"), retainage released, and change orders invoiced and paid.

Funded authorizations are watched hourly (`convex/crons.ts`): after the 3-day honor period they are reauthorized once, and an authorization that reaches its expiry marks the milestone "Funding expired" so it can be funded again.

---

## ⚡ 60-Second Judge Evaluation Walkthrough

Want to experience the complete platform in 60 seconds?
1. Open the live deployment: **[https://brainy-skunk-440.convex.site](https://brainy-skunk-440.convex.site)**.
2. In the top navigation bar, click the glowing **⚡ 60s Judge Dock** button.
3. Click **"⚡ 1-Click Run Full Autonomous Procurement Lifecycle"**:
   * Watch the live Activity Audit Stream log every step in real-time.
   * Scopes Division 26 Electrical, 23 HVAC, and 22 Plumbing.
   * Discovers contractors and provisions AgentMail inboxes.
   * Clarifies RFIs and generates binding CSI Addendum No. 01.
   * Compares bids in the ADR-0003 Side-by-Side Leveling Matrix.
   * Awards Rosendin Electric and generates an **A401-style subcontract draft** (follows the AIA A401 article structure; not an official AIA-licensed form).
4. Click **Scope Clash Engine**: Review cross-trade coordination catching the **$38,500 VFD Double-Buy** and click **"Deduct Credit"**.

---

## 🛠️ Local Development & Testing

### Prerequisites
* Node.js v20+
* Python 3.10+ (for verification test suites)

### Setup
```bash
# Clone the repository
git clone https://github.com/bO-05/tradepulse-pro.git
cd tradepulse-pro

# Install exact locked dependencies (npm install also works)
npm ci

# Run frontend development server
npm run dev
# -> http://localhost:5173/

# Run Convex local backend
npx convex dev
```

### Verification & Testing
```bash
# Build the frontend first (a fresh clone has no dist/ yet; the Python suite checks it)
npm run build

# 36 domain, sponsor, and architecture deliverable tests -> expect 36/36 PASS
python tests/test_tradepulse.py

# Hackathon setup and log verification -> expect ALL VERIFICATION TESTS PASSED
python tests/verify_setup.py

# Unit + integration tests -> expect 113/113
npx vitest run

# Type-check -> expect no output, exit 0
npx tsc -b

# Docs integrity (links + log order) and offline rendering of the curated reports
npm run verify:docs
npm run verify:reports

# Live guarantee smoke against the deployment (creates and deletes one AUDIT-* fixture)
npm run smoke:live
```

---

## 🧾 Audits & Verification

The full audit trail lives in [`docs/audits/`](./docs/audits/README.md) — self-contained HTML reports
(open by double-click, no network needed):

| Report | What it covers |
| :--- | :--- |
| [audit-1-ux.html](./docs/audits/audit-1-ux.html) | First UX audit of the deployed app. |
| [audit-2-user-journey.html](./docs/audits/audit-2-user-journey.html) | Five-persona user-journey audit (BUG-01…BUG-36). |
| [audit-3-adversarial.html](./docs/audits/audit-3-adversarial.html) | Independent audit v3 with adversarial passes (AUD-01…AUD-05). |
| [audit-4-ui.html](./docs/audits/audit-4-ui.html) | Human-operator UI audit (F1…F12). The [.md copy](./docs/audits/audit-4-ui.md) is machine-readable. |
| [audit-5-remediation.html](./docs/audits/audit-5-remediation.html) | Remediation pass 2: F1–F12 verification table, new findings, claim-change decisions, convergence log, before/after evidence. |
| [audit-6-usefulness.html](./docs/audits/audit-6-usefulness.html) / [.md](./docs/audits/audit-6-usefulness.md) | Independent adversarial usefulness audit (AUDIT-6) of the live app: demo + BYO verdicts, C1–C15 claims, A6-xx findings. |
| [audit-6-remediation.html](./docs/audits/audit-6-remediation.html) / [.md](./docs/audits/audit-6-remediation.md) | Remediation pass 3: reproduction status for every A6-xx, before/after evidence, 25 convergence rounds, decisions, BYO proof, regression output, and a browser-only re-verification guide. |

**Current state (audit 6 remediation, pass 3).** Every AUDIT-6 finding was reproduced live before
fixing; the one that no longer reproduces is marked UNREPRODUCED rather than "fixed." The core
claim now holds deterministically: the lead-time penalty is computed in code from the extracted
weeks and a GC-owned division baseline (12 wks Div 26 / 16 wks Div 22–23), persisted per bid with
the baseline, and rendered as auditable arithmetic. Stated exclusion amounts bind positionally,
unpriced scopes take division-correct benchmarks, COI is a text-driven $15,000 in both directions,
and VE/waiver acceptance is GC-only. Identical input twice is byte-identical live (repeated-ingest
sha checks). Regression is green: `npx tsc -b` clean, `npx vitest run` 113/113,
`python tests/test_tradepulse.py` 36/36, `python tests/verify_setup.py`, `npm run verify:docs`,
`npm run verify:reports`, `npm run smoke:live` 7/7. The BYO journey was re-run end to end with our
own spec, numbers, and documents, then cleaned up (only the demo project remains). Live
verification harness: [`scripts/qa/`](./scripts/qa/README.md).

---

## 📄 License
MIT License. Built for the Convex All Gas Hackathon 2026.
