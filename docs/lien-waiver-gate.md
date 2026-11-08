# Opt-in lien-waiver gate

The lien-waiver gate is a per-subcontract switch for a general contractor who wants a signed waiver
before a payout. It is **off by default** on every existing agreement. Turning it on adds a real
pay-gate condition; it does not change the funding, capture, payout or retainage math.

## What the GC turns on

On the agreement page, a GC company admin sees **Lien-waiver gate**. Enabling it records who enabled
it and when, writes an audit-log entry, and makes the pay gate require:

1. **A conditional waiver for this payment.** The sub signs the amount and through-date taken from
   the GC-approved pay app.
2. **An unconditional waiver for the prior payment.** This applies only when a prior pay app was
   approved after the gate was enabled and is marked paid. Turning the gate on does not reach back to
   payments approved before the switch existed.

A GC member who is not an admin can see the setting but cannot change it. Another GC, the sub and
the Owner cannot change it.

## What the sub signs

On the approved pay app, the sub sees the waiver panel. The server sets the amount, the through-date
and the recipient; the form cannot widen or narrow them.

- **Conditional waiver:** the approved gross for this pay app, through that pay app's period end.
  Retainage is not waived by this record.
- **Unconditional waiver:** the approved gross of the prior paid pay app, through that pay app's
  period end.

The signer types a full name, may add a title and note, and must affirm the statement. The next step
shows the **exact statement text** the server built, word for word, and only "Sign and record
evidence" submits it. The signature stores the signer's user id and the server time. The same
signature cannot be overwritten; a second attempt returns the first record. Billing agents cannot
sign. The mutation enforces that the signer is an active, verified human member of the sub company
on that project.

## Signing evidence

Convex mutations never see request headers, so the evidence path is split in two:

1. **`api.waiverEvidence.issueTicket`** (authenticated, sub only) snapshots the amount, through-date,
   recipient and signer, builds the statement text, and returns a 32-byte single-use ticket valid for
   ten minutes. The database stores only the ticket's SHA-256, never the token.
2. **`POST /api/waivers/evidence`** reads `x-forwarded-for` (falling back to `x-real-ip` and
   `cf-connecting-ip`, and recording which header it trusted) and `user-agent`, hashes the statement
   the browser posted back, and writes the evidence row. The route refuses a statement that differs
   from the issued one, a used ticket, an expired ticket and an unknown ticket.
3. **`api.lienWaivers.signWaiver`** now requires `evidenceId` and refuses to write a waiver unless the
   evidence belongs to this signer, this pay app, this kind and this exact amount and through-date,
   was observed no more than 30 minutes ago, and has not already been spent. A signature whose
   amount changed in between is refused with "the amount or through date changed", and the sub signs
   again against a fresh statement.

The waiver row stores `evidenceId`; the audit entry carries the hash prefix, the character count,
the statement version, the observation time, the address and its source header, and the browser
string. A signer who skips the route cannot produce a waiver at all.

What this proves: the exact text attested, the server time it was attested, and the network address
and browser that redeemed the ticket. What it does not prove: that the person at that address is the
named signer (the authenticated session does that), or that the address was not a proxy or VPN.

If the approved amount changes after a signature, the pay gate refuses the stale waiver and asks for
a new one. The panel shows the signed record; the audit log records `waiver_signed` and the GC gets
an in-app notification.

## Retainage release

The gate also covers the closeout retainage release. When the final payment is paid and the
subcontract still holds retainage, the same panel shows a third slot: **Retainage release waiver**,
for the releasable balance, through the last period end. It is anchored to the latest paid pay app so
there is exactly one place to sign, and it uses the same evidence path as the other two waivers.

`beginRetainageRelease` refuses with `LIEN_WAIVER_MISSING` while the gate is on and no live retainage
waiver covers the current balance. The signature must also be bound to the pay app the slot hangs off:
an older live signature for the same amount does not carry over after a later payment makes a different
pay app the latest paid one. If a correction changes the balance, the old signature no longer
matches, the panel offers a replacement, and the release waits for it. With the gate off, retainage
release behaves exactly as before.

## What this is not

This is an in-app attestation, not a state-specific statutory form and not a qualified electronic
signature product. The app says so on the agreement card, the pay-app panel and the signing dialog.
A real GC should confirm the wording and the required form with counsel, and should not treat this
record as a substitute for a notarized or state-prescribed waiver.

## Pay-gate behaviour

`convex/billing/payGateHooks.ts` reads the gate and the signatures. The pay gate reports stable
codes with the rest of its blockers:

- `LIEN_WAIVER_MISSING` – the conditional waiver (or the required prior unconditional waiver) is not
  signed.
- `LIEN_WAIVER_AMOUNT_CHANGED` – a signed waiver's amount no longer matches the approved payment.
- `LIEN_WAIVER_AMOUNT_UNKNOWN` – the gate is on but there is no approved amount to sign against.

With the gate off, `waiverBlockers` returns no reasons. The existing guided demo and the preserved
reference run are untouched.

## Tests

`convex/billing/payGate.test.ts` covers the gate, the retainage release and the evidence path (the file
has 30 tests in total):

- the gate is off by default and enabling it blocks the payout until the sub signs the conditional
  waiver;
- a prior paid payment requires its unconditional waiver, and the gate names both missing signatures;
- changing the approved amount invalidates the signed conditional waiver;
- only a GC company admin can change the gate, and a GC member, another GC, the sub and the Owner are
  refused;
- the evidence path stores only the ticket's hash, records the observed IP, header source and browser,
  writes them into the audit text, and refuses a swapped statement, an expired ticket, evidence older
  than 30 minutes, and evidence whose amount no longer matches;
- a GC cannot mint a ticket for the sub, and a ticket cannot be minted while the gate is off or the
  payment is unapproved;
- the retainage release is refused with `LIEN_WAIVER_MISSING` until the sub signs the retainage
  waiver from the same panel, and proceeds once they do; a changed balance invalidates the signature
  and asks for a new one.

Browser acceptance: `scripts/qa/lien-waiver-browser.mjs` passed **26/26** checks against build `c4f9215`
on 2026-11-06 (`evidence/lien-waiver-browser-2026-11-06T14-43-07-094Z/report.json`, no page or console
errors). It enables the gate on the synthetic demo agreement, verifies the GC sees the blocked
conditional waiver with no signing control, verifies the sub sees the panel and the signing dialog
with the server-set amount and recipient, then fills the form, opens the review step and checks that
the statement the server built (and will hash) names the amount, the recipient and the typed signer,
keeps the disclaimer, and that the dialog states what is recorded. It backs out, cancels without
signing, turns the gate off and confirms the panel disappears. The run records no waiver; the review
step does mint an expiring evidence ticket that is never redeemed.

The live route was also probed directly: an unknown ticket returns `409` with "This signing session is
not recognised", an allowed `Origin` gets the CORS headers on both the POST and the `OPTIONS`
preflight, and an unknown `/api/waivers/*` path still returns the JSON `404`.

## Limits

- One signed record per waiver slot; there is no void-and-replace flow yet.
- No PDF rendering, notarization, certificate or statutory form selection.
- No waiver attachment upload.
- The signing evidence records the address and browser that redeemed the ticket. A proxy or VPN
  changes that address, and the evidence does not replace identity verification, which comes from the
  authenticated, email-verified session.
- A sub who loses the network between "review" and "sign" retries; the ticket stays valid for ten
  minutes and is spent only when the signature is written.
- The prior unconditional requirement follows the prior pay app's `paid` status and approval time;
  it does not query every historical PayPal payment.
