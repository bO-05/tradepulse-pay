import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { formatCents } from "../lib/money";
import { auditActor, findSubcontractDocScope, requireDocScope, requireProjectScope } from "../lib/projectScope";
import type { ProjectAccess } from "../lib/tenancy";
import { sovIsApproved } from "../payments/sov";
import {
  calendarDateToMs,
  checkTrancheAmount,
  checkTrancheName,
  checkTrancheTotal,
  defaultTranchePlannedDate,
  isCalendarDate,
  plannedDateWarning,
  projectStartMs,
  type TrancheCheck,
} from "./trancheRules";
import { loadSovRows } from "../lib/sovLines";

/**
 * GC-defined funding tranches (architecture §16), stored as `milestones` rows. The GC adds, renames,
 * reorders, re-prices and deletes tranches until one is funded; the tranche total never exceeds the
 * contract sum to date (the SOV total, which includes approved change orders). Funding uses the
 * existing PayPal AUTHORIZE flow (payments/orders). Subs read their own agreement's tranches;
 * owners get a status-only projection per project.
 */

const EDITABLE_STATUSES: ReadonlySet<string> = new Set(["planned", "funding"]);

function invalid(check: TrancheCheck & { ok: false }): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "INVALID_TRANCHE", message: check.message });
}

export const TRANCHE_LOCKED_MESSAGE = "This tranche is funded; its name, amount, planned date and delete are locked.";

async function fundingRows(ctx: QueryCtx, milestoneId: Id<"milestones">): Promise<Doc<"payments">[]> {
  const rows = await ctx.db
    .query("payments")
    .withIndex("by_milestoneId", (q) => q.eq("milestoneId", milestoneId))
    .take(100);
  return rows.filter((p) => p.kind === "funding");
}

/** Locked once PayPal approved or authorized money for it, or once it moved past funding. */
export async function isTrancheLocked(ctx: QueryCtx, tranche: Doc<"milestones">): Promise<boolean> {
  if (!EDITABLE_STATUSES.has(tranche.status)) return true;
  const rows = await fundingRows(ctx, tranche._id);
  return rows.some((p) => p.paypalAuthorizationId !== undefined || p.status === "approved");
}

/** Contract sum to date: the schedule of values total, which approved change orders add lines to. */
export async function contractSumToDateCents(ctx: QueryCtx, agreementId: Id<"agreements">): Promise<number> {
  const lines = await loadSovRows(ctx, agreementId);
  return lines.reduce((acc, l) => acc + l.scheduledValueCents, 0);
}

async function tranchesOf(ctx: QueryCtx, agreementId: Id<"agreements">): Promise<Doc<"milestones">[]> {
  return await ctx.db
    .query("milestones")
    .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreementId))
    .take(50);
}

async function audit(ctx: MutationCtx, access: ProjectAccess, agreement: Doc<"agreements">, title: string, description: string) {
  await ctx.db.insert("auditLogs", {
    projectId: agreement.projectId,
    agreementId: agreement._id,
    eventType: "funding_tranche_changed",
    title,
    description: `${agreement.agreementNumber} ${description}`.slice(0, 1000),
    ...auditActor(access),
    contractorId: agreement.contractorId,
    timestamp: Date.now(),
  });
}

function parsePlannedDate(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!isCalendarDate(value.trim())) throw new ConvexError({ code: "INVALID_TRANCHE", message: "Enter the planned date as YYYY-MM-DD." });
  return calendarDateToMs(value.trim());
}

async function checkSovLines(ctx: QueryCtx, agreementId: Id<"agreements">, ids: readonly string[] | undefined): Promise<Id<"scheduleOfValues">[] | undefined> {
  if (ids === undefined) return undefined;
  const out: Id<"scheduleOfValues">[] = [];
  for (const raw of ids) {
    const id = ctx.db.normalizeId("scheduleOfValues", raw);
    const line = id === null ? null : await ctx.db.get(id);
    if (line === null || line.agreementId !== agreementId) {
      throw new ConvexError({ code: "INVALID_TRANCHE", message: "A tranche can only cover lines of this agreement's schedule of values." });
    }
    if (!out.includes(line._id)) out.push(line._id);
  }
  return out;
}

/** Abandoned PayPal checkouts of an edited tranche are expired so the next Fund creates an order for the new amount. */
async function expireOpenOrders(ctx: MutationCtx, tranche: Doc<"milestones">) {
  const now = Date.now();
  for (const p of await fundingRows(ctx, tranche._id)) {
    if (p.status === "created") {
      await ctx.db.patch(p._id, { status: "expired", error: "The tranche changed before checkout finished; replaced by a new attempt.", updatedAt: now });
    }
  }
  if (tranche.status === "funding") await ctx.db.patch(tranche._id, { status: "planned" });
}

async function trancheAgreement(ctx: MutationCtx, tranche: Doc<"milestones">): Promise<Doc<"agreements">> {
  const agreement = await ctx.db.get(tranche.agreementId);
  if (agreement === null) throw new ConvexError({ code: "NOT_FOUND", message: "Not found." });
  return agreement;
}

