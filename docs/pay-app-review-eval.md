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

Every metric below is **agreement with this app's rules**, not accuracy against an independent
adjudication. The 24 fixtures, their expected verdicts and the rules in `reviewMath.ts` were written
by the same author, so the score says how faithfully the reviewer reproduces the rules, not whether
the rules are right.

`reviewMetrics` is stored on the `evalRuns` row and returned by the suite:

- **Line agreement** — exact verdict matches over all submitted lines.
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
| Cases matched | 24 / 24 |
| Lines scored | 71 |
| Issue lines in the fixtures | 15 |
| Provider | Mistral · `mistral-large-4` on every fixture |

24 of 24 fixtures reproduced the expected verdicts, zero holds and both flags on this app's own
fixtures. The suite does not publish a precision or recall percentage as a quality claim: the
expected verdicts were written by the same author as the rules, so a perfect match measures
agreement with those rules, not accuracy against an independent adjudication or a real pay
application. Read the per-verdict TP/FP/FN counts and the case list in the scorecard instead.

The scorecard is generated at `evals/results/pay-app-review-scorecard.md` and the full JSON result
is next to it. The scorecard is only evidence for the run named in its header; a later deploy or a
different model is a different run. An offline rules-engine run with no provider key also matches
24/24; the provenance line distinguishes the two.

## Rules-only baseline

The deterministic rules engine matches **24/24 cases** on these fixtures by construction, because
each expected verdict is what that engine produces. The baseline is the point of
the number:

- A model below the baseline disagrees with the rules on a hand-picked case. That is a useful defect
  report for the reviewer, not a finding about the rules.
- A model at the baseline reproduced the rules on 24 cases the author chose. It says nothing about the
  cases nobody wrote, and nothing about whether the rules match a real contract or a real GC's
  judgment.
- Changing a rule changes the expected verdict with it, so the suite cannot catch a rule that is wrong
  in the same way on the fixture and in production.

The scorecard markdown, the console output and the diagnostics panel now print that baseline and
label the score as agreement with this app's rules. The in-app panel is at **Diagnostics → Pay-app
review cases** for the demo GC.

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
- A perfect offline score is a regression check on the rules, not evidence that a live model is
  accurate; read the provider/model line and the per-verdict counts.
