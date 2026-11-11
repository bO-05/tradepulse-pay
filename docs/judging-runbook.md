# Judging runbook (December 1 – 15, 2026)

The build is judged for two weeks after the Devpost deadline (November 12, 2026, noon Pacific). This
page is the owner's checklist for that window. None of it is app code, and nothing here changes what
the submission claims.

## Before submitting

- [ ] The entry links the canonical source (`main`) and the demo at
      `https://tradepulse-pay.asynchronope.tech/#/demo`.
- [ ] The existing-project disclosure from the README's [What changed since Oct 1](../README.md#what-changed-since-oct-1)
      section is in the entry: PayPal-era work starts after baseline `2ad5543`, the first PayPal commit is `c7986da` on
      7 October 2026, and the September procurement base was a separate Convex-hackathon submission.
- [ ] The PayPal sandbox merchant name is no longer the default "Test Store", if the account allows it.

## Keep funded and valid through December 15

- [ ] **Mistral credits.** Without them the review falls back to the deterministic rules engine and the
      UI says so, instead of claiming the model reviewed the pay app.
- [ ] **`KERNEL_API_KEY`** on the dev deployment `cheery-axolotl-689`. Without it the CSLB check returns
      "unverified". Set it with `npx convex env set KERNEL_API_KEY "<key>"`; no redeploy is needed
      because Convex reads the variable at run time.
- [ ] **PayPal sandbox credentials** for the demo merchant. Without them capture, payout and invoicing
      fail closed with a visible error instead of pretending to pay.
- [ ] **Convex** dev deployment plan and usage limits.
- [ ] **Cloudflare Pages** project `tradepulse-pay` and the `asynchronope.tech` CNAME stay up, and
      `CONVEX_SITE_URL` still points at `https://cheery-axolotl-689.convex.site`.

## Re-verify on the day judging starts

From the repository root, on `main`:

```
npx vitest run
node scripts/tools/guard-audit.mjs
npm run verify:docs
node scripts/qa/landing-nav-inbox-browser.mjs --url https://tradepulse-pay.asynchronope.tech
node scripts/qa/owner-landing-browser.mjs
node scripts/qa/lien-waiver-browser.mjs --url https://tradepulse-pay.asynchronope.tech
```

Compare against the table in [the audit entry](./audit-entry.md), which carries the current counts for the
build under review. The three browser sweeps must report
`ok: true` with empty `pageErrors` and `consoleErrors`.

Do **not** run `scripts/qa/quick-start-browser.mjs` during judging unless you accept it creating a real
demo job, and do not run the combined two-host sweep (`dual-host-browser.mjs` with no `--url`) on a
16 GB machine while a desktop Chrome is open: it times out on navigation.

## Why a plain fetch of `/` can look empty

The frontend is a hash-routed single-page app. In a browser, `/` renders the residential landing page and
`/#/demo` renders the demo guide. A plain HTTP fetch, a link preview or a crawler that does not execute
JavaScript sees the static `index.html` only: the title, the meta description, and a `<noscript>`
fallback that points at `/#/demo`. That is expected, not a broken deploy. To check what a host is
actually serving, read `/version.json` and compare it with `git rev-parse HEAD`.
