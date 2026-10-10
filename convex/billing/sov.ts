import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { auditActor, requireDocScope } from "../lib/projectScope";
import type { ProjectAccess } from "../lib/tenancy";
import { formatCents } from "../lib/money";
import {
  SOV_LOCKED_MESSAGE,
  SOV_MAX_ROWS,
  SOV_TOO_MANY_ROWS,
  sovApprovalProblem,
  sovLineProblems,
  sumSovCents,
  type SovLineInput,
} from "../lib/sovRules";
import { agreementContractSumCents, sovIsApproved } from "../payments/sov";
import { buildSovLines, sovSourceFingerprint } from "../payments/sovMath";

/**
 * The GC's schedule-of-values editor (§16). Draft lines are prefilled from the award and edited,
 * reordered, imported or reset by GC members; approval requires an exact sum and locks the lines.
 * Subs on the agreement read the approved SOV; owners, other subs and other companies get "Not found.".
 */

async function loadLines(ctx: QueryCtx, agreementId: Id<"agreements">): Promise<Doc<"scheduleOfValues">[]> {
  const rows = await ctx.db
    .query("scheduleOfValues")
    .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreementId))
    .take(SOV_MAX_ROWS + 100);
  return rows.sort((a, b) => a.lineNo - b.lineNo || a._creationTime - b._creationTime);
}

function lineView(l: Doc<"scheduleOfValues">) {
  return {
    _id: l._id,
    lineNo: l.lineNo,
    description: l.description,
    csiCode: l.csiCode ?? "",
    scheduledValueCents: l.scheduledValueCents,
    fromBid: l.sourceBidLineRef !== undefined,
    changeOrderId: l.changeOrderId ?? null,
    fromChangeOrder: l.changeOrderId !== undefined,
  };
}

/** The SOV of one agreement. Subs see the lines only once the GC approved them. */
export const getSov = query({
  args: { agreementId: v.string() },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "agreements", args.agreementId, { roles: ["gc", "sub"] });
    const agreement = scope.doc;
    const isGc = scope.partyRole === "gc";
    const approved = sovIsApproved(agreement);
    const lines = isGc || approved ? await loadLines(ctx, agreement._id) : [];
    const contractSumCents = agreementContractSumCents(agreement);
    const totalCents = sumSovCents(lines);
    const changeOrderLines = lines.filter((l) => l.changeOrderId !== undefined);
    const netChangeCents = sumSovCents(changeOrderLines);
    return {
      agreementId: agreement._id,
      agreementNumber: agreement.agreementNumber,
      subcontractorName: agreement.subcontractorName,
      projectTitle: agreement.projectTitle,
      agreementStatus: agreement.status,
      status: approved ? ("approved" as const) : ("draft" as const),
      approvedAt: agreement.sov?.approvedAt ?? null,
      approvedByName: agreement.sov?.approvedByName ?? null,
      contractSumCents,
      totalCents,
      // Approved change orders append lines; the original contract sum is never rewritten.
      originalContractSumCents: contractSumCents,
      netChangeOrdersCents: netChangeCents,
      contractSumToDateCents: contractSumCents + netChangeCents,
      differenceCents: totalCents - netChangeCents - contractSumCents,
      excludedScopeNotes: agreement.excludedScopeNotes ?? [],
      canEdit: isGc && !approved && agreement.status !== "superseded",
      approvalProblem: isGc && !approved ? sovApprovalProblem(contractSumCents, lines) : null,
      lines: lines.map(lineView),
    };
  },
});

const GC_WRITE = { roles: ["gc" as const], write: true };

export const CHANGE_ORDER_LINE_MESSAGE =
  "This line comes from an approved change order and cannot be edited or deleted – create a new change order";

function editableAgreement<S extends ProjectAccess & { doc: Doc<"agreements"> }>(scope: S): S {
  assertEditable(scope.doc);
  return scope;
}

