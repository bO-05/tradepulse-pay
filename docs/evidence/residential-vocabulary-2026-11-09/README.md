# Residential vocabulary evidence — 2026-11-09

Feature: `residential-vocabulary` (mission `judge-experience`).
Checked on the local app at `http://localhost:3150`, recovery dev deployment
`cheery-axolotl-689`, signed in with the synthetic demo seats.

Fixtures:

- Residential: Lopez Kitchen Remodel, project `q97f6pmh2d5qn733jmh5pg4c3x8hr9sn`; draw
  `pd753160qzkknhm3smyxbetxwn8ht286`; pay app `ph7434a59sqck3nysgt6teqh0h8hvx1h`; change order
  `kx76mes3b4e7dt47qbv92tbav58httg0`.
- Commercial: Rosendin/Domain Tower B, project `q976pstkawcf81w905kap39cn18hcygr`; pay app
  `ph7fh2dpqnx82kq1dn3gwcp8yx8hcem6`; judge demo reference run
  `nx74k1sdcnsmqzvkr97kf0ts598hch6p`.

## Vocabulary

| Concept | Residential (Lopez) | Commercial (Rosendin / kind unset) |
| --- | --- | --- |
| Owner bill | Draw / Draws | Owner pay app / Owner pay apps |
| Draw sheet | Draw breakdown | Continuation sheet (G703) |
| Numbered summary | Draw summary | Application summary (G702) |
| Money columns | Work completed · Previously paid · This draw · Retainage | Work completed · Less previous certificates for payment · Current payment due · Retainage |
| Materials stored | row not rendered | Materials stored |
| Previous amount | Previously paid | Less previous certificates for payment |
| Trade packages | Trades / Trade | Trade packages / Trade package |
| Executed status | Signed | Executed |
| Funding unit | Funded milestone / Funded milestones | Tranche / Funding tranches |
| Prime prefix | none | Prime |
| Badge | none | Commercial reference job |

`src/lib/terms.ts` re-exports `termsForKind(kind)` and the `Terms` type from
`convex/lib/terms.ts`. A missing `projectKind` is commercial.

`src/ui/statusLabels.ts` adds `statusLabelFor(code, kind)` and `statusMetaFor(code, kind)`.
Status codes, schema fields, routes, CSV/PDF contracts and existing `data-testid` values are unchanged.

## Banned-string scans

Exact strings scanned: `Materials stored`, `Less previous certificates for payment`,
`certificates for payment`, `Prime continuation sheet`, `Prime`, `G702`, `G703`, `AIA`, `CSI`,
`CSI MasterFormat`, `Div 26`, `tranche`.

Full-page rendered text (`document.body.innerText`) after the change:

| Surface | Result |
| --- | --- |
| Owner home | `tranche` only in the commercial demo-project sections below Lopez; the Lopez `[data-project-kind="residential"]` subtree has **0 hits** in rendered text |
| Owner draw (`#/owner-pay-apps`, Lopez selected) | **clean** |
| Owner change-order invoice | **clean** |
| Owner change-orders list (Lopez) | **clean** |
| Sub portal (Ortiz) | **clean**; renders `Signed`, never `Executed` |
| Sub pay app (Ortiz) | app-authored copy is clean; recorded GC explanation/review reasons still quote `tranche` (see residual below) |
| GC Lopez project page | **clean** |
| GC owner billing (Lopez selected) | **clean** |
| Commercial Rosendin project / pay app / owner billing | AIA wording preserved (`G702`, `G703`, `Materials stored`, `Prime`); each renders `Commercial reference job` |
| Judge demo reference run | renders `Commercial reference job`; no banned strings |

Column-header capture (Lopez draw breakdown):
`# | Description of work | Scheduled value | Work completed | Previously paid | This draw | Retainage`

## Badge surfaces

- Rosendin project page (`gc-rosendin-*.png`)
- Rosendin pay app (`gc-rosendin-payapp-*.png`)
- Rosendin GC owner billing (`gc-rosendin-owner-billing-*.png`)
- Judge demo reference run (`gc-judge-demo-*.png`)

Badge text and `data-testid="commercial-reference-badge"` are asserted in
`src/ui/statusLabelFor.test.tsx`.

## Residual findings

1. **Recorded narrative keeps the old word.** The settled Ortiz pay app's GC explanation and
   per-line review reasons contain the word `tranche` as recorded evidence. The UI leaves recorded
   text intact; only app-authored labels changed. The scan of the owner draw, owner home Lopez
   subtree, owner change order and GC owner billing is clean.
2. **Owner home is a portfolio page.** It lists commercial demo projects alongside Lopez. Commercial
   sections keep commercial words; the residential section is marked with
   `data-project-kind="residential"` and was scanned separately.
3. **Internal keys keep their old spelling.** `data-testid` and schema-derived attribute names such as
   `owner-tranches`, `owner-tranche-row` and `portal-prime-retainage` are intentionally unchanged
   (VAL-LANG-004). They are not rendered text.
4. **The funding ledger is a later sweep.** `FundingTranches` / `AgreementLedgerView` still use the
   stored tranche field names on the GC agreement ledger. The owner flow and the surfaces in this
   evidence do not render them.

## Commands

```text
npx tsc -b                                  exit 0
npx vitest run --maxWorkers=2               172 files, 2157 tests passed
npm run build                               exit 0
npm run verify:guards                       269 public functions, 205 internal, 0 problems
```
