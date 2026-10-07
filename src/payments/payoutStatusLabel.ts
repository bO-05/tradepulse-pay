/** Plain-language payout state for the sub portal, keyed by the stored payout payment status. */
export function subPayoutStatusLabel(status: string | null): { status: string; net: string; tone: string } {
  switch (status) {
    case "success":
      return { status: "Paid", net: "Net paid", tone: "text-emerald-300" };
    case "unclaimed":
      return {
        status: "Unclaimed: PayPal holds the payout until you claim it",
        net: "Net (unclaimed)",
        tone: "text-orange-200",
      };
    case "returned":
      return {
        status: "Returned: PayPal returned the payout to the GC; nothing was paid",
        net: "Net (returned, not paid)",
        tone: "text-rose-300",
      };
    case "failed":
      return { status: "Failed: the payout did not go through", net: "Net (not paid)", tone: "text-rose-300" };
    case "capture_pending":
      return { status: "Pending: waiting for the GC's funds to settle", net: "Net (payout pending)", tone: "text-amber-200" };
    case "created":
    case "pending":
      return { status: "Pending: the payout is being sent", net: "Net (payout pending)", tone: "text-amber-200" };
    default:
      return { status: status ? `Payout ${status}` : "No payout yet", net: "Net (not paid)", tone: "text-slate-300" };
  }
}
