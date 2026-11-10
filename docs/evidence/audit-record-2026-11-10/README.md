# Audit-record copy evidence

This evidence covers display-copy changes only. The review rule was not changed and no settlement,
capture, payout, invoice, seed or stored-data mutation was run.

## Stored record

`stored-record.json` is a fresh read-only Convex data capture of pay app
`ph7434a59sqck3nysgt6teqh0h8hvx1h`, joined to its schedule-of-values labels by `sovLineId`.
It preserves both stored review reasons and both stored GC decision reasons. The settled figures are
540000 requested, 200000 suggested, 400000 approved, 20000 retainage and 380000 net cents. Both billed
lines remain `overbilled`: Rough-in is 400000 requested / 200000 suggested / 400000 approved, and
Fixtures set is 140000 requested / 0 suggested / 0 approved.

## Browser checks

- `sub-payapp/report.json`: 80 checks passed at 1440x900 and 390x844. It captures the conservative
  review explanation, the kept Fixtures set cut, both flagged lines and their quoted recorded reasons,
  and the approval-history explanation. Screenshots are in the same directory.
- `demo/report.json`: 88 checks passed at both widths. The summary carries the conservative-review and
  recorded-override story with all four settled figures. All three role buttons fit the first viewport
  at 390px. Screenshots are in the same directory.
- `leak-scan/leak-scan.json` and `leak-scan-open/leak-scan.json`: eight core route visits plus the
  demo in closed and open disclosure modes, with zero app-copy hits in each. Quoted recorded-history
  blocks and their pre-existing internal strings are reported separately and were not rewritten.
- `a11y/report.md` and `a11y/report.json`: 324 checks passed across eight screens, two widths and
  closed/open disclosure states. Zero serious or critical axe violations, zero app-copy leak hits,
  exactly one primary action in all 32 states, and no horizontal overflow. Full-page and money-trail
  screenshots are in the same directory.

## Final validation

- Focused changed tests: 33 passed before the final text-only summary adjustment; the adjusted demo
  test file then passed 8 tests.
- Full suite: 195 files and 2306 tests passed with `npx vitest run --maxWorkers=2`.
- `npx tsc -b` and `npm run build`: passed.
- `node scripts/tools/guard-audit.mjs`: 269 public functions, 205 internal, zero problems.
- `npm run verify:docs`: 123 relative links resolved; hackathon log order passed.
- `npm run verify:agents`: passed.
- `git diff --check`: passed.

The browser evidence was captured with fresh-profile Puppeteer because the available browser session
could not resize or capture the hidden Factory tab. DOM measurements, computed styles, screenshots and
axe checks were collected. No separate image-based visual review was performed in this run.
