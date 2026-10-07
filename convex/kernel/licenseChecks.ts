import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireRole } from "../lib/roles";
import { licenseStatusValidator } from "../schema";
import { CACHEABLE_STATUSES, LICENSE_CACHE_MS, RUNNING_STALE_MS, normalizeLicenseNumber, type CslbStatus } from "./cslb";

export function isRunning(row: Doc<"licenseChecks">, now: number): boolean {
  return row.phase === "running" && now - (row.startedAt ?? row.checkedAt) < RUNNING_STALE_MS;
}

/** Latest finished check for a contractor (any license number). Running rows are skipped. */
export async function latestCompletedCheck(
  ctx: QueryCtx,
  contractorId: Id<"contractors">,
): Promise<Doc<"licenseChecks"> | null> {
  const rows = await ctx.db
    .query("licenseChecks")
    .withIndex("by_contractorId_and_checkedAt", (q) => q.eq("contractorId", contractorId))
    .order("desc")
    .take(20);
  return rows.find((r) => r.phase !== "running") ?? null;
}

type Reusable = { kind: "cached" | "in_flight"; row: Doc<"licenseChecks"> };

/** A definitive CSLB result from the last 24 h, or a check already running for the same number. */
export async function findReusableCheck(
  ctx: QueryCtx,
  contractorId: Id<"contractors">,
  licenseNumber: string,
  now: number,
): Promise<Reusable | null> {
  const rows = await ctx.db
    .query("licenseChecks")
    .withIndex("by_contractorId_and_licenseNumber_and_checkedAt", (q) =>
      q.eq("contractorId", contractorId).eq("licenseNumber", licenseNumber).gte("checkedAt", now - LICENSE_CACHE_MS),
    )
    .order("desc")
    .take(20);
  for (const row of rows) {
    if (row.phase === "running") {
      if (isRunning(row, now)) return { kind: "in_flight", row };
      continue;
    }
    if (CACHEABLE_STATUSES.has(row.status) && row.cacheCleared !== true) return { kind: "cached", row };
  }
  return null;
}

export type BeginResult =
  | { kind: "cached" | "in_flight" | "no_license"; checkId: Id<"licenseChecks"> }
  | { kind: "started"; checkId: Id<"licenseChecks">; licenseNumber: string };

export async function beginCheckInTx(
  ctx: MutationCtx,
  contractorId: Id<"contractors">,
  trigger: string,
): Promise<BeginResult> {
  const contractor = await ctx.db.get(contractorId);
  if (contractor === null) throw new ConvexError({ code: "NOT_FOUND", message: "Contractor not found." });
  const licenseNumber = normalizeLicenseNumber(contractor.licenseNumber ?? "");
  const now = Date.now();
  if (licenseNumber === "" || /^not verified$/i.test(licenseNumber)) {
    const checkId = await ctx.db.insert("licenseChecks", {
      contractorId,
      licenseNumber: licenseNumber || "none",
      state: "CA",
      status: "unverified",
      rawSummary: "No license number is on file for this contractor, so no CSLB lookup was run.",
      checkedAt: now,
      phase: "done",
      startedAt: now,
      durationMs: 0,
      trigger,
    });
    return { kind: "no_license", checkId };
  }
  const reusable = await findReusableCheck(ctx, contractorId, licenseNumber, now);
  if (reusable !== null) return { kind: reusable.kind, checkId: reusable.row._id };
  const checkId = await ctx.db.insert("licenseChecks", {
    contractorId,
    licenseNumber,
    state: "CA",
    status: "unverified",
    rawSummary: "CSLB lookup in progress.",
    checkedAt: now,
    phase: "running",
    startedAt: now,
    trigger,
  });
  await ctx.scheduler.runAfter(RUNNING_STALE_MS, internal.kernel.licenseChecks.expireStaleCheck, { checkId });
  return { kind: "started", checkId, licenseNumber };
}

/** Closes a lookup whose action died before finishing, so it never stays "running". */
export const expireStaleCheck = internalMutation({
  args: { checkId: v.id("licenseChecks") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.checkId);
    if (row === null || row.phase !== "running") return null;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "unverified",
      rawSummary: "CSLB lookup did not finish within 3 minutes; the license is unverified.",
      phase: "done",
      checkedAt: now,
      durationMs: now - (row.startedAt ?? row.checkedAt),
    });
    return null;
  },
});

export const beginCheck = internalMutation({
  args: { contractorId: v.id("contractors"), trigger: v.string() },
  handler: async (ctx, args): Promise<BeginResult> => await beginCheckInTx(ctx, args.contractorId, args.trigger),
});

