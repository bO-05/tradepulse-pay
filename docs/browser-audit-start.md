# TradePulse Pay: blind first-use audit

**Give the browser agent this file first. Give it the detailed playbook only after it returns this round's observations.**
This deliberately withholds the walkthrough and expected payment totals. We want to discover friction, not teach the
agent how to avoid it.

## Assignment

Act as an independent first-time user and skeptical hackathon judge. Test the published application, not a local
mockup. Do not assume it is ready because its developer reports passing tests.

**Start here:** https://cheery-axolotl-689.convex.site/

This is a shared recovery-development application connected to PayPal **sandbox**, not production.

| User | Email |
| --- | --- |
| General contractor, GC | `gc@demo.tradepulse` |
| Subcontractor (Ortiz Plumbing) | `sub4@demo.tradepulse` |
| Project Owner | `owner@demo.tradepulse` |

These seats sign in from **#/demo**; open the collapsed **Manual sign-in and sandbox details** block there for the
shared demo password and the test card. These are intentional public demo credentials, not personal accounts. Use
ordinary sign-in. Do not reset their passwords. Use separate isolated browser contexts/profiles for simultaneous
users. Two tabs, and often two private windows, share authentication; they are not independent users. If isolation is
unavailable, sign out between roles and report that you could not test simultaneous sessions.

## Permission boundary for this first round

Read-only exploration. You may sign in/out, navigate, filter, switch tabs, inspect visible records, open then cancel
forms, resize the browser and capture sanitized screenshots.

Do **not** start/continue a guided run, create records, approve/reject proposals, pay/fund/release money, send emails,
invite people, upload files, change settings, reset/reseed/delete anything or alter the shared accounts. Do not
use real personal information, real cards, personal PayPal accounts or external business recipients.

Do not inspect/export cookies, session tokens, passwords other than the public credentials above, API keys or raw
network archives. Do not use hidden APIs, mocked responses or injected state to make a journey appear successful.
Do not submit Devpost, upload a public video, change production or deploy anything.

## First-use tasks

For the first ten minutes, use only the app and this brief. Do not read source, developer walkthroughs, videos or
the detailed playbook. If the app itself offers a guide, it is fair to discover and use it; record when that happened.

1. Before signing in, describe what the product does, for whom, and why someone would use it. Which claims can you
   understand from the page itself? Which are only guesses?
2. Find a safe way to try it. Is the sandbox/demo nature obvious before any consequential action?
3. Enter as GC. Find evidence of an existing payment and explain the roles of the GC, subcontractor, AI and PayPal.
4. Find a suspicious or reduced pay application. Can you explain what was claimed, what was allowed, who decided,
   what money actually moved, and what remains unpaid? Do not change the decision.
5. Enter as the subcontractor in a separate session. Find that user's agreements/pay applications and explain the
   next action they would take. Do not submit anything.
6. Enter as Owner in a separate session. Find a change order/invoice and explain its payment status without paying.
7. Repeat the key navigation at a narrow phone viewport. Test keyboard-only access to sign-in, navigation, one
   dialog and sign-out. Observe focus, clipping, labels, contrast and confusing dead ends.
8. Reload a deep link and use Back/Forward. Are identity, selected record and navigation still understandable?

Record time to understand the product, find demo access, reach the first useful record and interpret payment status.
Count avoidable clicks, backtracks, misleading labels and places where you needed instructions. These are measurements,
not prescribed performance guarantees. Never invent screen-reader or real-device coverage from desktop emulation.

## Return before receiving the walkthrough

- A plain-English verdict: intuitive / understandable with help / confusing, and why.
- Your first-use timeline and the largest five sources of friction.
- Tasks attempted, outcomes and screenshots, including partial failures.
- What you believe the product actually does versus what you could not verify.
- Separate observed defects, suggestions, access limitations and untested paths.
- Browser/version, viewport, date/time/timezone and which sessions you could isolate.
- Any blocker, with the exact visible error and steps, without exposing secrets or other users' personal data.

Do not claim a fresh end-to-end payment, normal onboarding, full security, WCAG compliance or submission readiness
from this round. Do not claim to have assembled human specialists if you are one agent using several review lenses.

**Stop and return this report.** The next assignment is the
[detailed browser audit playbook](./browser-agent-audit.md), with record-specific checks and separately gated write tests.
