# GC landing priority evidence — 2026-11-10

Scope: VAL-LAND-001 through VAL-LAND-004. The before captures are from commit `5d29411`; the after
captures use the same dev data with only the client landing and QA harness changes. No demo records
were created, edited or deleted. Demo authentication was the only remote write.

## Measured outcome

| Viewport | Before page height | After collapsed page height | Reduction |
| --- | ---: | ---: | ---: |
| 1440×900 | 10,168 px | 1,175 px | 8,993 px (88.4%) |
| 390×844 | 18,434 px | 1,166 px | 17,268 px (93.7%) |

- The paid Ortiz primary action is exactly **View paid receipt**, linked to the settled pay app.
  Neither the featured card nor the expanded residential History entry offers an approve action.
- All residential records precede the commercial disclosure in DOM order. The single closed
  disclosure is **Commercial reference job (17)**. It contains 17 stored commercial records, none
  visible while collapsed and all 17 visible after expansion.
- Closed and expanded states each have exactly one visible filled primary action at both widths.
- `guided-runs-before.json` and `guided-runs-after.json` contain the same 11 guided runs. All six
  guided-run pay apps represented in this inbox are among the 17 commercial records. Runs without a
  pay app do not invent an inbox row.
- `inbox-record-verification.json` independently reads the 18 stored pay apps and confirms the DOM
  kinds, the 17/1 commercial/residential partition and Ortiz's stored `paid` status.

## Browser and gate results

- Fresh-profile `puppeteer-core` measurements at 1440×900 and 390×844. Zero page errors, console
  errors and unexpected failed requests; only the known aborted sign-in-options probe was ignored.
- `landing-nav-inbox-browser.mjs`: all checks passed, including paid History, commercial expansion,
  commercial search and mobile navigation.
- `release-hosted-gc-browser.mjs --url http://localhost:3150 --no-fresh-run`: 89 checks, 0 failures.
- `leak-scan.mjs`: 0 app-copy hits.
- `a11y-six-screens.mjs`: 324/324 checks, 0 serious/critical axe violations, 0 app-copy hits and
  32/32 states with exactly one primary.
- Full Vitest suite: 190 files / 2,286 tests passed. Type check and production build passed.

The shared `agent-browser` pane was already authenticated and did not complete a role reset, so the
repository's fresh-profile Puppeteer harness produced every capture and measurement. No image review
was performed; hierarchy and visibility claims come from DOM order, bounding boxes, computed classes,
page dimensions and rendered text.