function requireBillable(agreement: Doc<"agreements">) {
  if (agreement.status !== "executed") {
    throw new ConvexError({ code: "INVALID_STATE", message: "Funding tranches can be added once the subcontract is executed." });
  }
  if (!sovIsApproved(agreement)) {
    throw new ConvexError({ code: "INVALID_STATE", message: "Approve the schedule of values before adding funding tranches." });
  }
}

export const createTranche = mutation({
  args: {
    agreementId: v.string(),
    name: v.string(),
    amountCents: v.number(),
    plannedDate: v.optional(v.string()),
    sovLineIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "agreements", args.agreementId, { roles: ["gc"], write: true });
    const agreement = scope.doc;
    requireBillable(agreement);
    const name = checkTrancheName(args.name);
    if (!name.ok) throw invalid(name);
    const amount = checkTrancheAmount(args.amountCents);
    if (!amount.ok) throw invalid(amount);
    const existing = await tranchesOf(ctx, agreement._id);
    const sum = await contractSumToDateCents(ctx, agreement._id);
    const total = checkTrancheTotal(
      existing.map((t) => t.amountCents),
      args.amountCents,
      sum,
    );
    if (!total.ok) throw invalid(total);
    const startMs = projectStartMs(scope.project);
    const plannedDate = parsePlannedDate(args.plannedDate, defaultTranchePlannedDate(startMs, Date.now()));
    const sovLineIds = (await checkSovLines(ctx, agreement._id, args.sovLineIds)) ?? [];
    const order = existing.reduce((max, t) => Math.max(max, t.order), 0) + 1;
    const trancheId = await ctx.db.insert("milestones", {
      agreementId: agreement._id,
      name: args.name.trim(),
      order,
      plannedDate,
      amountCents: args.amountCents,
      status: "planned",
      sovLineIds,
    });
    await audit(ctx, scope, agreement, "Funding tranche added", `GC added tranche "${args.name.trim()}" for ${formatCents(args.amountCents)}.`);
    return { trancheId, warning: plannedDateWarning(plannedDate, startMs) };
  },
});

export const updateTranche = mutation({
  args: {
    trancheId: v.string(),
    name: v.optional(v.string()),
    amountCents: v.optional(v.number()),
    plannedDate: v.optional(v.string()),
    sovLineIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "milestones", args.trancheId, { roles: ["gc"], write: true });
    const tranche = scope.doc;
    const agreement = await trancheAgreement(ctx, tranche);
    if (await isTrancheLocked(ctx, tranche)) throw new ConvexError({ code: "TRANCHE_LOCKED", message: TRANCHE_LOCKED_MESSAGE });
    const patch: Partial<Doc<"milestones">> = {};
    if (args.name !== undefined) {
      const name = checkTrancheName(args.name);
      if (!name.ok) throw invalid(name);
      patch.name = args.name.trim();
    }
    if (args.amountCents !== undefined) {
      const amount = checkTrancheAmount(args.amountCents);
      if (!amount.ok) throw invalid(amount);
      const others = (await tranchesOf(ctx, agreement._id)).filter((t) => t._id !== tranche._id);
      const total = checkTrancheTotal(
        others.map((t) => t.amountCents),
        args.amountCents,
        await contractSumToDateCents(ctx, agreement._id),
      );
      if (!total.ok) throw invalid(total);
      patch.amountCents = args.amountCents;
    }
    if (args.plannedDate !== undefined) patch.plannedDate = parsePlannedDate(args.plannedDate, tranche.plannedDate);
    const sovLineIds = await checkSovLines(ctx, agreement._id, args.sovLineIds);
    if (sovLineIds !== undefined) patch.sovLineIds = sovLineIds;
    if (Object.keys(patch).length === 0) return { trancheId: tranche._id, warning: plannedDateWarning(tranche.plannedDate, projectStartMs(scope.project)) };
    if (patch.amountCents !== undefined && patch.amountCents !== tranche.amountCents) await expireOpenOrders(ctx, tranche);
    await ctx.db.patch(tranche._id, patch);
    const changes = [
      patch.name !== undefined && patch.name !== tranche.name ? `renamed "${tranche.name}" to "${patch.name}"` : null,
      patch.amountCents !== undefined && patch.amountCents !== tranche.amountCents
        ? `changed "${tranche.name}" from ${formatCents(tranche.amountCents)} to ${formatCents(patch.amountCents)}`
        : null,
      patch.plannedDate !== undefined && patch.plannedDate !== tranche.plannedDate ? `moved the planned date of "${tranche.name}"` : null,
      patch.sovLineIds !== undefined ? `set the lines "${tranche.name}" covers` : null,
    ].filter((c): c is string => c !== null);
    if (changes.length > 0) await audit(ctx, scope, agreement, "Funding tranche changed", `GC ${changes.join(", ")}.`);
    return { trancheId: tranche._id, warning: plannedDateWarning(patch.plannedDate ?? tranche.plannedDate, projectStartMs(scope.project)) };
  },
});