async function editableLine<S extends ProjectAccess & { doc: Doc<"scheduleOfValues"> }>(
  ctx: MutationCtx,
  scope: S,
): Promise<S & { agreement: Doc<"agreements"> }> {
  const agreement = await ctx.db.get(scope.doc.agreementId);
  if (agreement === null) throw new ConvexError({ code: "NOT_FOUND", message: "Not found." });
  if (scope.doc.changeOrderId !== undefined) {
    throw new ConvexError({ code: "CHANGE_ORDER_LINE", message: CHANGE_ORDER_LINE_MESSAGE });
  }
  assertEditable(agreement);
  return { ...scope, agreement };
}

function assertEditable(agreement: Doc<"agreements">): void {
  if (sovIsApproved(agreement)) throw new ConvexError({ code: "SOV_LOCKED", message: SOV_LOCKED_MESSAGE });
  if (agreement.status === "superseded") {
    throw new ConvexError({ code: "INVALID_STATE", message: "This agreement is superseded; its schedule of values is read-only." });
  }
}

function cleanLine(line: SovLineInput, label: string): { description: string; csiCode?: string; scheduledValueCents: number } {
  const problems = sovLineProblems(line);
  if (problems.length > 0) {
    throw new ConvexError({ code: "INVALID_SOV_LINE", message: `${label}: ${problems.join("; ")}.` });
  }
  const csiCode = (line.csiCode ?? "").trim();
  return { description: line.description.trim(), ...(csiCode ? { csiCode } : {}), scheduledValueCents: line.scheduledValueCents };
}

async function markEdited(ctx: MutationCtx, agreement: Doc<"agreements">): Promise<void> {
  await ctx.db.patch(agreement._id, { sov: { status: "draft", editedAt: Date.now() } });
}

/** Line numbers 1..n in the current order. */
async function renumber(ctx: MutationCtx, lines: Doc<"scheduleOfValues">[]): Promise<void> {
  for (const [i, line] of lines.entries()) {
    if (line.lineNo !== i + 1) await ctx.db.patch(line._id, { lineNo: i + 1 });
  }
}

/**
 * Keeps funding milestones pointing at live lines: a milestone that covered every line keeps
 * covering every line; others drop deleted lines.
 */
async function relinkMilestones(
  ctx: MutationCtx,
  agreementId: Id<"agreements">,
  before: readonly Id<"scheduleOfValues">[],
  after: readonly Id<"scheduleOfValues">[],
): Promise<void> {
  const milestones = await ctx.db
    .query("milestones")
    .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreementId))
    .take(100);
  const beforeSet = new Set<string>(before);
  const afterSet = new Set<string>(after);
  for (const m of milestones) {
    const coveredAll = m.sovLineIds.length === beforeSet.size && m.sovLineIds.every((id) => beforeSet.has(id));
    const next = coveredAll ? [...after] : m.sovLineIds.filter((id) => afterSet.has(id));
    const same = next.length === m.sovLineIds.length && next.every((id, i) => id === m.sovLineIds[i]);
    if (!same) await ctx.db.patch(m._id, { sovLineIds: next });
  }
}

async function replaceLines(
  ctx: MutationCtx,
  agreement: Doc<"agreements">,
  next: readonly (Omit<Doc<"scheduleOfValues">, "_id" | "_creationTime" | "agreementId" | "lineNo">)[],
): Promise<void> {
  const existing = await loadLines(ctx, agreement._id);
  for (const line of existing) await ctx.db.delete(line._id);
  const ids: Id<"scheduleOfValues">[] = [];
  for (const [i, line] of next.entries()) {
    ids.push(await ctx.db.insert("scheduleOfValues", { agreementId: agreement._id, lineNo: i + 1, ...line }));
  }
  await relinkMilestones(
    ctx,
    agreement._id,
    existing.map((l) => l._id),
    ids,
  );
}

const lineFields = {
  description: v.string(),
  csiCode: v.optional(v.string()),
  scheduledValueCents: v.number(),
};

