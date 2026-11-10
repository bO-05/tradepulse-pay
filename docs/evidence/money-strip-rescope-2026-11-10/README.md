# Money strip rescope evidence — 2026-11-10

## Result

The GC landing now leads with a Lopez Kitchen Remodel project strip, followed by a separately
labelled portfolio strip. The Lopez strip has five independent cells:

| Cell | Cents | Rendered |
| --- | ---: | ---: |
| Collected from homeowner | 480000 | $4,800.00 |
| Paid to subs | 380000 | $3,800.00 |
| Retainage you hold | 20000 | $200.00 |
| Retainage held from you | 40000 | $400.00 |
| Owed this week | 0 | $0.00 |

[query-reconciliation.json](query-reconciliation.json) records the live read-only query result and
the underlying paid Draw #1 ($3,600.00), paid change order ($1,200.00), Ortiz payout ($3,800.00),
sub-retainage row ($200.00), and owner-retainage figure ($400.00). Its independent recomputation
matches every query field and every rendered value. No settlement, seed, or demo-data write was run.

## Browser measurements

The shared GC release harness ran against `http://localhost:3150` with fresh-profile Puppeteer at
1440×900 and 390×844. It passed 102 checks with no failures. See [report.json](report.json).

- The Lopez strip is the first of two strips on `#/inbox`: top 333px at 1440 and 258px at 390.
- The five labels and values match at both widths. The portfolio strip keeps the neutral
  "Collected from owners" label and visibly names the separate commercial reference job at both
  widths. Its $17,070.40 paid-to-subs total is not in the Lopez strip.
- The 390px inbox and Lopez project page both measured `scrollWidth === clientWidth === 390`.
- The paid-receipt action remains the only primary on the GC landing.
- All five Lopez cell links resolved. The paid Draw #1, successful Ortiz payout, both retainage
  directions, and empty owed-this-week receipt set were checked. The direct paid change-order link
  opened "Add under-cabinet lighting" with Paid and $1,200.00.
- `consoleErrors`, `pageErrors`, and non-ignored `failedRequests` are empty at both widths. The
  report records the known aborted sign-in-options probe separately.

Captures include `hosted-inbox-1440.png`, `hosted-inbox-390.png`,
`hosted-lopez-change-order-receipt-1440.png`, the Lopez project and commercial comparison at both
widths, and the rest of the existing GC judge path. The filenames retain the shared harness's
`hosted-` prefix even though this run targeted localhost.

Agent-browser's shared authenticated pane did not complete the role switch, so the documented
fresh-profile Puppeteer fallback produced the measurements and captures. No visual/image pass was
performed; the screenshots are committed for independent review. Conclusions above come from DOM
text, computed routes, bounding boxes, and overflow measurements.

## Copy and accessibility gates

- [leak-scan/leak-scan.json](leak-scan/leak-scan.json): self-test passed; 0 app-copy hits on the
  eight core routes plus the demo landing.
- [a11y/report.md](a11y/report.md) and [a11y/report.json](a11y/report.json): 324/324 checks passed,
  0 serious/critical axe violations, 0 app-copy hits, and 32/32 states had exactly one primary.
  Screenshots cover both disclosure states at 1440 and 390.

## Programmatic checks on the change

- Scoped money-strip and query tests: 6 files, 48 tests passed.
- `npx tsc -b`: exit 0.
- Full `npx vitest run --maxWorkers=2`: 190 files, 2,288 tests passed.
- Guard audit: 269 public functions, 205 internal, 0 problems.
- `npm run build`: exit 0 (48.04s).
