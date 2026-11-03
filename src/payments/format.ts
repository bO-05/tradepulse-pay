export { formatCents } from "../../convex/lib/money";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Legacy agreement amounts (contractSum) are stored in dollars. */
export function formatDollars(amount: number): string {
  return usd.format(amount);
}

/** Dates default to UTC so a timestamp and its labeled UTC time never show different calendar days. */
export function formatDate(ms: number | null | undefined, opts: { utc?: boolean } = {}): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(opts.utc === false ? {} : { timeZone: "UTC" }),
  });
}