export const addSovLine = mutation({
  args: { agreementId: v.string(), ...lineFields },
  handler: async (ctx, args) => {
    const scope = editableAgreement(await requireDocScope(ctx, "agreements", args.agreementId, GC_WRITE));
    const lines = await loadLines(ctx, scope.doc._id);
    if (lines.length >= SOV_MAX_ROWS) throw new ConvexError({ code: "LIMIT", message: `A schedule of values can have at most ${SOV_MAX_ROWS} lines.` });
    const line = cleanLine(args, `Line ${lines.length + 1}`);
    const id = await ctx.db.insert("scheduleOfValues", {
      agreementId: scope.doc._id,
      lineNo: lines.length + 1,
      ...line,
      excludedScope: false,
    });
    await relinkMilestones(
      ctx,
      scope.doc._id,
      lines.map((l) => l._id),
      [...lines.map((l) => l._id), id],
    );
    await markEdited(ctx, scope.doc);
    return id;
  },
});

export const updateSovLine = mutation({
  args: { lineId: v.string(), ...lineFields },
  handler: async (ctx, args) => {
    const scope = await editableLine(ctx, await requireDocScope(ctx, "scheduleOfValues", args.lineId, GC_WRITE));
    const line = cleanLine(args, `Line ${scope.doc.lineNo}`);
    await ctx.db.patch(scope.doc._id, { ...line, ...(line.csiCode === undefined ? { csiCode: undefined } : {}) });
    await markEdited(ctx, scope.agreement);
    return null;
  },
});

export const deleteSovLine = mutation({
  args: { lineId: v.string() },
  handler: async (ctx, args) => {
    const scope = await editableLine(ctx, await requireDocScope(ctx, "scheduleOfValues", args.lineId, GC_WRITE));
    const before = await loadLines(ctx, scope.agreement._id);
    await ctx.db.delete(scope.doc._id);
    const after = before.filter((l) => l._id !== scope.doc._id);
    await renumber(ctx, after);
    await relinkMilestones(
      ctx,
      scope.agreement._id,
      before.map((l) => l._id),
      after.map((l) => l._id),
    );
    await markEdited(ctx, scope.agreement);
    return null;
  },
});

export const moveSovLine = mutation({
  args: { lineId: v.string(), direction: v.union(v.literal("up"), v.literal("down")) },
  handler: async (ctx, args) => {
    const scope = await editableLine(ctx, await requireDocScope(ctx, "scheduleOfValues", args.lineId, GC_WRITE));
    const lines = await loadLines(ctx, scope.agreement._id);
    const i = lines.findIndex((l) => l._id === scope.doc._id);
    const j = args.direction === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= lines.length) return null;
    [lines[i], lines[j]] = [lines[j], lines[i]];
    await renumber(ctx, lines);
    await markEdited(ctx, scope.agreement);
    return null;
  },
});

/**
 * Replaces every draft line with imported rows. All rows are re-checked here (limits, lengths,
 * whole non-negative cents) and one bad row refuses the whole import.
 */
export const importSovLines = mutation({
  args: {
    agreementId: v.string(),
    rows: v.array(v.object(lineFields)),
  },
  handler: async (ctx, args) => {
    const scope = editableAgreement(await requireDocScope(ctx, "agreements", args.agreementId, GC_WRITE));
    if (args.rows.length > SOV_MAX_ROWS) throw new ConvexError({ code: "LIMIT", message: SOV_TOO_MANY_ROWS });
    if (args.rows.length === 0) throw new ConvexError({ code: "INVALID_IMPORT", message: "The file has no SOV rows to import." });
    const errors: string[] = [];
    for (const [i, row] of args.rows.entries()) {
      const problems = sovLineProblems(row);
      if (problems.length > 0) errors.push(`Line ${i + 1}: ${problems.join("; ")}.`);
    }
    if (errors.length > 0) {
      throw new ConvexError({
        code: "INVALID_IMPORT",
        message: `Nothing was imported. ${errors.slice(0, 20).join(" ")}${errors.length > 20 ? ` (${errors.length - 20} more)` : ""}`,
        errors: errors.slice(0, 100),
      });
    }
    const rows = args.rows.map((r, i) => ({ ...cleanLine(r, `Line ${i + 1}`), excludedScope: false }));
    await replaceLines(ctx, scope.doc, rows);
    await markEdited(ctx, scope.doc);
    await ctx.db.insert("auditLogs", {
      projectId: scope.doc.projectId,
      tradePackageId: scope.doc.tradePackageId,
      agreementId: scope.doc._id,
      eventType: "compliance_audit",
      title: `Schedule of values imported: ${scope.doc.agreementNumber}`,
      description: `${rows.length} draft lines totalling ${formatCents(sumSovCents(rows))} replaced the previous draft.`,
      ...auditActor(scope),
      timestamp: Date.now(),
    });
    return { imported: rows.length, totalCents: sumSovCents(rows) };
  },
});

