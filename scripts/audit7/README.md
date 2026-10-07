# Audit-6 repro harness (`scripts/audit7/`)

> **Legacy (pre-auth).** These scripts were written for TradePulse Pro before sign-in existed. They
> read public Convex functions without an identity, which the TradePulse Pay role guards now refuse,
> and they default to the old Convex hackathon deployment. They are kept for history and are not
> TradePulse Pay verification commands.

Portable, browser-driven reproduction scripts for the AUDIT-6 remediation (pass 3). Everything
here runs against the live deployment (or a local `npx convex dev` deployment) from a fresh clone
on Windows or macOS/Linux — no absolute paths, no secrets.

The **curated** scripts in this folder are the before/after repro set referenced by
`docs/audits/audit-6-remediation.md`. Round-by-round convergence scripts are intentionally
git-ignored (they remain in git history); only the reproducible repro harness is tracked.

## Requirements

- `npm ci` first (`puppeteer-core` ships in devDependencies)
- Node.js 18+
- Chrome or Edge installed (auto-detected; override with `QA_CHROME_PATH`)
- Network access to the deployment

## Scripts

| Script | What it reproduces |
|---|---|
| `lib.mjs` | Shared helpers: browser launch, UI actions (create project/package/contractor, ingest quote), backend reads via `ConvexHttpClient`, evidence writers, demo snapshot, fixture cleanup. |
| `a7-01-leadtime-before.mjs` | BEFORE-fix lead-time matrix (Div 22, N=12/16/17/20 plus a same-input repeat) with persisted values and rendered card text. |
| `a7-01b-leadtime-div26.mjs` | BEFORE-fix matrix on a Division 26 package (12-week baseline) to test the audit's $24,000/$30,000/$48,000 expectations. |
| `a7-02-discovery-rfq-before.mjs` | BEFORE-fix discovery quality (gov/union/directory imports) and RFQ toast-vs-audit contradiction. |
| `a7-03-award-contracts-before.mjs` | BEFORE-fix award/A401 contact probe (fabricated corpus contact and badge) and the "Record Execution Status" control investigation. |
| `a7-04-autoscope-before.mjs` | BEFORE-fix Auto-Scope single-click write with no parse echo. |
| `a7-05-after-leadtime.mjs` | AFTER-fix lead-time + banner + stable modal ids + TXT accept. |
| `a7-05b-after-rfq-ui.mjs` | AFTER-fix rendered arithmetic and RFQ delivery truth (toast/audit/card). |
| `a7-06-after-autoscope-discovery.mjs` | AFTER-fix Auto-Scope preview/confirm and discovery filtering. |
| `a7-07-after-contact.mjs` | AFTER-fix quote-created contact integrity and stated-amount pricing. |
| `a7-08-byo-proof.mjs` | BYO truth proof: own document upload/persistence, own GC identity in the draft, PM-gate refusal. |
| `inline-report.mjs` | Builds the self-contained Pass-3 report by base64-inlining the evidence screenshots (run from the repo root; writes `docs/audits/audit-6-remediation.html` and the timestamped copy under `doc/`). |

## Usage

```bash
# Lead-time matrix before/after, against the live deployment
node scripts/audit7/a7-01-leadtime-before.mjs
node scripts/audit7/a7-05-after-leadtime.mjs

# BYO proof (own documents/numbers) — creates and deletes an AUDIT7-* fixture
node scripts/audit7/a7-08-byo-proof.mjs

# Re-inline the report after regenerating evidence
node scripts/audit7/inline-report.mjs
```

Environment overrides: `REM_BASE_URL` (site), `QA_BACKEND_URL` (backend), `AUDIT7_EVIDENCE_DIR`
(evidence output, default `evidence/`), `QA_CHROME_PATH`.

## What the engine must compute (self-check values)

Lead penalty = `max(0, weeks − baseline) × $6,000`; baseline **12 weeks** for Division 26/other,
**16 weeks** for Division 22/23. Stated exclusion dollar amounts bind verbatim; unpriced scopes
take the documented benchmark (Div 22/26 crane 25,000/45,000; Div 23 crane 48,000; firestop
22,000; seismic 55,000; core drilling 16,000; backflow 8,500; booster 12,000; TAB 28,000; BACnet
18,000; vibration 14,000; overtime 25,000; default 15,000). COI deficiency is exactly **$15,000**
only when the proposal text withholds coverage; ingested VE alternates default to not accepted
and ingested exclusions default to not waived.

## Fixture policy

Any live check must create fixtures prefixed `AUDIT7-*` (or `AUDIT-*` for the generic QA harness)
and delete them before finishing. The seeded demo project (`The Domain Tower B - Commercial MEP`)
is shared and must never be written to; its headline numbers must stay byte-stable
(3 Pkgs / 4 Subs / 3 RFIs / 2 Bids / 4 Clashes, 1-of-3 awarded, $4,250,000 / $3,918,500 /
+$331,500 7.8% / +$186,000).

## See also

- `scripts/qa/README.md` — the curated, judge-runnable guarantee smoke (`live-smoke.mjs`) and offline report renderer.
- `docs/audits/audit-6-remediation.md` — the pass-3 report and the browser-only re-verification guide for the next auditor.