export const deleteTranche = mutation({
  args: { trancheId: v.string() },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "milestones", args.trancheId, { roles: ["gc"], write: true });
    const tranche = scope.doc;
    const agreement = await trancheAgreement(ctx, tranche);
    if (await isTrancheLocked(ctx, tranche)) throw new ConvexError({ code: "TRANCHE_LOCKED", message: TRANCHE_LOCKED_MESSAGE });
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_milestoneId", (q) => q.eq("milestoneId", tranche._id))
      .take(100);
    if (payments.some((p) => p.kind !== "funding")) throw new ConvexError({ code: "TRANCHE_LOCKED", message: TRANCHE_LOCKED_MESSAGE });
    await expireOpenOrders(ctx, tranche);
    await ctx.db.delete(tranche._id);
    await audit(ctx, scope, agreement, "Funding tranche deleted", `GC deleted tranche "${tranche.name}" (${formatCents(tranche.amountCents)}).`);
    return { deleted: true };
  },
});

/** Moves a tranche one place up or down; funded tranches can be reordered too, nothing about their money changes. */
export const moveTranche = mutation({
  args: { trancheId: v.string(), direction: v.union(v.literal("up"), v.literal("down")) },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "milestones", args.trancheId, { roles: ["gc"], write: true });
    const tranche = scope.doc;
    const agreement = await trancheAgreement(ctx, tranche);
    const all = (await tranchesOf(ctx, agreement._id)).sort((a, b) => a.order - b.order);
    const i = all.findIndex((t) => t._id === tranche._id);
    const j = args.direction === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= all.length) return { moved: false };
    const other = all[j];
    // Orders may have gaps or ties from older rows; renumber 1..n with the two swapped.
    const reordered = [...all];
    reordered[i] = other;
    reordered[j] = tranche;
    for (const [k, t] of reordered.entries()) if (t.order !== k + 1) await ctx.db.patch(t._id, { order: k + 1 });
    await audit(ctx, scope, agreement, "Funding tranches reordered", `GC moved tranche "${tranche.name}" ${args.direction}.`);
    return { moved: true };
  },
});

async function trancheRows(ctx: QueryCtx, agreement: Doc<"agreements">, startMs: number | null) {
  const rows = [];
  for (const t of await tranchesOf(ctx, agreement._id)) {
    const funding = (await fundingRows(ctx, t._id)).filter((p) => p.paypalAuthorizationId !== undefined);
    const latest = funding.length > 0 ? funding[funding.length - 1] : null;
    rows.push({
      _id: t._id,
      name: t.name,
      order: t.order,
      amountCents: t.amountCents,
      plannedDate: t.plannedDate,
      status: t.status,
      sovLineIds: t.sovLineIds,
      locked: await isTrancheLocked(ctx, t),
      fundingStatus: latest?.status ?? null,
      authorizedCents: latest?.grossCents ?? 0,
      capturedCents: latest?.capturedCents ?? 0,
      dateWarning: plannedDateWarning(t.plannedDate, startMs),
    });
  }
  return rows.sort((a, b) => a.order - b.order);
}

/** One agreement's tranches for the GC (with edit state) and the agreement's own sub (read-only). */
export const listTranches = query({
  args: { agreementId: v.string() },
  handler: async (ctx, args) => {
    const scope = await findSubcontractDocScope(ctx, "agreements", args.agreementId, { roles: ["gc", "sub"] });
    if (scope === null) return null;
    const agreement = scope.doc;
    const startMs = projectStartMs(scope.project);
    const tranches = await trancheRows(ctx, agreement, startMs);
    const sum = await contractSumToDateCents(ctx, agreement._id);
    const canEdit = scope.partyRole === "gc" && agreement.status === "executed" && sovIsApproved(agreement);
    return {
      agreementId: agreement._id,
      canEdit,
      editBlockedReason:
        scope.partyRole !== "gc"
          ? null
          : agreement.status !== "executed"
            ? "Funding tranches can be added once the subcontract is executed."
            : !sovIsApproved(agreement)
              ? "Approve the schedule of values before adding funding tranches."
              : null,
      contractSumToDateCents: sum,
      trancheTotalCents: tranches.reduce((acc, t) => acc + t.amountCents, 0),
      projectStartDate: scope.project.startDate ?? null,
      defaultPlannedDate: defaultTranchePlannedDate(startMs, Date.now()),
      tranches,
    };
  },
});

/** Owner-safe projection: tranche names, amounts and funding status per trade on one project, no subcontract detail. */
export const ownerProjectTranches = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const scope = await requireProjectScope(ctx, args.projectId, { roles: ["owner", "gc"] });
    const agreements = await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", scope.project._id))
      .take(200);
    const out = [];
    for (const a of agreements) {
      if (a.status !== "executed") continue;
      const rows = await trancheRows(ctx, a, projectStartMs(scope.project));
      if (rows.length === 0) continue;
      out.push({
        trade: `${a.csiDivision} ${a.tradeName}`.trim(),
        tranches: rows.map((t) => ({ _id: t._id, name: t.name, order: t.order, amountCents: t.amountCents, status: t.status, funded: t.fundingStatus !== null })),
      });
    }
    return out;
  },
});
