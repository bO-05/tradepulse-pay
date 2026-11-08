# Residential reference freeze — browser evidence

The settled Lopez Kitchen Remodel job is preserved as a read-only reference. `judgeDemo/reference:protectResidentialReference`
is an internal mutation, locked to the `dev:cheery-axolotl-689` deployment (site `https://cheery-axolotl-689.convex.site`),
which sets `readOnlyReference: true` on the Lopez project so every write path refuses with `READ_ONLY_REFERENCE`.

Captured on 2026-11-08 against the local dev server (`http://localhost:3150`) signed in as the demo accounts.
Machine-readable output: [`browser-check.json`](./browser-check.json). The server-side refusals for all seven write
paths (plus the legacy filing path), and the read views that carry the lock, are in
[`server-refusals.json`](./server-refusals.json); `convex/judgeDemo/reference.test.ts` re-proves the same refusals
against an in-memory deployment and checks that the guided demo still starts.

## Screenshots

| File | Shows |
| --- | --- |
| `01-sub-payapp-readonly.png` | Ortiz's settled pay app as `sub4@demo.tradepulse`: reference notice, `Paid`, no submit, revise, withdraw or discard control, no editable line inputs |
| `02-gc-inbox-reference.png` | GC inbox: reference notice, the Ortiz entry marked "Settled reference · read-only", no reject or approve control on it |
| `03-lopez-project-readonly.png` | Lopez project page: reference notice, no "Add trade package", "AI spec breakdown" or "Open in Procurement" control |
| `04-owner-billing-readonly.png` | GC owner billing on Lopez: reference notice and "New owner pay app" disabled with the reason |
| `05-guided-demo-startable.png` | Guided demo on the preserved reference run: notice, "Continue this run" hidden, "Run TradePulse Pay demo" still enabled, new-run confirmation reached and cancelled without starting a run |

## Not changed

The Rosendin reference run and the earlier demo runs (`-04`, `-05`, `-07`, `-08`, draft `-03`) were compared document by
document before and after the freeze: byte-identical, and the only changed document in the whole database was the Lopez
project's `readOnlyReference` field.
