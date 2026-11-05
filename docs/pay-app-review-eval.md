# Pay-app review evaluation

The pay-app review suite scores the reviewer (a model, or the deterministic fallback when no model
is configured) against 24 hand-built ground-truth cases. It covers the five line verdicts, the
precedence between them, stored materials, missing funding tranches, review flags and a prompt
injection attempt.

The model never authors money. Every approved cent comes from the code rules in
`convex/payApps/reviewMath.ts`; the suite scores the reviewer's verdicts and flags, then the app
applies the rules to the final review. A model that misses a line cannot make the payout wrong,
because code replaces a disagreeing verdict and records `modelVerdict`.

## What the 24 cases cover

| Group | Cases |
| :--- | :--- |
| Baseline | honest, overbilled, excluded scope, front-loaded |
| Sequence | closeout billed while Rough-in is active, closeout over the ceiling |
| Precedence | excluded over ceiling, overbilled over front-loaded, exact ceiling |
| Materials and funding | stored materials, early-phase exemption, no tranche with stored gear, no tranche at completion, front-loaded with no tranche |
| Flags | missing lien waiver, expired license |
| Robustness | prompt injection in a sub note, zero progress, prior approved baseline |
| Scope and combinations | two excluded scopes, excluded SOV line, mixed overbilled + excluded, third-line overbilling, unbilled closeout |

Each fixture declares the expected verdict for every submitted line, the lines that must approve
exactly $0, and the expected lien-waiver and license flags. A case passes only when every line
verdict, every zero hold and both flags match.

## Metrics

`reviewMetrics` is stored on the `evalRuns` row and returned by the suite:

- **Line accuracy** — exact verdict matches over all submitted lines.
- **Issue precision** — flagged lines that were truly issues, over all flagged lines.
- **Issue recall** — truly flagged issue lines caught, over all issue lines.
- **Issue F1** — harmonic mean of issue precision and recall.
- **Macro F1** — one-vs-rest F1 averaged across the five verdict classes (`ok`, `overbilled`,
  `excluded_scope`, `front_loaded`, `out_of_sequence`), counting classes with support.
- **Case pass rate** — cases where every line, zero hold and flag matched.

An "issue" is any expected verdict other than `ok`. Per-verdict TP/FP/FN counts are stored too, so
a high overall score cannot hide a weak class.

## Current result

Live Mistral / `mistral-large-4` on the recovery dev deployment, run
`eval_payapp_1793864125712` (2026-11-05):

| Metric | Result |
| :--- | ---: |
| Cases | 24 / 24 |
| Lines | 71 |
| Issue lines | 15 |
| Line accuracy | 100% |
| Issue precision | 100% |
| Issue recall | 100% |
| Issue F1 | 100% |
| Macro F1 | 100% |

All 24 fixtures reported `Mistral · mistral-large-4`, not the offline fallback. The scorecard is
generated at `evals/results/pay-app-review-scorecard.md` and the full JSON result is next to it. The
scorecard is only evidence for the run named in its header; a later deploy or a different model is a
different run. An offline rules-engine run with no provider key also passes 24/24; the provenance
line distinguishes the two.

## Run it

```powershell
npm.cmd run eval:payapps
```

The script pins `--deployment cheery-axolotl-689` and refuses to run unless `.env.local` has
`CONVEX_DEPLOYMENT=dev:cheery-axolotl-689`. It never targets production.

For a strict regression check:

```powershell
node scripts/qa/pay-app-review-scorecard.mjs --strict
```

Strict mode exits non-zero unless every case passes and issue precision and recall are each at
least 90%.

The suite also runs from the Demo GC diagnostics screen as part of the existing eval action. If
`MISTRAL_API_KEY` (or another provider key) is configured, the scorecard measures that model's
verdicts and labels every fixture with its provider and model. Without a key, it measures the
offline rules engine and says so. A provider failure falls back per fixture; mixed provenance is
labeled `mixed`, never claimed as a model run.

## Limits

- These are synthetic fixtures, not a random sample of real pay applications. They are designed to
  exercise known failure modes, not to estimate production accuracy.
- The expected verdicts encode the product's current rules. A rule change requires updating the
  fixture and its expected verdict together.
- The suite checks verdicts and flags, not the prose quality of a reason or the final dollar total
  against an independent estimator.
- A 100% offline score is a regression check on the rules, not evidence that a live model is
  accurate; read the provider/model line and the per-verdict counts.
