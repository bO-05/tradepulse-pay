# Pay-App Review Eval Scorecard

**Run ID**: `eval_payapp_1793864125712`  
**Timestamp**: `2026-11-05T07:39:28.584Z`  
**Deployment**: `cheery-axolotl-689`  
**Reviewed by**: Mistral (mistral-large-4)  
**Cases**: 24  

## Summary

| Metric | Result | Population | Meaning |
| :--- | ---: | ---: | :--- |
| **Cases passed** | **24 / 24** | 100% | Every fixture's verdicts, zero holds and flags match |
| **Line accuracy** | **100%** | 71 lines | Exact verdict per submitted line |
| **Issue precision** | **100%** | 15 issue lines | Flagged lines that were truly issues |
| **Issue recall** | **100%** | 15 issue lines | Truly flagged issue lines that were caught |
| **Issue F1** | **100%** | precision + recall | Harmonic mean of issue detection |
| **Macro F1** | **100%** | 5 verdict classes | Macro one-vs-rest F1 across verdicts |

All cases matched their expected verdicts, zero holds and flags.

## Per-verdict precision and recall

| Verdict | Support | TP | FP | FN | Precision | Recall | F1 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `ok` | 56 | 56 | 0 | 0 | 100% | 100% | 100% |
| `overbilled` | 5 | 5 | 0 | 0 | 100% | 100% | 100% |
| `excluded_scope` | 6 | 6 | 0 | 0 | 100% | 100% | 100% |
| `front_loaded` | 2 | 2 | 0 | 0 | 100% | 100% | 100% |
| `out_of_sequence` | 2 | 2 | 0 | 0 | 100% | 100% | 100% |

A "positive" in the issue metrics is any line whose expected verdict is not `ok`. The per-verdict
metrics are one-vs-rest: for each class, true positives are lines with that expected verdict and
that verdict predicted, false positives are other lines predicted as that class, and false negatives
are lines with that expected verdict predicted as something else.

## Case-by-case results

| Fixture | Verdict match | Result | Reviewed by |
| :--- | ---: | :--- | :--- |
| `payapp_honest` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_overbilled` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_excluded_scope` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_front_loaded` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_out_of_sequence` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_closeout_over_ceiling` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_excluded_over_ceiling` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_overbilled_over_front` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_at_ceiling` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_stored_materials` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_early_phase` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_no_tranche_stored` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_no_tranche_complete` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_multiple_exclusions` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_missing_lien_waiver` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_expired_license` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_prompt_injection` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_zero_progress` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_prior_baseline` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_overbilled_third_line` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_unbilled_closeout` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_excluded_sov_line` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_mixed_findings` | 100% | **PASS** | Mistral (mistral-large-4) |
| `payapp_front_loaded_no_tranche` | 100% | **PASS** | Mistral (mistral-large-4) |

## Reproduce

```powershell
npm.cmd run eval:payapps
```

The script pins `--deployment cheery-axolotl-689` and refuses to run unless `.env.local` points at
`dev:cheery-axolotl-689`. It never targets production.
