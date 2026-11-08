# Frozen reference write controls — browser evidence

The settled Lopez Kitchen Remodel job (`projects.readOnlyReference: true`) no longer offers write
controls on its Project settings screen, and its project page no longer links to settings or People.
This is the UI half of VAL-RES-009; every write path already refuses server-side with
`READ_ONLY_REFERENCE` (see `docs/evidence/freeze-2026-11-08/server-refusals.json`).

Captured on 2026-11-09 against the local dev server (`http://localhost:3150`) signed in as the demo GC
(`gc@demo.tradepulse`) through `#/demo`, in a fresh headless Chrome context.
Machine-readable output: [`checks.json`](./checks.json).

## Screenshots

| File | Shows |
| --- | --- |
| `01-lopez-project-1440.png`, `01-lopez-project-390.png` | Lopez project page: reference notice; no "Project settings", "People" or "Open in Procurement" control |
| `02-lopez-settings-1440.png`, `02-lopez-settings-390.png` | Direct hash navigation to `#/all-projects/<lopezId>/settings`: reference notice, "This preserved reference job is read-only.", every field disabled, no Save settings, no Archive project, no Add GC line, no Edit or Remove on any prime line; the four prime lines still render ($21,600 / $34,600 / $8,300 / $13,000) |
| `03-commercial-settings-1440.png`, `03-commercial-settings-390.png` | An unfrozen commercial job (The Domain Tower B - Commercial MEP) keeps Save settings, Archive project and Add GC line, with no notice |

## Measured checks

`checks.json` records, for both widths:

- Frozen project page: `notice: true`, `settingsLink: false`, `peopleLink: false`, `procurement: false`.
- Frozen settings route: `notice: true`, `save: false`, `archive: false`, `addLine: false`,
  `edit: 0`, `remove: 0`, `disabledFieldsets: 1`, `primeRows: 4`.
- Commercial settings route: `notice: false`, `save: true`, `archive: true`, `addLine: true`,
  `disabledFieldsets: 0`.
- `document.documentElement.scrollWidth` equals the viewport (1440 and 390), so no horizontal overflow.
- 0 console errors, 0 page errors. The two `GET /api/sign-in-options :: net::ERR_ABORTED` entries are
  the known Convex Auth probe aborted by hash navigation; the same two appear in
  `docs/evidence/freeze-2026-11-08/browser-check.json`.

## Not changed

No Convex function, schema, seed or money row changed. The commercial settings screen output is
unchanged (same controls render), and the two new component tests pin both the frozen and unfrozen cases.
