# Judge-experience round-1 fixes (2026-11-09)

Fixes the four blocking findings in `validation/judge-experience/scrutiny/synthesis.json` round 1.
No schema, route, data-testid or money-math change; no stored row was edited.

## 1. Owner draw documents empty state is kind-keyed

- `src/documents/DocumentDownload.tsx` — `ProjectDocumentsList` accepts the project's kind and its
  empty description is kind-keyed. Residential: "PDFs and CSV exports appear here once someone
  downloads them from a pay app, draw, change order or subcontract." Commercial (and a missing
  kind): the original string, byte-for-byte.
- `src/billing/OwnerBilling.tsx` — the owner draw passes `list.projectKind`.
- Rendered text captured in the live run (`report.json`, Owner draw pageText):
  "No documents yet PDFs and CSV exports appear here once someone downloads them from a pay app,
  draw, change order or subcontract. Download this draw's PDF"; lowercase "owner pay app" is
  absent.

## 2. Sub pay-app retainage comes from the stored summary

- `src/billing/PayAppMoneyTrail.tsx` — the period retainage is `summary.retainageCents`, the stored
  G702 figure for the view's basis (requested until the GC decides, approved after). The old
  `(approvedGrossCents ?? reviewSuggestedTotalCents) - summary.currentPaymentDueCents` derivation is
  gone.
- Reviewed / revision-requested / rejected states render that stored figure with the note
  "Not withheld yet" and the footer "Retainage on this draw: $270.00. Not withheld yet; the GC has
  not approved this draw." No negative figure.
- The paid reference is unchanged: the live page reports
  "Total retainage held to date: $200.00. This draw withheld $200.00." (sub-pay-app state in
  `report.json`; the same line is pinned in `docs/evidence/sub-payapp-design-2026-11-09/report.json`).

## 3. Both harnesses cover screen 3's second route

`node scripts/qa/leak-scan.mjs --url http://localhost:3150 --out docs/evidence/judge-experience-fixes-2026-11-09`

- 8 core screen visits on 8 routes + `#/demo`; the GC owner-billing tab is scanned with the Lopez
  project selected at **1440 and 390**.
- Self-test PASS; 0 app-copy hits; 4 quoted recorded-history blocks with 0 banned strings in the
  closed run. Exit 0.
- Open-disclosure run (`--open-disclosures`): 0 app-copy hits, 12 disclosures opened, 16 quoted
  blocks with the one known raw rule key in the GC inbox's recorded history (reported, never
  rewritten). Exit 0.

`node scripts/qa/a11y-six-screens.mjs --url http://localhost:3150 --out docs/evidence/judge-experience-fixes-2026-11-09`

- 8 screens (demo + six judge screens with screen 3 twice) x 2 viewports x 2 disclosure states.
- **324 checks run, 324 passed, 0 failed**; 0 serious/critical axe violations; 0 app-copy hits;
  **32/32 states with exactly one primary**.
- The Lopez owner-billing tab (`#/billing/owner-billing`, Lopez selected through
  `owner-billing-project`) passes every check at 1440 and 390, closed and open: one primary
  (`owner-pay-app-new` "New draw", 44px), 0 targets under 24px, no overflow
  (1440/1440 and 390/390), 0 axe serious/critical, 0 app-copy hits, 0 page/console errors.

## Design-sweep regression checks (written to their own tracked evidence dirs)

- `scripts/qa/owner-views-design-browser.mjs` — 102/102 checks, 0 failures; refreshed
  `docs/evidence/owner-views-design-2026-11-09/` (the report now carries the new documents
  sentence and no longer the old one).
- `scripts/qa/sub-payapp-design-browser.mjs` — 68/68 checks, 0 failures; refreshed
  `docs/evidence/sub-payapp-design-2026-11-09/` (paid retainage line unchanged).
- `scripts/qa/landing-nav-inbox-browser.mjs` — `ok: true`, empty pageErrors/consoleErrors.

## Files

- `a11y-scan.txt`, `report.json`, `report.md` — the six-screen gate; 44 screenshots named by
  screen and width.
- `leak-scan.txt`, `leak-scan.json` — closed-disclosure run.
- `leak-scan-open-disclosures.txt/json` — open-disclosure run.

The copy-leak-sweep evidence dir also holds a refreshed closed/open leak-scan run so the
VAL-COPY-001 artifact reflects the added route.

Droid cannot view image files: no visual pass was performed by the worker. Hierarchy claims above
come from computed measurements in `report.json`, and the orchestrator runs the independent image
review.
