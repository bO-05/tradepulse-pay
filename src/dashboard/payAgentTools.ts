import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";

export type PaySummary = FunctionReturnType<typeof api.dashboard.payAgent.getPaySummary>;
type PayRow = PaySummary["agreements"][number];

function matches(row: PayRow, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  return [row.subcontractor, row.agreementNumber, row.trade, row.project]
    .filter((v): v is string => typeof v === "string")
    .some((v) => v.toLowerCase().includes(n));
}

/** Filters ledger rows by subcontractor, agreement number, trade or project (case-insensitive substring). */
export function filterPaySummary(summary: PaySummary, query?: string): PayRow[] {
  return query ? summary.agreements.filter((row) => matches(row, query)) : summary.agreements;
}

/**
 * The text the pay agent's ledger tool returns to the model. Every amount comes pre-formatted
 * from Convex so the model only quotes figures, never computes them.
 */
export function describePaySummary(summary: PaySummary, query?: string): string {
  const rows = filterPaySummary(summary, query);
  if (rows.length === 0) {
    const names = summary.agreements.map((r) => r.subcontractor).filter(Boolean);
    return query
      ? `No agreement matches "${query}". Subcontractors on record: ${[...new Set(names)].join(", ") || "none"}.`
      : "There are no agreements.";
  }
  const subs = new Set(rows.map((r) => r.subcontractor));
  const totals = summary.subcontractors
    .filter((s) => subs.has(s.subcontractor))
    .map(
      (s) =>
        `${s.subcontractor} TOTAL across ${s.agreementCount} agreement(s): retainage held ${s.formatted.retainageHeld} (released ${s.formatted.retainageReleased}); paid (net) ${s.formatted.paid}; billed ${s.formatted.billed}`,
    );
  const lines = rows.map((r) => {
    const f = r.formatted;
    return [
      `Agreement ${r.agreementNumber ?? r.agreementId} - ${r.subcontractor ?? "Unknown subcontractor"}${r.trade ? ` (${r.trade})` : ""}, status ${r.status}`,
      `  retainage held: ${f.retainageHeld} (retainage rate ${r.retainagePercent}%, released so far ${f.retainageReleased})`,
      `  paid (net): ${f.paid}; billed (approved pay apps): ${f.billed}; funded and not captured: ${f.funded}; captured: ${f.captured}`,
      `  contract sum: ${f.contractSum}; balance (contract sum - (paid + retainage held)): ${f.balance}`,
    ].join("\n");
  });
  return [
    `Source: TradePulse Convex payment ledger (live). ${rows.length} agreement(s).`,
    ...(summary.incomplete
      ? ["DATA INCOMPLETE: the history exceeded a safety bound, so these totals understate the full ledger. Say so in the answer."]
      : []),
    "Subcontractor totals (computed by Convex in integer cents; quote these for a subcontractor-level question):",
    ...totals.map((t) => `- ${t}`),
    "Per agreement:",
    ...lines,
  ].join("\n");
}
