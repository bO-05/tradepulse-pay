# Copy-leak sweep evidence — 2026-11-09

Captured against `http://localhost:3150` using the repo's `puppeteer-core` harness, signed in only
through the three public `#/demo` seats. Read-only: no approval, payment, guided run, settlement,
seed or shared `sub1@`–`sub3@` seat was touched.

Droid cannot view images, so no visual pass was performed by the worker. These captures are for the
orchestrator's independent image review. The computed checks below are from `report.json`, not from
looking at the screenshots.

## Verdict

`node scripts/qa/leak-scan.mjs`:

- self-test PASS: text inside a closed `<details>` is exempt (0 hits); the fixture outside it is
  counted (1 hit); quoted recorded history is reported separately.
- Demo landing and the six screens: **0 app-copy hits**.
- 4 visible quoted recorded blocks, **0 banned strings inside them**, reported separately and never
  rewritten.
- Exit code 0. Full output in `leak-scan.txt`; machine result in `leak-scan.json`.

`report.json`: **56/56 checks passed** at 1440×900 and 390×844. The checks cover:

- both honest labels are visible verbatim:
  `PayPal sandbox · no real money` and
  `Rules set the amount. Mistral explains it. You decide.`
- the collapsed manual details is the only home of `AgentID`, `Recovery-dev` and `Studio license`;
  opening it preserves 0 banned strings outside the element.
- the sub pay app keeps the payout receipt visible while showing
  `sb-****@personal.example.com`, with no unmasked `.example.com` address.
- the frozen Lopez draw breakdown shows `Plumbing — Ortiz Plumbing` and no `Plumbing (22 00 00)`.
  The stored `ownerPayApps.lines` value was read first as `Plumbing (22 00 00) – Ortiz Plumbing`
  (36 characters, U+2013 at index 20) and was not edited; only the display helper normalises it.
- the residential GC ledger says `Milestone funding` / `Funded milestone` with no `tranche` in its
  app copy. Its quoted recorded review has the plain heading `Recorded review · Nov 8, 2026`, and
  the frozen narrative appears byte-for-byte; commercial vocabulary in that quote is reported but
  never edited. Ledger chrome outside the quote has no `tranche`, `prime`, `G702`, `G703`, `AIA` or
  `CSI`.
- the commercial reference ledger (`jn78x0j5xeh7q9gb55p26r7pdh8hdmjx`) still says
  `Funding tranches` and `tranche`, and does not say `milestone funding`.
- a temporary comparison against the pre-sweep `buildSubcontractText` and
  `buildSubcontractPdf` proved the commercial subcontract text and PDF are byte-identical to HEAD;
  the temporary comparison files were removed.
- the owner change-order invoice has no unmasked `.example.com` address and shows its PayPal invoice
  receipt.

## Files

Each screen has a full-page and first-viewport PNG at `1440` and `390`:

- `demo-collapsed-*`, `demo-expanded-*` — `#/demo`, collapsed and the single expanded
  `Manual sign-in and sandbox details`.
- `gc-home-*` — `#/inbox`.
- `gc-lopez-project-*` — the Lopez Kitchen Remodel project page.
- `sub-pay-app-*` — the settled Ortiz pay app.
- `owner-home-*` — `#/projects`.
- `owner-draw-*` plus `owner-draw-breakdown-*` — `#/owner-pay-apps` with the draw breakdown open.
- `owner-change-order-invoice-*` — the paid Lopez change-order invoice.
- `gc-residential-ledger-*` — the GC Lopez agreement ledger (milestone wording and quoted history).
- `gc-commercial-ledger-*` — the commercial Rosendin reference ledger (unchanged tranche wording).
- `SC-22-ORTIZ-0001-subcontract.pdf` and `.txt` — the Ortiz subcontract generated from the Lopez
  job. The text contains no `AIA`, `G702`, `G703`, `CSI MasterFormat`, `Prime` or
  `Less previous certificates for payment`, and keeps the residential heading/footer.

## Diagnostics

Every screen recorded zero console errors and zero page errors. One recurring failed request was
observed: `GET https://cheery-axolotl-689.convex.site/api/sign-in-options :: net::ERR_ABORTED`.
It is the auth client aborting its sign-in options probe during/after navigation; the same request
succeeds when the app needs it (the seats sign in normally). It is recorded in `report.json` rather
than hidden.

## Reproduce

```powershell
npm run dev
node scripts/qa/leak-scan.mjs --url http://localhost:3150
```

The screenshots were produced by a temporary `puppeteer-core` sweep that was removed after the
capture. The committed `scripts/qa/leak-scan.mjs` is the executable copy-leak command; the
`report.json` here records every check the temporary sweep made.