export const attachBrowser = internalMutation({
  args: { checkId: v.id("licenseChecks"), kernelSessionId: v.string(), liveViewUrl: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.checkId);
    if (row === null || row.phase !== "running") return null;
    await ctx.db.patch(args.checkId, { kernelSessionId: args.kernelSessionId, liveViewUrl: args.liveViewUrl });
    return null;
  },
});

export const finishCheck = internalMutation({
  args: {
    checkId: v.id("licenseChecks"),
    status: licenseStatusValidator,
    rawSummary: v.string(),
    browserDeleted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.checkId);
    if (row === null) return null;
    const now = Date.now();
    await ctx.db.patch(args.checkId, {
      status: args.status,
      rawSummary: args.rawSummary,
      browserDeleted: args.browserDeleted,
      phase: "done",
      checkedAt: now,
      durationMs: now - (row.startedAt ?? row.checkedAt),
    });
    const contractor = await ctx.db.get(row.contractorId);
    await ctx.db.insert("auditLogs", {
      eventType: "license_check",
      title: "CSLB license check",
      description: `${contractor?.companyName ?? "Contractor"} CA license #${row.licenseNumber}: ${args.status}.`,
      actor: "KERNEL hosted browser",
      timestamp: now,
      operation: "kernel.cslb.lookup",
    });
    return null;
  },
});

/** Operator/validator helper: makes the next check for this contractor run a fresh lookup. */
export const clearLicenseCache = internalMutation({
  args: { contractorId: v.id("contractors") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("licenseChecks")
      .withIndex("by_contractorId_and_checkedAt", (q) => q.eq("contractorId", args.contractorId))
      .order("desc")
      .take(100);
    let cleared = 0;
    for (const row of rows) {
      if (row.phase === "running" || row.cacheCleared === true) continue;
      await ctx.db.patch(row._id, { cacheCleared: true });
      cleared++;
    }
    return { cleared };
  },
});

export const getCheck = internalQuery({
  args: { checkId: v.id("licenseChecks") },
  handler: async (ctx, args) => await ctx.db.get(args.checkId),
});

export const latestCompletedCheckInternal = internalQuery({
  args: { contractorId: v.id("contractors") },
  handler: async (ctx, args) => await latestCompletedCheck(ctx, args.contractorId),
});

function toView(row: Doc<"licenseChecks">) {
  return {
    _id: row._id,
    licenseNumber: row.licenseNumber,
    state: row.state,
    status: row.status as CslbStatus,
    rawSummary: row.rawSummary,
    liveViewUrl: row.liveViewUrl ?? null,
    phase: row.phase ?? "done",
    startedAt: row.startedAt ?? row.checkedAt,
    checkedAt: row.checkedAt,
    durationMs: row.durationMs ?? null,
  };
}

/** GC: the contractor's license number, the newest check (running or done) and recent history. */
export const getContractorLicense = query({
  args: { contractorId: v.string() },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);
    const id = ctx.db.normalizeId("contractors", args.contractorId);
    const contractor = id === null ? null : await ctx.db.get(id);
    if (contractor === null) return null;
    const rows = await ctx.db
      .query("licenseChecks")
      .withIndex("by_contractorId_and_checkedAt", (q) => q.eq("contractorId", contractor._id))
      .order("desc")
      .take(5);
    return {
      contractor: { _id: contractor._id, companyName: contractor.companyName, licenseNumber: contractor.licenseNumber },
      latest: rows[0] ? toView(rows[0]) : null,
      history: rows.map(toView),
    };
  },
});

/** GC asks for a CSLB check. Returns a cached result from the last 24 h without opening a browser. */
export const requestLicenseCheck = mutation({
  args: { contractorId: v.string() },
  handler: async (ctx, args): Promise<{ checkId: Id<"licenseChecks">; kind: BeginResult["kind"] }> => {
    await requireRole(ctx, ["gc"]);
    const id = ctx.db.normalizeId("contractors", args.contractorId);
    if (id === null) throw new ConvexError({ code: "NOT_FOUND", message: "Contractor not found." });
    const result = await beginCheckInTx(ctx, id, "gc");
    if (result.kind === "started") {
      await ctx.scheduler.runAfter(0, internal.kernel.licenseCheck.performLicenseCheck, {
        checkId: result.checkId,
        licenseNumber: result.licenseNumber,
      });
    }
    return { checkId: result.checkId, kind: result.kind };
  },
});
