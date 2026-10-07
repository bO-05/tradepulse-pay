export { formatCents } from "../../convex/lib/money";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Legacy agreement amounts (contractSum) are stored in dollars. */
export function formatDollars(amount: number): string {
  return usd.format(amount);
}

/** `utc` is for calendar dates stored as UTC midnight, which would otherwise show the previous day west of UTC. */
export function formatDate(ms: number | null | undefined, opts: { utc?: boolean } = {}): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(opts.utc ? { timeZone: "UTC" } : {}),
  });
}
