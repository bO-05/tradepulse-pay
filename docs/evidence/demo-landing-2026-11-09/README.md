# Demo landing evidence (2026-11-09)

Feature `demo-landing` (VAL-JUDGE-001, VAL-JUDGE-002): `#/demo` now puts the three role buttons in the
first viewport and collapses every manual sandbox item into one disclosure. The Subcontractor seat is
the Ortiz account and lands on the settled Lopez pay app.

## Files

| File | What it shows |
| --- | --- |
| `before-1440.png`, `before-390.png` | Baseline before the change: seats began at y=237 (1440) and y=1362 (390), below the hero. |
| `demo-collapsed-1440.png`, `demo-collapsed-390.png` | New landing: seats are the first buttons and all three end inside the viewport (1440: 221–599, 390: 389–739). The manual disclosure is closed and titled exactly "Manual sign-in and sandbox details". |
| `demo-expanded-1440.png`, `demo-expanded-390.png` | The same disclosure expanded, showing the six items: password, test card, mirror URL, commit hash, Recovery-dev note, Studio license note. |
| `sub-payapp-1440.png`, `sub-payapp-390.png` | After clicking "Subcontractor": signed in as `sub4@demo.tradepulse` (Ortiz Plumbing) at `#/pay-apps/ph7434a59sqck3nysgt6teqh0h8hvx1h`, with the money trail (claimed $5,400.00 → net $3,800.00) and the PayPal payout receipt (batch `D5V7XEN5YZH4C`). |
| `gc-landing-1440.png`, `owner-landing-1440.png` | The GC seat still lands on `#/inbox` as `gc@demo.tradepulse`; the Owner seat still lands on `#/projects` as `owner@demo.tradepulse`. |
| `tenancy-report.json` | Read-only `npx convex run tenancyMigration:report '{}'`: `sub4@demo.tradepulse` belongs to Ortiz Plumbing (demo) and `sub1@demo.tradepulse` still belongs to Rosendin Electric (demo). |
| `report.json` | 74 checks with pass/fail, per-width measurements (including the `#/demo` link census), page/console errors, failed requests and the ignored `sign-in-options` aborts. |

## Reproduce

```powershell
cd "D:\Repo\ALL HACKATHONS\Devpost Hackathons\Paypal"
npm run dev                                          # Vite on 3150
node scripts/qa/demo-landing-browser.mjs --url http://localhost:3150 --out docs/evidence/demo-landing-2026-11-09
```

`report.json` records `checksRun: 74, failures: []`. The only ignored network entries are the
`/api/sign-in-options` requests that `AgentIdButton` aborts on unmount after sign-in; every other
request succeeded and no console or page error was recorded.

The settled pay app id is read from `SETTLED_LOPEZ_PAY_APP_ID` in `src/auth/demoSeats.ts`. If the
Lopez reference is ever settled again, update that constant and re-run the sweep.
