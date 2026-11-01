import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { SOV_CAPACITY_MESSAGE, SOV_MAX_ROWS, SOV_MAX_TOTAL_LINES } from "./sovRules";

export function sovCapacityError(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "SOV_CAPACITY", message: SOV_CAPACITY_MESSAGE });
}

/**
 * Every schedule-of-values line of an agreement, in lineNo order. Throws instead of returning a
 * partial schedule when the agreement holds more than SOV_MAX_TOTAL_LINES lines, so no total,
 * ceiling, cleanup or export is ever computed from a truncated SOV.
 */
export async function loadSovRows(ctx: QueryCtx, agreementId: Id<"agreements">): Promise<Doc<"scheduleOfValues">[]> {
  const rows = await ctx.db
    .query("scheduleOfValues")
    .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreementId))
    .take(SOV_MAX_TOTAL_LINES + 1);
  if (rows.length > SOV_MAX_TOTAL_LINES) throw sovCapacityError();
  return rows;
}

/** Refuses a base schedule (bid prefill, reset) that would not fit the base-line capacity. */
export function assertBaseLineCapacity(count: number): void {
  if (count > SOV_MAX_ROWS) {
    throw new ConvexError({
      code: "SOV_CAPACITY",
      message: `The award has ${count.toLocaleString("en-US")} lines; a schedule of values can have at most ${SOV_MAX_ROWS.toLocaleString("en-US")} base lines.`,
    });
  }
}
