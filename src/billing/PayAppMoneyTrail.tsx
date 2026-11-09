import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Terms } from "../lib/terms";
import { MoneyTrail, formatCents, type MoneyTrailStep } from "../ui";

export type PayAppView = NonNullable<FunctionReturnType<typeof api.payApps.g703.getPayApp>>;

/**
 * The sub pay app's money trail, built on the shared `MoneyTrail` primitive (no local copy of the
 * component). Every figure is a stored cent from `payApps.g703.getPayApp`: the claimed gross, the
 * rules recommendation, the GC's approved gross, this app's retainage and the net payment due.
 *
 * The retainage is the stored G702 figure for the view's basis — the requested summary until the GC
 * decides, the approved summary after that. It is never derived from the review suggestion or the
 * requested net: that subtraction rendered a negative "Retainage this draw" on reviewed apps, and on
 * a later application it would include the previous certificates.
 *
 * The net payment is the hero — the largest number on the page and the only step with its own row
 * on a phone — because that is the number the trade opened the page for.
 */
export function PayAppMoneyTrail({ view, terms }: { view: PayAppView; terms: Terms }) {
  const claimed = view.approvalHistory.requestedGrossCents;
  const suggested = view.reviewSuggestedTotalCents;
  const approved = view.approvalHistory.approvedGrossCents;
  const retainage = view.summary.retainageCents;
  const net = view.summary.currentPaymentDueCents;
  // `summary` is the requested G702 until the GC approves; the same approved basis that produces
  // `approvedGrossCents` produces the approved retainage. `decided` therefore names the state whose
  // stored retainage was actually withheld.
  const decided = approved !== null;
  const residential = terms.kind === "residential";
  const paid = view.status === "paid";
  const appWord = residential ? "draw" : "application";

  const steps: MoneyTrailStep[] = [
    { label: "Claimed", valueCents: claimed, note: "Billed by the sub" },
    ...(suggested !== null
      ? [{ label: "Review suggests", valueCents: suggested, note: "Rules check only" }]
      : []),
    { label: "GC approved", valueCents: approved, note: approved === null ? "Not decided yet" : "Final amount" },
    {
      label: residential ? "Retainage this draw" : "Retainage this app",
      valueCents: retainage,
      tone: decided && retainage > 0 ? ("warning" as const) : ("default" as const),
      note: decided ? (retainage > 0 ? "Withheld" : "Nothing withheld") : "Not withheld yet",
    },
  ];

  const netStep: MoneyTrailStep = {
    label: residential ? "Net this draw" : "Net this app",
    valueCents: net,
    tone: "positive",
    note: paid ? "Paid by PayPal" : "Paid after the GC approves",
  };

  const footer = (
    <>
      <p className="text-xs text-ink-subtle" data-testid="payapp-retainage-total">
        {decided
          ? `Total retainage held to date: ${formatCents(retainage)}${residential ? "." : " (G702 line 5)."} This ${appWord} withheld ${formatCents(retainage)}.`
          : `Retainage on this ${appWord}: ${formatCents(retainage)}. Not withheld yet; the GC has not approved this ${appWord}.`}
      </p>
      {suggested !== null && approved !== null && suggested !== approved ? (
        <p className="text-xs text-ink-subtle" data-testid="payapp-money-trail-edit">
          The GC approved {formatCents(Math.abs(approved - suggested))} {approved < suggested ? "below" : "above"} the review suggestion.
          Per-line reasons, when entered, are under the GC decision below.
        </p>
      ) : null}
    </>
  );

  return (
    <MoneyTrail
      testId="payapp-money-trail"
      title="Money trail"
      description="Every figure is computed from the schedule of values. PayPal settles only after the GC approves."
      ariaLabel="Money trail for this pay application"
      hero={netStep}
      steps={steps}
      footer={footer}
    />
  );
}
