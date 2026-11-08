# GC home and Lopez project page — design evidence (2026-11-09)

Captured against `http://localhost:3150` signed in as the Demo GC (`#/demo` → General
contractor), with the seeded Rosendin and Lopez fixtures. Every screenshot and number in
`measurements.json` came from the repository's `puppeteer-core` harness
(`scripts/qa/lib.mjs`, driven by `evidence/gc-design/after.mjs`) because the pane was not
visible to the browser tool. The screenshots are full-page captures; `*-fold.png` is the first
viewport only (900px tall at 1440 wide, 844px at 390 wide).

## Files

| File | What it is |
| --- | --- |
| `inbox-1440.png`, `inbox-390.png` | GC approval inbox, full page |
| `inbox-1440-fold.png`, `inbox-390-fold.png` | GC approval inbox, first viewport |
| `project-1440.png`, `project-390.png` | Lopez Kitchen Remodel project page, full page |
| `project-1440-fold.png`, `project-390-fold.png` | Lopez project page, first viewport |
| `measurements.json` | DOM measurements: primary count, status labels, money-strip/trail offsets, target sizes, overflow, console state |
| `inbox-browser-sweep.json` | `scripts/qa/landing-nav-inbox-browser.mjs` report for the same origin; all checks pass |

## Before → after

| Check | Before | After |
| --- | --- | --- |
| Inbox primary-variant buttons at 1440 | 0 (all actions were the same small bordered button) | 1 — `Approve capture + payout` (`approve-proposal`) on the next decision |
| Inbox proposal status pill text | raw `pending` / `executed` | `Pending` / `Executed` |
| Inbox `jump-to-approve` visible | yes | no (the pinned test id remains as a hidden hook) |
| Inbox interactive elements under 24px | 64 | 0 |
| Inbox money strip top (1440×900) | 325px | 333px (above the fold) |
| Project page identity | `Dana Lopez · El Cerrito, CA` | `Bayview Remodeling · Dana Lopez · El Cerrito, CA` |
| Project page primary action | 0 primary variants | 1 — `Open billing` |
| Project money strip top (1440×900) | 458px | 505px (above the fold) |
| Project money trail top (1440×900) | absent | 779px (above the fold, no detail panel opened) |
| Contract value figure | inline meta text | `text-2xl` (24px) labeled figure |
| Horizontal overflow at 390px | n/a | 0px on both screens |
| Project page interactive elements under 24px | — | 0 (the `Bidders` and `Open in Procurement` toggles were raised to 24px) |

`measurements.json` also records zero page errors and zero console errors during the capture.
The only failed requests are two aborted `sign-in-options` probes from the unauthenticated demo
page (`net::ERR_ABORTED`); neither screen uses that optional response.

The Lopez full-page screenshots omit the `Owner company` card, which holds the owner's sandbox
billing address; the mission's masking rule requires it. The card sits below the money trail and
does not affect the above-the-fold evidence.

## What the screens show

- The inbox opens with `Money across your jobs` (portfolio strip), then a plain `5 open · 0
  awaiting payment · 13 in history` count and a single primary `Approve capture + payout` on the
  first payout proposal. `Edit amount` and `Reject` are secondary; the license override is a
  labeled checkbox with a 44px label; `Accept hold`, `Dismiss`, and `Accept reschedule` are
  secondary. Each payout card carries a compact `Proposed by code rules → Retainage → Net to
  sub` trail and a plain-word status pill.
- The Lopez page opens with the GC/owner identity line, a labeled `Contract value $86,500.00`,
  one primary `Open billing`, then the money strip and the owner-side money trail (contract →
  draw #1 → retainage held → paid by the homeowner). Project details follow below the fold.
- At 390px neither page scrolls horizontally and the money figures stay visible.