/** Discards the draft and prefills it again from the awarded bid (base lines plus accepted alternates). */
export const resetSovFromBid = mutation({
  args: { agreementId: v.string() },
  handler: async (ctx, args) => {
    const scope = editableAgreement(await requireDocScope(ctx, "agreements", args.agreementId, GC_WRITE));
    const agreement = scope.doc;
    const contractSumCents = agreementContractSumCents(agreement);
    const bid = await ctx.db.get(agreement.bidId);
    const lineItems = bid?.lineItems ?? [];
    const acceptedAlternates = agreement.acceptedAlternates ?? [];
    const fingerprint = sovSourceFingerprint({
      bidId: agreement.bidId,
      contractSumCents,
      lineItems,
      acceptedAlternates,
      leadWeeks: bid?.longLeadEquipmentWeeks ?? 0,
    });
    const drafts = buildSovLines({
      contractSumCents,
      lineItems,
      acceptedAlternates,
      csiDivision: agreement.csiDivision,
      tradeName: agreement.tradeName,
    });
    await replaceLines(
      ctx,
      agreement,
      drafts.map(({ lineNo: _lineNo, ...d }) => ({ ...d, sourceFingerprint: fingerprint })),
    );
    await ctx.db.patch(agreement._id, { sov: { status: "draft" } });
    return { lines: drafts.length };
  },
});

/** Approves the SOV once its lines sum exactly to the contract sum; the lines are then locked. */
export const approveSov = mutation({
  args: { agreementId: v.string() },
  handler: async (ctx, args) => {
    const scope = editableAgreement(await requireDocScope(ctx, "agreements", args.agreementId, GC_WRITE));
    const agreement = scope.doc;
    const lines = await loadLines(ctx, agreement._id);
    for (const line of lines) {
      const problems = sovLineProblems({ ...line, csiCode: line.csiCode });
      if (problems.length > 0) {
        throw new ConvexError({ code: "INVALID_SOV_LINE", message: `Line ${line.lineNo}: ${problems.join("; ")}.` });
      }
    }
    const contractSumCents = agreementContractSumCents(agreement);
    const problem = sovApprovalProblem(contractSumCents, lines);
    if (problem !== null) {
      throw new ConvexError({
        code: "SOV_SUM_MISMATCH",
        message: problem,
        contractSumCents,
        totalCents: sumSovCents(lines),
      });
    }
    const actor = auditActor(scope);
    const now = Date.now();
    await ctx.db.patch(agreement._id, {
      sov: {
        status: "approved",
        ...(agreement.sov?.editedAt !== undefined ? { editedAt: agreement.sov.editedAt } : {}),
        approvedAt: now,
        approvedByUserId: actor.actorUserId,
        approvedByName: actor.actor,
      },
    });
    await ctx.db.insert("auditLogs", {
      projectId: agreement.projectId,
      tradePackageId: agreement.tradePackageId,
      agreementId: agreement._id,
      eventType: "compliance_audit",
      title: `Schedule of values approved: ${agreement.agreementNumber}`,
      description: `${lines.length} lines totalling ${formatCents(contractSumCents)} approved and locked. Changes only through change orders.`,
      ...actor,
      timestamp: now,
    });
    return { approvedAt: now };
  },
});
