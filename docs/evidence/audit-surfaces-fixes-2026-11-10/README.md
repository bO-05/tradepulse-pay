# Audit surface fixes — 2026-11-10

Evidence for the three scrutiny-round-1 blockers on the GC landing, project money strip, and owner project detail route.

## Result

- Commercial-only pending and paid-commercial (`A401-DEMO-PAY-20261105-07`) landing states each have exactly one visible primary action outside the collapsed commercial records. Opening the records does not add a competing primary.
- Commercial and portfolio money strips retain four cells and the previous commercial receipt wording. Only residential project strips render the fifth owner-retainage cell and new receipt suffix.
- `#/my-projects/q9751tqcjsbd11myp8x25c08hs8hdj94` renders the legacy change-order title without the stored `Judge demo:` prefix at both 1440px and 390px, with no horizontal overflow.
- The full Vitest suite passed: 194 files and 2,297 tests. Type checking and the production build passed.
- Closed and open-disclosure leak scans report zero app-copy hits. The open scan separately reports one unchanged raw rule key inside quoted recorded history.
- The accessibility/design harness passed 324/324 checks across 32 states, with zero serious/critical axe violations and exactly one primary per state.

## Directory guide

- `before-landing`, `before-landing-visibility`, and `before-owner-views` intentionally preserve failing baseline evidence. The literal stored prefix occurs only in these before-owner reports, not in the final application scans.
- `after-landing` covers both commercial landing states, collapsed/open records, primary-action visibility and target height.
- `after-owner-views` covers the owner project detail route and the existing owner views at desktop and mobile widths (112 checks, zero failures).
- `after-release-gc` covers the existing GC release sweep locally, including the four-cell portfolio strip (102 checks, zero failures).
- `leak-scan-closed` and `leak-scan-open` contain the final copy-leak reports.
- `a11y` contains the final accessibility/design report, measurements and screenshots.

Browser claims are based on DOM text, perceivable attributes, computed visibility, geometry, overflow and diagnostics. No separate visual screenshot-review pass was performed.
