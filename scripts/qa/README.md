# Quality harness (`scripts/qa/`)

> **Legacy (pre-auth).** `live-smoke.mjs` calls public Convex functions without signing in, which the
> TradePulse Pay role guards now refuse, so `npm run smoke:live` no longer passes. It is kept for history
> and is not a TradePulse Pay verification command. `render-audit-reports.mjs` (`npm run verify:reports`)
> works offline and is unaffected.

Portable, judge-runnable verification for the TradePulse Pro deployment. Everything here
works from a fresh clone on Windows or macOS/Linux — no absolute paths, no secrets.

## Requirements

- `npm ci` first (`puppeteer-core` ships in devDependencies)
- Node.js 18+
- Chrome or Edge installed (auto-detected; override with `QA_CHROME_PATH`)
- Network access to the live deployment (or a local `npx convex dev` deployment)

## Scripts

| Script | What it does |
|---|---|
| `live-smoke.mjs` | Creates one `AUDIT-QA-SMOKE-*` project on the backend and asserts the remediation guarantees end-to-end: RFI persisted before AI analysis, cross-trade credit evidence gate + idempotency + reversal, executed-subcontract immutability, audited void path. Deletes everything it created and exits non-zero on any failure. |
| `render-audit-reports.mjs` | Opens every report in `docs/audits/` in headless Chrome (offline `file://`) and fails if any image is broken or any page error occurs. Proves judges can double-click the reports. |
| `lib.mjs` | Shared helpers (portable repo root, browser launch, diagnostics, screenshots, input helpers). |

## Usage

```bash
# Full guarantee smoke against the live deployment
node scripts/qa/live-smoke.mjs

# Against a local Convex dev deployment
QA_BACKEND_URL=http://127.0.0.1:3210 node scripts/qa/live-smoke.mjs

# Prove the curated audit reports render offline
node scripts/qa/render-audit-reports.mjs
```

Environment overrides: `QA_BACKEND_URL`, `REM_BASE_URL` (site), `REM_EVIDENCE_DIR`
(screenshot output, default `evidence/`), `QA_CHROME_PATH`, `QA_REPO_ROOT`.

## Report/evidence tooling (`scripts/tools/`)

- `check-docs-links.mjs` — fails on any broken relative link in shipped docs (`node scripts/tools/check-docs-links.mjs docs README.md`).
- `compress-report-images.ps1` (Windows PowerShell, optional) — shrinks self-contained audit HTMLs (embedded PNG → resized JPEG) and standalone screenshot folders for repo-friendly reports.
- `reorder-hackathon-log.mjs` — keeps `hackathon.md` strictly chronological (oldest first, newest appended last, per the project log-format reference); run with `--check` in CI/verification.

## Fixture policy

Any live check must create fixtures named `AUDIT-*` and delete them before finishing. The
seeded demo project (`The Domain Tower B - Commercial MEP`) is shared and is never modified.