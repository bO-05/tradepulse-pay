# Judge-screen fixes evidence

Captured against the local app on `http://localhost:3150` at 1440x900 and 390x844 after the
`judge-screen-fixes` implementation. Read-only: the capture never approved, paid, signed or started a
guided run. Sandbox addresses are masked in the images and in `report.json`; `@demo.tradepulse`
accounts stay readable.

## Screens

| Screen | Route | Files |
| --- | --- | --- |
| Demo landing | `#/demo` | `demo-{width}.png`, `demo-{width}-first-viewport.png` |
| GC home | `#/inbox` | `gc-home-{width}.png`, `gc-home-{width}-first-viewport.png` |
| Lopez project | `#/all-projects/q97f6pmh2d5qn733jmh5pg4c3x8hr9sn` | `gc-project-{width}.png`, `gc-project-{width}-first-viewport.png` |
| Owner home | `#/projects` | `owner-home-{width}.png`, `owner-home-{width}-first-viewport.png` |
| Owner draw | `#/owner-pay-apps` | `owner-draw-{width}.png`, `owner-draw-{width}-first-viewport.png` |
| Change-order invoice | `#/change-orders/kx76mes3b4e7dt47qbv92tbav58httg0` | `change-order-{width}.png`, `change-order-{width}-first-viewport.png` |

`{width}` is `1440` or `390`. `report.json` records the box positions, font sizes, primary-action
census, rendered text, and console/page/network diagnostics. `chrome-scan.json` records the signed-in
identity chip on every screen at both widths. `console-and-network.txt` is the flat diagnostics log.

## Measured hierarchy

- **GC home:** the Ortiz/Lopez residential decision is the first card under "Needs your attention"
  (top 745 at 1440, 654 at 390). Its single filled 44px action, `Approve $4,000.00 and pay $3,800.00`,
  ends at 879 at 1440 and 788 at 390, both inside the first viewport. The first commercial Rosendin
  entry starts at 932 / 869. Exactly one primary action. The card text has no "Judge demo", raw
  `A401-…` id or `status` label.
- **Owner home:** `Paid to date $4,800.00` is the hero (top 497 at 1440, 582 at 390) with
  `$3,600.00 draw · $1,200.00 change order` beneath it. Balance to finish is a normal step below it.
  The old 8px "they do not move money" sentence is gone. The one-line read-only notice now sits below
  the money (top 702 / 995). One primary: `Open Draw #1`.
- **Owner draw:** `Paid this draw` / `$3,600.00` / `Paid by PayPal · Nov 8, 2026` in the trail. No
  "Current payment due" anywhere. One filled 44px `Open the PayPal receipt` ends at 648 / 607, inside
  the first viewport. The read-only notice sits below the trail (867 / 896).
- **Change-order invoice:** `$1,200.00` has `Paid` and `Paid Nov 8, 2026` beside it at both widths.
  The single filled 44px action reads `Open the PayPal receipt`; the timeline still starts with
  `Submitted`, but the paid amount card is the visible status beside the money.
- **Money strip (Lopez project):** `Collected from homeowner $3,600.00`, `Paid to subs $3,800.00`,
  `Retainage held $200.00` with `5% to the sub`, and `$400.00 at 10% from the homeowner`, so the
  $4,000 approved draw splits into the $400 owner hold and the $200 sub hold without opening the
  receipts panel. The project strip has one primary (`Open billing`) and the read-only notice below
  it (923 at 1440, 1094 at 390).
- **`#/demo`:** the only filled primary is the 118px `Sign in as the general contractor` seat; the
  other two seats are bordered secondary. The settled Lopez money line is at 201 / 393 and the seats
  all end inside the first viewport. The sandbox/defence sentence sits below the seats (667 / 853).
- **Identity chrome:** GC screens read `Bayview Remodeling · gc@demo.tradepulse`; owner screens read
  `Dana Lopez · owner@demo.tradepulse`. `chrome-scan.json` finds no `Austin Commercial` or
  `Domain Tower B` in the chrome on any of the seven checked screens.

No screen has horizontal overflow (`scrollWidth === clientWidth` everywhere), and every screen has
exactly one visible `bg-accent` primary action at both widths.
