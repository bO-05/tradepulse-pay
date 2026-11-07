# Audit entry point

One page for an external reviewer. Every claim below is a command you can run or a file you can read.
Nothing here is a substitute for the finding map in `docs/r7-remediation.md`; it is the shortest path
to it.

## The build under review

- Source: `github.com/bO-05/tradepulse-pay`, default branch `main`.
- Live: `https://tradepulse-pay.asynchronope.tech`, `https://tradepulse-pay.pages.dev` and
  `https://cheery-axolotl-689.convex.site`.
- All three must serve the same commit. Compare `https://<host>/version.json` with `git rev-parse HEAD`
  on `main`; they are written from the same build. `scripts/deploy-all.mjs` refuses to publish when a
  host still serves the previous commit or when a hashed asset from `dist/index.html` is not yet
  reachable with the right content type.
- The dev Convex deployment is the only deployment in scope. Production deployments are out of scope
  for this review and were not touched.
- The canonical branch is `main`. `recovery/stabilize-2026-11-01` and `paypal-hackathon` are history and
  a backup; a reviewer does not need either of them.

## Reproduce the evidence

| Command | Expected |
| :--- | :--- |
| `npx vitest run` | 161 files, 2089 tests, 0 failures |
| `node scripts/tools/guard-audit.mjs` | 267 public functions, 203 internal, 0 problems |
| `npm run verify:docs` | 106 relative links resolve |
| `npm run build` | clean, no type errors |
| `node scripts/qa/lien-waiver-browser.mjs --url <host>` | 26/26, no page or console errors. Toggles the demo gate, mints one unredeemed evidence ticket, records no waiver |
| `node scripts/qa/quick-start-resume-browser.mjs --url <host>` | 15/15, read-only |
| `node scripts/qa/dual-host-browser.mjs --url <host>` | 21/21 per host |
| `node scripts/qa/owner-landing-browser.mjs` | 9/9, 0 contrast violations |
| `node scripts/qa/quick-start-browser.mjs` | 23 checks, but it creates a real demo job. Run it only if you accept that write |

Live check on 2026-11-07, GC seat: **Billing → Owner billing** lists **Lopez Kitchen Remodel** first and
**New owner pay app** is enabled; pressing it opened owner pay app #1 for the period ending 15 Oct 2026
with the four prime lines and `$86,500` scheduled. The draft was then deleted, so the button is live
again for the next visitor. This is Demo-company data, not the read-only reference run.

`scripts/qa/` also holds the older scenario scripts (`recovery-smoke.mjs`,
`recovery-settlement-smoke.mjs`, `pay-app-review-scorecard.mjs`, `pay-app-thread-browser.mjs`,
`owner-job-browser.mjs`); their headers say what each one writes. `audit-v3/v2-browser.mjs` are stale
and kept for history only.

## Known environment noise

`dual-host-browser.mjs` without `--url` drives both hosts in one run and hits a 30 s navigation
timeout on a 16 GB machine when desktop Chrome is already holding several gigabytes. Each host passes
every assertion when run alone, and the failing URL answers in under a second over plain HTTP.
`docs/r7-remediation.md` records this as machine contention, not an app fault.

## Where to read

| File | What it answers |
| :--- | :--- |
| `docs/r7-remediation.md` | Finding map with per-item status, what changed, and why anything is still open |
| `docs/guard-audit.md` | Generated list of every public function with its guard and tenancy guard |
| `docs/lien-waiver-gate.md` | The gate, the B10 signing-evidence design, and its limits |
| `docs/pay-app-review-eval.md` | The 24-case review suite, the rules-only baseline, and what the score cannot prove |
| `docs/quick-start.md` | The wizard, its saved draft, and how resume is verified |
| `docs/recovery-progress.md` | Recovery history and the branch handoff |
| `hackathon.md` | Earlier Convex All Gas hackathon log (September 2026), kept as history for the disclosure |
| `docs/submission-draft.md` | What the submission claims, written for judges |

## Open items, stated plainly

- **B2 (fixed).** The gate now covers the closeout retainage release: the sub signs from the same
  panel, the release refuses until the balance is covered, and a changed balance asks for a new
  signature. The final-payout path outside retainage is unchanged.
- **Block 1 (partial).** The Demo company now carries a residential reference job, "Lopez Kitchen
  Remodel": an `$86,500` prime value, four prime SOV lines, a 10% retainage hold and a billing day, so
  the GC's **New owner pay app** opens a homeowner draw with real lines. The owner-billing panel also
  keeps three running totals: billed and awaiting the owner, approved but not yet paid, and paid by the
  owner. Still open: milestone draws on the prime side, and a GC collected/paid/owed view across
  subcontractors. The demo still leads with the commercial run.
- **B5 (partial).** The subcontract states that the sub's signature and acceptance happen outside the
  app; there is no in-app sub acceptance step.
- **B13 (fixed, real limit).** The review eval is self-authored. The score is now labelled as agreement
  with this app's rules, with a rules-only baseline printed in the doc, the scorecard and the app, but
  a perfect score still cannot show that the rules are right.
- **B10 (fixed, real limit).** Signing evidence records the statement hash, the server-observed IP and
  the user agent. A proxy or VPN changes the address; identity comes from the authenticated,
  email-verified session.
- **Owner settings outside the code.** The PayPal sandbox merchant still shows the default store name;
  the demo video, YouTube upload and Devpost submission are the owner's tasks.

## What this build does not claim

Not a statutory lien-waiver form, not legal advice, not a qualified electronic signature product, and
not a production payments system. Money moves in PayPal sandbox. The reference run used by the judge
demo is read-only: `readOnlyReference` is set on it, and the guided demo and
`#/judge-demo/nx74k1sdcnsmqzvkr97kf0ts598hch6p` must keep working. Do not approve the pending reschedule
`jd79qzxzf56nr2jgnvgnr92jxh8hckgq` in that run.
