# Lopez residential settlement — sandbox evidence

One-time PayPal **sandbox** settlement of the Lopez Kitchen Remodel reference job, run on
2026-11-08 against deployment `dev:cheery-axolotl-689`. No real money moved.

Machine-readable report: [`settlement-report.json`](./settlement-report.json). It records every step,
the PayPal order/authorization/capture/payout ids, integer cents, and the stored-query outputs. It
contains no tokens, cookies, auth frames, card fields or unmasked payee emails.

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

- The pre-signing missing-waiver blocker was read from the rendered payment panel but its screenshot
  (`04-waiver-blocked.png`) was lost when the in-app browser pane collapsed. The exact codes and
  messages are in `settlement-report.json` step 4.
- The waiver stores `signedByName: "Marisol Ortiz"`; the validation contract names `"Luis Ortiz"`. The
  product has no path to change a recorded signature, so the row was left as signed rather than edited.
- The Rough-in milestone read `funded` right after funding and now reads `paid` because the same run
  captured the authorization; the authorization id remains on the funding row.
- The money strip query/UI are pending features, so the four cells were recomputed from stored rows per
  architecture §6.1.

The repository's `evidence/` ignore rule matches `docs/evidence/`, so these PNGs are not committed.
