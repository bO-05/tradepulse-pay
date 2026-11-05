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

The signer types a full name, may add a title and note, and must affirm the statement. The signature
stores the signer's user id and the server time. The same signature cannot be overwritten; a second
attempt returns the first record. Billing agents cannot sign. The mutation enforces that the signer
is an active, verified human member of the sub company on that project.

If the approved amount changes after a signature, the pay gate refuses the stale waiver and asks for
a new one. The panel shows the signed record; the audit log records `waiver_signed` and the GC gets
an in-app notification.

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

`convex/billing/payGate.test.ts` adds four regression tests:

- the gate is off by default and enabling it blocks the payout until the sub signs the conditional
  waiver;
- a prior paid payment requires its unconditional waiver, and the gate names both missing signatures;
- changing the approved amount invalidates the signed conditional waiver;
- only a GC company admin can change the gate, and a GC member, another GC, the sub and the Owner are
  refused.

The suite also asserts the audit text, the notification recipients, the signer fields, idempotent
re-signing and the stale-amount wording.

## Limits

- One signed record per waiver slot; there is no void-and-replace flow yet.
- No PDF rendering, notarization, certificate or statutory form selection.
- No waiver attachment upload.
- The prior unconditional requirement follows the prior pay app's `paid` status and approval time;
  it does not query every historical PayPal payment.
