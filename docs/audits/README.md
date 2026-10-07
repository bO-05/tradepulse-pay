# Audit archive (curated)

These are the human-readable audit and remediation artifacts for TradePulse Pro, kept
in-repo so judges can read them without cloning the raw evidence tree. Every HTML file is
**self-contained** (screenshots embedded; no network needed) and opens by double-click.

| Artifact | Date | What it is |
|---|---|---|
| [`DEMO-SCRIPT.md`](./DEMO-SCRIPT.md) | 2026-09-17 | Three-minute demo/video script with a shot list. |
| [`DEMO-VOICEOVER.md`](./DEMO-VOICEOVER.md) | 2026-09-21 | Word-for-word 2:45 demo narration with exact per-beat on-screen values, honesty beats, sponsor one-liners, a 45s social cut, and a do-not-say list. |
| [`audit-1-ux.html`](./audit-1-ux.html) | 2026-09-12 | First UX audit of the deployed app. |
| [`audit-2-user-journey.html`](./audit-2-user-journey.html) | 2026-09-17 | Five-persona user-journey audit (BUG-01…BUG-36 + observations). Screenshots under [`images/`](./images). |
| [`audit-3-adversarial.html`](./audit-3-adversarial.html) | 2026-09-18 | Independent audit v3 (AUD-01…AUD-05) with adversarial passes. |
| [`audit-4-ui.html`](./audit-4-ui.html) / [`audit-4-ui.md`](./audit-4-ui.md) | 2026-09-18 | Human-operator UI audit (F1…F12) — the input to the pass-2 remediation. The Markdown copy is the machine-readable version. |
| [`audit-5-remediation.html`](./audit-5-remediation.html) | 2026-09-19 | Remediation report, pass 2: verification table for F1–F12, new findings, claim-change decisions, convergence log, before/after evidence. |
| [`audit-6-usefulness.html`](./audit-6-usefulness.html) / [`audit-6-usefulness.md`](./audit-6-usefulness.md) | 2026-09-20 | Independent adversarial usefulness audit (AUDIT-6): demo + BYO verdicts, C1–C15 claims, A6-xx findings. The input to the pass-3 remediation. The Markdown copy is machine-readable. |
| [`audit-6-remediation.html`](./audit-6-remediation.html) / [`audit-6-remediation.md`](./audit-6-remediation.md) | 2026-09-21 | Remediation report, pass 3: reproduction status for every A6-xx, before/after evidence, new findings from 25 convergence rounds, decisions (baseline weeks, VE/waive defaults, demo carry-overs), BYO proof, regression output, honesty, and a browser-only re-verification guide for the next auditor. The Markdown copy is machine-readable. |

## Where the raw evidence lives

Full-resolution screenshots, HAR-class network/console dumps, JSON result sets and the
independent QA-round scripts stay in the local working tree (`evidence/`, `doc/`), which is
intentionally git-ignored. Nothing in this folder links to those paths, so no link here can
break. The curated reports above embed the before/after images they reference.

## Reproducing the checks

- App checks: `npx tsc -b`, `npx vitest run --maxWorkers=2`, `npm run build` (see the repository README).
- The Python scripts `tests/test_tradepulse.py` and `tests/verify_setup.py` are legacy. They predate
  TradePulse Pay, are not part of the test suite, and are kept for history only. The reports above
  quote their results from September 2026.
- The live harnesses in [`../../scripts/qa/`](../../scripts/qa/) and [`../../scripts/audit7/`](../../scripts/audit7/)
  are legacy, pre-auth scripts: TradePulse Pay's sign-in and role guards refuse their unauthenticated
  calls. They are kept for history.