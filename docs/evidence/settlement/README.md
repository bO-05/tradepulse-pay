# Lopez residential settlement — sandbox evidence

One-time PayPal **sandbox** settlement of the Lopez Kitchen Remodel reference job, run on
2026-11-08 against deployment `dev:cheery-axolotl-689`. No real money moved.

Machine-readable report: [`settlement-report.json`](./settlement-report.json). It records every step,
the PayPal order/authorization/capture/payout ids, integer cents, and the stored rows behind the
money-strip cells. It contains no tokens, cookies, auth frames, card fields or unmasked payee emails.

## Result in one line

Rough-in funded by a real sandbox AUTHORIZE (`$4,000.00`, authorization `24P9856593499503V`); Ortiz's
`$5,400.00` pay app was flagged, the Fixtures set line was cut by exactly `$1,400.00` to `$0.00`, the
conditional waiver was signed with recorded evidence, the capture and payout settled gross `$4,000.00`
/ retainage `$200.00` / net `$3,800.00` (batch `D5V7XEN5YZH4C`); owner Draw #1 was invoiced and paid
(`$3,600.00`, invoice `INV2-5ZNS-USY8-KBFD-L3B9`) and the `$1,200.00` under-cabinet-lighting change
order was invoiced and paid (invoice `INV2-RCJ4-Z8GD-4A33-TDJC`).

## Screenshots

| File | Shows |
| --- | --- |
| `01-rough-in-funded.png` | Rough-in milestone authorized at PayPal |
| `02-review-flagged.png` | Rules review flagging the Fixtures set line before approval |
| `03-approved.png` | Approval as noted, line 1 at `$4,000.00`, line 2 at `$0.00` with reasons |
| `05-waiver-signed.png` | Signed conditional waiver for `$4,000.00`, through Oct 15, 2026 |
| `06-payout-receipt.png` | Payout receipt: `$4,000.00` gross, `$200.00` retainage, `$3,800.00` net |
| `08-draw-created.png` | Owner Draw #1 submitted, `$86,500.00` scheduled values |
| `10-draw-paid.png` | Owner Draw #1 paid |
| `11-co-created.png` | Prime change order submitted for `$1,200.00` |
| `12-co-paid.png` | Prime change order paid |
| `13-sub-payapp-paid.png` | Ortiz's view: `Paid $3,800.00`, `$200.00` retainage held |
| `15-owner-billing.png` | GC owner-billing view with the paid draw |

## Known gaps

- **`04-waiver-blocked.png` was not captured.** `settlement-report.json` step 4 records
  `"screenshot": null` for the pre-signing state. The blockers were read from the rendered payment panel
  and are quoted here from that step: codes `COMPLIANCE_HOLD` and `LIEN_WAIVER_MISSING`, with messages
  "Payment on hold: missing certificate of insurance; missing W-9; missing contractor license" and
  "Lien waiver: the sub has not signed the conditional waiver for $4,000.00." The post-signing gate
  output is recorded in the same step; no screenshot of either state is implied.
- The waiver stores `signedByName: "Marisol Ortiz"`, the seeded Ortiz contact and the name `VAL-RES-005`
  expects. A signed waiver is immutable in-product (`signWaiver` returns the existing signature when the
  amount matches), so the recorded name stands and the settlement is never re-run to change it.
- The Rough-in milestone read `funded` right after funding and now reads `paid` because the same run
  captured the authorization; the authorization id remains on the funding row.
- Step 9 recorded the four money-strip cells by recomputing them from stored rows before the
  `billing/projectMoney` query and the strip UI shipped. The shipped query and the `ProjectMoneyStrip`
  component read the same stored rows; step 9 is the reference value, not a UI capture.
- Step 2 records the requested claim (`540000` total, with `140000` on the Fixtures set line) separately
  from the decided G703 view, where the Fixtures set line reads `0` after the cut.

The 11 PNGs above are tracked in git under `docs/evidence/settlement/` and ship with the tree. The
repository's ignore rule anchors only the scratch `/evidence/` directory.
