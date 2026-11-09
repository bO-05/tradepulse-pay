import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Terms } from "../lib/terms";
import { MoneyTrail, formatCents, type MoneyTrailStep } from "../ui";

export type PayAppView = NonNullable<FunctionReturnType<typeof api.payApps.g703.getPayApp>>;

/**
 * The sub pay app's money trail, built on the shared `MoneyTrail` primitive (no local copy of the
 * component). Every figure is a stored cent from `payApps.g703.getPayApp`: the claimed gross, the
 * rules recommendation, the GC's approved gross, this draw's retainage and the net payment due.
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
  const grossThisApp = approved ?? suggested;
  const periodRetainage = grossThisApp !== null ? grossThisApp - net : null;
  const residential = terms.kind === "residential";
  const paid = view.status === "paid";

  const steps: MoneyTrailStep[] = [
    { label: "Claimed", valueCents: claimed, note: "Billed by the sub" },
    ...(suggested !== null
      ? [{ label: "Review suggests", valueCents: suggested, note: "Rules check only" }]
      : []),
    { label: "GC approved", valueCents: approved, note: approved === null ? "Not decided yet" : "Final amount" },
    periodRetainage !== null
      ? {
          label: residential ? "Retainage this draw" : "Retainage this app",
          valueCents: periodRetainage,
          tone: periodRetainage > 0 ? ("warning" as const) : ("default" as const),
          note: periodRetainage > 0 ? "Withheld" : "Nothing withheld",
        }
      : {
          label: "Total retainage held",
          valueCents: retainage,
          tone: retainage > 0 ? ("warning" as const) : ("default" as const),
          note: retainage > 0 ? "Withheld" : "Nothing withheld",
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
        Total retainage held to date: {formatCents(retainage)}
        {residential ? "." : " (G702 line 5)."}
        {periodRetainage !== null ? ` This ${residential ? "draw" : "application"} withheld ${formatCents(periodRetainage)}.` : ""}
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
