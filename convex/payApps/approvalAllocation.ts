/**
 * Splits a GC-approved pay-app total across its SOV lines in integer cents. The review's
 * per-line recommendations stay on the pay app for audit; this produces the final per-line
 * amounts that later billing math uses.
 */
import { formatCents } from "../lib/money";

export type AllocationLine = {
  sovLineId: string;
  lineNo: number;
  excludedScope: boolean;
  /** Code-computed review recommendation for this line. */
  recommendedCents: number;
  /** What the line may still bill on this pay app: min(requested, scheduled value − billed by other pay apps). */
  capCents: number;
};

export type AllocationResult =
  | { ok: true; lines: { sovLineId: string; approvedCents: number }[]; totalCents: number }
  | { ok: false; message: string; maxCents: number };

function share(total: number, weight: number, sum: number): number {
  // BigInt keeps total × weight exact past 2^53.
  return Number((BigInt(total) * BigInt(weight)) / BigInt(sum));
}

/**
 * Downward totals scale the recommendations; upward totals keep the recommendations and spread the
 * extra over base-scope headroom (cap − recommendation). Excluded-scope lines never receive more
 * than their recommendation. Floor-rounding leftovers go to the last base-scope line first (by line
 * number, as in the SOV rounding rule), then earlier lines, never past a line's limit.
 *
 * A line with a negative cap is a deductive change-order credit: it is always approved at that cap,
 * and `totalCents` is the net, so the other lines share the total plus the credits.
 */
export function allocateApprovedTotal(lines: readonly AllocationLine[], totalCents: number): AllocationResult {
  const credits = new Map(lines.filter((l) => l.capCents < 0).map((l) => [l.sovLineId, Math.ceil(l.capCents)]));
  const creditCents = [...credits.values()].reduce((a, c) => a + c, 0);
  const rows = lines
    .filter((l) => !credits.has(l.sovLineId))
    .map((l) => {
      const cap = Math.max(0, Math.floor(l.capCents));
      const rec = Math.min(cap, Math.max(0, Math.floor(l.recommendedCents)));
      return { ...l, cap, rec, headroom: l.excludedScope ? 0 : cap - rec };
    });
  const recTotal = rows.reduce((a, r) => a + r.rec, 0);
  const headroomTotal = rows.reduce((a, r) => a + r.headroom, 0);
  const maxCents = recTotal + headroomTotal + creditCents;
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    return { ok: false, message: "The approved amount must be a whole, non-negative number of cents.", maxCents };
  }
  if (totalCents > maxCents) {
    return {
      ok: false,
      message: `The approved amount exceeds what this pay application's base-scope lines can still bill: at most ${formatCents(maxCents)} within each line's request and remaining scheduled value${
        creditCents < 0 ? `, net of ${formatCents(creditCents)} in deductive change-order credits` : ""
      }.`,
      maxCents,
    };
  }

  const grossCents = totalCents - creditCents;
  const upward = grossCents > recTotal;
  const extra = grossCents - recTotal;
  const alloc = rows.map((r) => {
    if (!upward) return { r, cents: recTotal === 0 ? 0 : share(grossCents, r.rec, recTotal), limit: r.rec };
    return { r, cents: r.rec + (headroomTotal === 0 ? 0 : share(extra, r.headroom, headroomTotal)), limit: r.rec + r.headroom };
  });
  let leftover = grossCents - alloc.reduce((a, x) => a + x.cents, 0);
  const fillOrder = [...alloc].sort((a, b) => {
    if (a.r.excludedScope !== b.r.excludedScope) return a.r.excludedScope ? 1 : -1;
    return b.r.lineNo - a.r.lineNo;
  });
  for (const x of fillOrder) {
    if (leftover === 0) break;
    const add = Math.min(leftover, x.limit - x.cents);
    x.cents += add;
    leftover -= add;
  }
  const allocated = new Map(alloc.map((x) => [x.r.sovLineId, x.cents]));
  return {
    ok: true,
    lines: lines.map((l) => ({ sovLineId: l.sovLineId, approvedCents: credits.get(l.sovLineId) ?? allocated.get(l.sovLineId)! })),
    totalCents,
  };
}
