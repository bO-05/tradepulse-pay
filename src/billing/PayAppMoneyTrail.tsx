import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { lineIncrementCents } from "../../convex/payApps/g703Math";
import type { Terms } from "../lib/terms";
import { MoneyTrail, formatCents, type MoneyTrailStep } from "../ui";

export type PayAppView = NonNullable<FunctionReturnType<typeof api.payApps.g703.getPayApp>>;
type PayAppLine = PayAppView["lines"][number];

/** The submitted line increment is kept on an approved sheet beside the GC-approved increment. */
function requestedLineCents(line: PayAppLine): number {
  return lineIncrementCents({
    workThisPeriodCents: line.requestedWorkCents ?? line.workThisPeriodCents,
    storedCents: line.requestedStoredCents ?? line.storedCents,
    previousStoredCents: line.previousStoredCents,
  });
}

/** Kept downward decisions, with the description and cents read from the stored decision and sheet. */
function keptCuts(view: PayAppView) {
  const lines = new Map(view.lines.map((line) => [line.sovLineId, line]));
  return (view.decision?.lines ?? []).flatMap((decision) => {
    const line = lines.get(decision.sovLineId);
    if (!line || decision.action !== "override") return [];
    const requested = requestedLineCents(line);
    if (requested <= decision.approvedCents) return [];
    return [{
      description: decision.description,
      cutCents: requested - decision.approvedCents,
      approvedCents: decision.approvedCents,
    }];
  });
}

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
  const cuts = residential && view.readOnlyReference ? keptCuts(view) : [];

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
        residential ? (
          <>
            <p className="text-xs text-ink-subtle" data-testid="payapp-money-trail-edit">
              Conservative review: funded or in-progress milestones are credited at 50% of their share.
              Work in place is reported by the subcontractor, not independently inspected.
              The GC made the final decision with a recorded per-line reason for every override.
            </p>
            {cuts.length > 0 ? (
              <p className="text-xs text-ink-subtle" data-testid="payapp-kept-cuts">
                Caught overbill: {cuts.map((cut) => `${cut.description} was cut by ${formatCents(cut.cutCents)} to ${formatCents(cut.approvedCents)}, and the GC kept that cut.`).join(" ")}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-ink-subtle" data-testid="payapp-money-trail-edit">
            The GC approved {formatCents(Math.abs(approved - suggested))} {approved < suggested ? "below" : "above"} the review suggestion.
            Per-line reasons, when entered, are under the GC decision below.
          </p>
        )
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
