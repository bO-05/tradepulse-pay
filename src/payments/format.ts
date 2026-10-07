export { formatCents } from "../../convex/lib/money";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Legacy agreement amounts (contractSum) are stored in dollars. */
export function formatDollars(amount: number): string {
  return usd.format(amount);
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
