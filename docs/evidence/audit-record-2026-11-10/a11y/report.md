# Accessibility and cross-screen design gate

- Target: http://localhost:3150
- Generated: 2026-11-10T09:47:30.512Z
- axe-core: 4.14.0
- Screens: 8 visits (demo + six judge screens; screen 3 in both of its routes), at 1440x900 and 390x844
- Checks: 324 run, 0 failed
- Serious/critical axe violations: 0
- App-copy leak hits: 0

| Screen | Width | State | axe serious/critical | primaries | min target | <24px | leak hits | overflow |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Demo landing | 1440 | closed | 0 | 1 | 24 | 0 | 0 | no |
| Demo landing | 1440 | open | 0 | 1 | 24 | 0 | 0 | no |
| Demo landing | 1440 | manual-open | 0 | 1 | 24 | 0 | — | no |
| Demo landing | 390 | closed | 0 | 1 | 24 | 0 | 0 | no |
| Demo landing | 390 | open | 0 | 1 | 24 | 0 | 0 | no |
| Demo landing | 390 | manual-open | 0 | 1 | 24 | 0 | — | no |
| GC home | 1440 | closed | 0 | 1 | 24 | 0 | 0 | no |
| GC home | 1440 | open | 0 | 1 | 24 | 0 | 0 | no |
| GC home | 390 | closed | 0 | 1 | 24 | 0 | 0 | no |
| GC home | 390 | open | 0 | 1 | 24 | 0 | 0 | no |
| Lopez project page | 1440 | closed | 0 | 1 | 24 | 0 | 0 | no |
| Lopez project page | 1440 | open | 0 | 1 | 24 | 0 | 0 | no |
| Lopez project page | 390 | closed | 0 | 1 | 24 | 0 | 0 | no |
| Lopez project page | 390 | open | 0 | 1 | 24 | 0 | 0 | no |
| Lopez owner billing | 1440 | closed | 0 | 1 | 24 | 0 | 0 | no |
| Lopez owner billing | 1440 | open | 0 | 1 | 24 | 0 | 0 | no |
| Lopez owner billing | 390 | closed | 0 | 1 | 24 | 0 | 0 | no |
| Lopez owner billing | 390 | open | 0 | 1 | 24 | 0 | 0 | no |
| Sub pay app | 1440 | closed | 0 | 1 | 24 | 0 | 0 | no |
| Sub pay app | 1440 | open | 0 | 1 | 24 | 0 | 0 | no |
| Sub pay app | 390 | closed | 0 | 1 | 24 | 0 | 0 | no |
| Sub pay app | 390 | open | 0 | 1 | 24 | 0 | 0 | no |
| Owner home | 1440 | closed | 0 | 1 | 24 | 0 | 0 | no |
| Owner home | 1440 | open | 0 | 1 | 24 | 0 | 0 | no |
| Owner home | 390 | closed | 0 | 1 | 24 | 0 | 0 | no |
| Owner home | 390 | open | 0 | 1 | 24 | 0 | 0 | no |
| Owner draw | 1440 | closed | 0 | 1 | 24 | 0 | 0 | no |
| Owner draw | 1440 | open | 0 | 1 | 24 | 0 | 0 | no |
| Owner draw | 390 | closed | 0 | 1 | 24 | 0 | 0 | no |
| Owner draw | 390 | open | 0 | 1 | 24 | 0 | 0 | no |
| Change-order invoice | 1440 | closed | 0 | 1 | 24 | 0 | 0 | no |
| Change-order invoice | 1440 | open | 0 | 1 | 24 | 0 | 0 | no |
| Change-order invoice | 390 | closed | 0 | 1 | 24 | 0 | 0 | no |
| Change-order invoice | 390 | open | 0 | 1 | 24 | 0 | 0 | no |

## Evidence artifacts

- `report.json` — every check, the full measured target population per screen/width/state (tag, test id, text, height), the named primary with its classes, axe violations and leak hits.
- `<screen>-<width>-closed.png` and `<screen>-<width>-open.png` — full-page screenshots with disclosures closed and open.
- `<screen>-<width>-manual-open.png` — the demo manual block opened (leak-exempt, still axe-checked).
- `lopez-project|sub-pay-app|owner-home|owner-draw-<width>-money-trail.png` — the shared money trail on its surface.
- `gc-home-<width>-empty.png` — the reachable inbox empty state.

## Named primary actions

- **Demo landing** (#/demo): `demo-enter-gc` "Sign in as the general contractor→Review a sub's pay app and release s" 118px
- **GC home** (#/inbox): `inbox-residential-decision-action` "View paid receipt" 44px
- **Lopez project page** (#/all-projects/q97f6pmh2d5qn733jmh5pg4c3x8hr9sn): `(no test id)` "Open billing" 44px
- **Lopez owner billing** (#/billing/owner-billing): `owner-pay-app-new` "New draw" 44px
- **Sub pay app** (#/pay-apps/ph7434a59sqck3nysgt6teqh0h8hvx1h): `payapp-view-payments` "View payments" 44px
- **Owner home** (#/projects): `owner-home-open-draw` "Open Draw #1" 44px
- **Owner draw** (#/owner-pay-apps): `owner-invoice-payer-link` "Open the PayPal receipt" 44px
- **Change-order invoice** (#/change-orders/kx76mes3b4e7dt47qbv92tbav58httg0): `change-order-invoice-link` "Open the PayPal receipt" 44px

## Failures

None.

## Quoted recorded history (reported, never rewritten)

- GC home @1440: closeoutWorkBeforeEarlierTranches: `closeoutWorkBeforeEarlierTranches` — e work (testing, commissioning, O&M) claimed at 10% this period while closeoutWorkBeforeEarlierTranches is true; no new progress is allowed, so previous 0% is recommended. R
- GC home @390: closeoutWorkBeforeEarlierTranches: `closeoutWorkBeforeEarlierTranches` — e work (testing, commissioning, O&M) claimed at 10% this period while closeoutWorkBeforeEarlierTranches is true; no new progress is allowed, so previous 0% is recommended. R
