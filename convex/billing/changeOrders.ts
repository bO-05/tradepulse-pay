import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { formatCents } from "../lib/money";
import { notify } from "../lib/notify";
import { auditActor, callerProjects, findDocScope, requireDocScope, requireProjectScope } from "../lib/projectScope";
import { requireRole } from "../lib/roles";
import { loadSovRows } from "../lib/sovLines";
import { SOV_CAPACITY_MESSAGE, SOV_MAX_TOTAL_LINES } from "../lib/sovRules";
import { notFound, type ProjectAccess } from "../lib/tenancy";
import { g703Context } from "../payApps/g703";
import {
  CO_APPROVED_STATUSES,
  CO_CAPACITY,
  CO_CAPACITY_MESSAGE,
  CO_MAX_REASON,
  changeOrderEditBlock,
  changeOrderFieldErrors,
  changeOrderLabel,
  changeOrderScopeOf,
  contractSumsByApproval,
  deductiveFloorProblem,
  isDirectlyInvoiced,
  type ChangeOrderScope,
  type ChangeOrderStatus,
} from "../payments/changeOrderMath";
import { agreementContractSumCents, sovIsApproved } from "../payments/sov";
import { OWNER_APPROVED_STATUSES } from "./ownerBillingMath";
import {
  CHANGE_ORDERS_HASH,
  agreementContractSum,
  breakdownText,
  deciderOf,
  highestChangeOrderNumber,
  primeChangeOrders,
  primeContractSum,
  recipientFor,
  requesterPartyOf,
  rowViews,
  subcontractChangeOrders,
  visibleToParty,
  type CoParty,
} from "./changeOrderView";

/**
 * Change orders v2 (architecture §16, §22). A subcontract CO is drafted by the sub or the GC on one
 * agreement and decided by the GC; approval appends an SOV line "CO #n – title", which changes the
 * contract sum to date and flows into the next pay app. A prime CO is drafted by the GC on the project
 * and decided by the owner; approval changes the prime contract sum. Decided COs are immutable. Every
 * caller outside the parties gets "Not found.".
 */

const GC_SUB = ["gc", "sub"] as const;
const ALL_PARTIES = ["gc", "sub", "owner"] as const;

function invalid(message: string, fieldErrors?: Record<string, string>) {
  return new ConvexError({ code: "INVALID_ARGUMENT", message, ...(fieldErrors ? { fieldErrors } : {}) });
}

function locked(message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "CHANGE_ORDER_LOCKED", message });
}

function labelOf(co: Doc<"changeOrders">): string {
  return changeOrderLabel(co.number, changeOrderScopeOf(co));
}

function partyOf(access: ProjectAccess): CoParty {
  return access.partyRole;
}

/** Adds the caller's party to a CO scope; drafts of the other party, and COs the party never sees, are "Not found.". */
function partyScope<S extends ProjectAccess & { doc: Doc<"changeOrders"> }>(scope: S): S & { party: CoParty } {
  const party = partyOf(scope);
  if (!visibleToParty(scope.doc, party)) throw notFound();
  return { ...scope, party };
}

function cleanFields(input: { title: string; description?: string; amountCents: number; scheduleDays?: number | null }) {
  const description = input.description ?? "";
  const errors = changeOrderFieldErrors({ title: input.title, description, amountCents: input.amountCents, scheduleDays: input.scheduleDays });
  const first = Object.values(errors)[0];
  if (first !== undefined) throw invalid(first, errors as Record<string, string>);
  return {
    title: input.title.trim(),
    description: description.trim(),
    amountCents: input.amountCents,
    scheduleDays: input.scheduleDays ?? undefined,
  };
}

async function audit(
  ctx: MutationCtx,
  access: ProjectAccess,
  co: Doc<"changeOrders">,
  title: string,
  description: string,
): Promise<void> {
  await ctx.db.insert("auditLogs", {
    projectId: access.project._id,
    ...(co.agreementId !== undefined ? { agreementId: co.agreementId } : {}),
    eventType: "compliance_audit",
    title,
    description,
    ...auditActor(access),
    timestamp: Date.now(),
  });
}

/** The sub company of a subcontract CO's agreement, for notifications. */
async function subCompanyOf(ctx: QueryCtx, co: Doc<"changeOrders">): Promise<Id<"companies"> | null> {
  if (co.agreementId === undefined) return null;
  const agreement = await ctx.db.get(co.agreementId);
  const contractor = agreement ? await ctx.db.get(agreement.contractorId) : null;
  return contractor?.linkedCompanyId ?? null;
}

/** The project's active owner company: `projects.ownerCompanyId` when set, else the one active owner member. */
async function ownerCompanyOf(ctx: QueryCtx, project: Doc<"projects">): Promise<Id<"companies"> | null> {
  const members = await ctx.db
    .query("projectMembers")
    .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
    .take(200);
  const owners = members.filter((m) => m.partyRole === "owner" && m.status === "active");
  if (project.ownerCompanyId !== undefined) return owners.some((m) => m.companyId === project.ownerCompanyId) ? project.ownerCompanyId : null;
  return owners[0]?.companyId ?? null;
}

async function notifyParty(
  ctx: MutationCtx,
  project: Doc<"projects">,
  party: CoParty,
  co: Doc<"changeOrders">,
  input: { kind: "change_order_submitted" | "change_order_approved" | "change_order_rejected"; title: string; body: string },
): Promise<number> {
  const companyId =
    party === "gc" ? project.gcCompanyId : party === "owner" ? await ownerCompanyOf(ctx, project) : await subCompanyOf(ctx, co);
  if (companyId === undefined || companyId === null) return 0;
  return await notify(ctx, { companyId }, { ...input, link: CHANGE_ORDERS_HASH, projectId: project._id });
}

function otherParty(co: Doc<"changeOrders">, party: CoParty): CoParty {
  if (changeOrderScopeOf(co) === "prime") return party === "owner" ? "gc" : "owner";
  return party === "sub" ? "gc" : "sub";
}

// ---- Reads --------------------------------------------------------------------------------------

/**
 * Change orders of one project for the caller's party. GC: every subcontract CO (per agreement) and
 * the prime COs; sub: the subcontract COs of its own agreements; owner: the prime COs only. Drafts
 * appear only to the party drafting them.
 */
export const listForProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: ALL_PARTIES });
    const party = partyOf(access);
    const project = access.project;
    const recipient = await recipientFor(ctx, project._id, party);
    const agreements = [];
    if (party !== "owner") {
      const rows = await ctx.db
        .query("agreements")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .take(100);
      for (const agreement of rows) {
        if (agreement.status === "superseded") continue;
        if (party === "sub" && !access.contractorIds.includes(agreement.contractorId)) continue;
        const cos = await subcontractChangeOrders(ctx, agreement._id);
        const sum = await agreementContractSum(ctx, agreement);
        agreements.push({
          agreementId: agreement._id,
          agreementNumber: agreement.agreementNumber,
          subcontractorName: agreement.subcontractorName,
          tradeName: agreement.tradeName,
          executed: agreement.status === "executed",
          sovApproved: sovIsApproved(agreement),
          contractSum: sum,
          breakdownText: breakdownText(sum),
          canCreate: agreement.status === "executed",
          changeOrders: await rowViews(ctx, cos, { party, recipient }),
        });
      }
    }
    const prime =
      party === "sub"
        ? null
        : {
            contractSum: await primeContractSum(ctx, project),
            canCreate: party === "gc",
            changeOrders: await rowViews(ctx, await primeChangeOrders(ctx, project._id), { party, recipient }),
          };
    return {
      projectId: project._id,
      projectTitle: project.title,
      party,
      invoicing:
        recipient === null
          ? null
          : recipient.ok
            ? { enabled: true, reason: null, recipientEmail: recipient.email }
            : { enabled: false, reason: recipient.reason, recipientEmail: null },
      agreements,
      prime,
    };
  },
});

/** The caller's projects for the Change orders page project picker. */
export const myChangeOrderProjects = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ALL_PARTIES);
    const projects = await callerProjects(ctx);
    return projects.slice(0, 100).map((p) => ({ _id: p._id, title: p.title }));
  },
});

/** Subcontract change orders of one agreement (GC and that sub); null when the caller cannot see it. */
export const listForAgreement = query({
  args: { agreementId: v.string() },
  handler: async (ctx, args) => {
    const scope = await findDocScope(ctx, "agreements", args.agreementId, { roles: GC_SUB });
    if (scope === null) return null;
    const party = partyOf(scope);
    const cos = await subcontractChangeOrders(ctx, scope.doc._id);
    const sum = await agreementContractSum(ctx, scope.doc);
    return {
      agreementId: scope.doc._id,
      projectId: scope.doc.projectId,
      party,
      contractSum: sum,
      breakdownText: breakdownText(sum),
      canCreate: scope.doc.status === "executed",
      changeOrders: await rowViews(ctx, cos, { party, recipient: null }),
    };
  },
});

/**
 * One change order for a party, with the GC's approval preview for a submitted subcontract CO: the SOV
 * line it adds, the contract sum to date it leads to, and the deductive-floor refusal if any.
 */
export const getChangeOrder = query({
  args: { changeOrderId: v.string() },
  handler: async (ctx, args) => {
    const scope = partyScope(await requireDocScope(ctx, "changeOrders", args.changeOrderId, { roles: ALL_PARTIES }));
    const co = scope.doc;
    const recipient = await recipientFor(ctx, scope.project._id, scope.party);
    const [view] = await rowViews(ctx, [co], { party: scope.party, recipient });
    let approvalPreview = null;
    if (changeOrderScopeOf(co) === "subcontract" && co.status === "submitted" && scope.party === "gc" && co.agreementId) {
      const agreement = await ctx.db.get(co.agreementId);
      if (agreement !== null) approvalPreview = await approvalPreviewFor(ctx, agreement, co);
    }
    return { ...view, approvalPreview };
  },
});

async function nextSovLineNo(ctx: QueryCtx, agreementId: Id<"agreements">): Promise<number> {
  const last = await ctx.db
    .query("scheduleOfValues")
    .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreementId))
    .order("desc")
    .first();
  return (last?.lineNo ?? 0) + 1;
}

/** Billed to date: completed and stored on approved pay apps (G of the latest approved application). */
async function billedToDateCents(ctx: QueryCtx, agreement: Doc<"agreements">): Promise<number> {
  const live = await g703Context(ctx, agreement);
  return live.lines.reduce((acc, l) => acc + l.previousWorkCents + l.previousStoredCents, 0);
}

async function approvalPreviewFor(ctx: QueryCtx, agreement: Doc<"agreements">, co: Doc<"changeOrders">) {
  const sum = await agreementContractSum(ctx, agreement);
  const after = sum.toDateCents + co.amountCents;
  const billed = co.amountCents < 0 ? await billedToDateCents(ctx, agreement) : 0;
  const lineNo = await nextSovLineNo(ctx, agreement._id);
  return {
    lineNo,
    contractSumToDateCents: sum.toDateCents,
    contractSumAfterCents: after,
    floorProblem: deductiveFloorProblem({ contractSumToDateCents: sum.toDateCents, amountCents: co.amountCents, billedCents: billed }),
    sovProblem: sovIsApproved(agreement) ? null : SOV_FIRST,
    message: `Adds SOV line ${lineNo} for ${formatCents(co.amountCents)}; contract sum to date becomes ${formatCents(after)}`,
  };
}

const SOV_FIRST = "Approve the schedule of values before approving change orders on this agreement.";

// ---- Writes -------------------------------------------------------------------------------------

const fieldArgs = {
  title: v.string(),
  description: v.optional(v.string()),
  amountCents: v.number(),
  scheduleDays: v.optional(v.union(v.number(), v.null())),
};

/** The next number on the contract, after refusing a contract already at CO_CAPACITY. */
async function nextNumber(ctx: QueryCtx, scope: ChangeOrderScope, key: { agreementId?: Id<"agreements">; projectId: Id<"projects"> }): Promise<number> {
  const rows = await (scope === "prime" ? primeChangeOrders(ctx, key.projectId) : subcontractChangeOrders(ctx, key.agreementId!)).catch((e: unknown) => {
    if (e instanceof ConvexError && (e.data as { code?: string }).code === "CO_CAPACITY") return null;
    throw e;
  });
  if (rows === null || rows.length >= CO_CAPACITY) {
    throw new ConvexError({ code: "CO_CAPACITY", message: `${CO_CAPACITY_MESSAGE} Delete drafts that are no longer needed to make room.` });
  }
  return (await highestChangeOrderNumber(ctx, scope, key)) + 1;
}

export type CreateChangeOrderInput = {
  scope: ChangeOrderScope;
  title: string;
  description?: string;
  amountCents: number;
  scheduleDays?: number | null;
  linkedChangeOrderId?: Id<"changeOrders">;
};

/** Inserts a draft CO. Numbering is per agreement (subcontract) or per project (prime); the read-then-insert runs in one transaction, so concurrent drafts never share a number. */
export async function insertDraftChangeOrder(
  ctx: MutationCtx,
  access: ProjectAccess,
  target: { agreement: Doc<"agreements"> | null },
  input: CreateChangeOrderInput,
): Promise<Id<"changeOrders">> {
  const fields = cleanFields(input);
  const projectId = access.project._id;
  const number = await nextNumber(ctx, input.scope, { agreementId: target.agreement?._id, projectId });
  const now = Date.now();
  const party = partyOf(access);
  const id = await ctx.db.insert("changeOrders", {
    ...(target.agreement ? { agreementId: target.agreement._id } : {}),
    projectId,
    scope: input.scope,
    number,
    title: fields.title,
    description: fields.description,
    amountCents: fields.amountCents,
    ...(fields.scheduleDays !== undefined ? { scheduleDays: fields.scheduleDays } : {}),
    status: "draft",
    requestedBy: access.user._id,
    requestedByParty: party === "sub" ? "sub" : "gc",
    ...(input.linkedChangeOrderId ? { linkedChangeOrderId: input.linkedChangeOrderId } : {}),
    createdBy: access.user._id,
    createdAt: now,
    updatedAt: now,
  });
  const co = (await ctx.db.get(id))!;
  await audit(ctx, access, co, `Change order drafted: ${labelOf(co)}`, `${labelOf(co)} – ${fields.title}: ${formatCents(fields.amountCents)}.`);
  return id;
}

/**
 * Drafts a change order. Subcontract: the GC or the agreement's sub, on an executed agreement. Prime:
 * the GC only, on the project (optionally linked to a subcontract CO for reference).
 */
export const createChangeOrder = mutation({
  args: {
    scope: v.union(v.literal("subcontract"), v.literal("prime")),
    agreementId: v.optional(v.string()),
    projectId: v.optional(v.string()),
    linkedChangeOrderId: v.optional(v.string()),
    ...fieldArgs,
  },
  handler: async (ctx, args) => {
    if (args.scope === "subcontract") {
      if (args.agreementId === undefined) throw notFound();
      const scope = await requireDocScope(ctx, "agreements", args.agreementId, { roles: GC_SUB, write: true });
      if (scope.doc.status === "superseded") throw notFound();
      if (scope.doc.status !== "executed") {
        throw new ConvexError({ code: "INVALID_STATE", message: "Change orders open once the GC records execution of this agreement." });
      }
      const id = await insertDraftChangeOrder(ctx, scope, { agreement: scope.doc }, { ...args, scope: "subcontract", linkedChangeOrderId: undefined });
      return { changeOrderId: id };
    }
    if (args.projectId === undefined) throw notFound();
    const access = await requireProjectScope(ctx, args.projectId, { roles: ["gc"], write: true });
    let linked: Id<"changeOrders"> | undefined;
    if (args.linkedChangeOrderId) {
      const other = await requireDocScope(ctx, "changeOrders", args.linkedChangeOrderId, { roles: ["gc"] });
      if (other.project._id !== access.project._id || changeOrderScopeOf(other.doc) !== "subcontract") throw notFound();
      linked = other.doc._id;
    }
    const id = await insertDraftChangeOrder(ctx, access, { agreement: null }, { ...args, scope: "prime", linkedChangeOrderId: linked });
    return { changeOrderId: id };
  },
});

/** Only drafts change, and only by the party that drafted them; decided COs answer with their lock message. */
function assertEditableBy(co: Doc<"changeOrders">, party: CoParty): void {
  const block = changeOrderEditBlock(co.status as ChangeOrderStatus);
  if (block !== null) throw locked(block);
  if (requesterPartyOf(co) !== party) throw notFound();
}

export const updateChangeOrder = mutation({
  args: {
    changeOrderId: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    amountCents: v.optional(v.number()),
    scheduleDays: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const scope = partyScope(await requireDocScope(ctx, "changeOrders", args.changeOrderId, { roles: ALL_PARTIES, write: true }));
    const co = scope.doc;
    assertEditableBy(co, scope.party);
    const fields = cleanFields({
      title: args.title ?? co.title ?? co.description,
      description: args.description ?? (co.title === undefined ? "" : co.description),
      amountCents: args.amountCents ?? co.amountCents,
      scheduleDays: args.scheduleDays === undefined ? co.scheduleDays : args.scheduleDays,
    });
    await ctx.db.patch(co._id, {
      title: fields.title,
      description: fields.description,
      amountCents: fields.amountCents,
      scheduleDays: fields.scheduleDays,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Changes only the amount of a draft CO (same rules as updateChangeOrder). */
export const setChangeOrderAmount = mutation({
  args: { changeOrderId: v.string(), amountCents: v.number() },
  handler: async (ctx, args) => {
    const scope = partyScope(await requireDocScope(ctx, "changeOrders", args.changeOrderId, { roles: ALL_PARTIES, write: true }));
    const co = scope.doc;
    assertEditableBy(co, scope.party);
    const fields = cleanFields({ title: co.title ?? co.description, description: "", amountCents: args.amountCents });
    await ctx.db.patch(co._id, { amountCents: fields.amountCents, updatedAt: Date.now() });
    return null;
  },
});

export const deleteChangeOrder = mutation({
  args: { changeOrderId: v.string() },
  handler: async (ctx, args) => {
    const scope = partyScope(await requireDocScope(ctx, "changeOrders", args.changeOrderId, { roles: ALL_PARTIES, write: true }));
    const co = scope.doc;
    assertEditableBy(co, scope.party);
    await ctx.db.delete(co._id);
    await audit(ctx, scope, co, `Change order draft deleted: ${labelOf(co)}`, `${labelOf(co)} – ${co.title ?? co.description} was deleted as a draft.`);
    return null;
  },
});

/** Submits a draft to the deciding party: the GC (subcontract COs drafted by the sub), the sub's view, or the owner (prime). */
export const submitChangeOrder = mutation({
  args: { changeOrderId: v.string() },
  handler: async (ctx, args) => {
    const scope = partyScope(await requireDocScope(ctx, "changeOrders", args.changeOrderId, { roles: ALL_PARTIES, write: true }));
    const co = scope.doc;
    if (co.status === "submitted" && requesterPartyOf(co) === scope.party) return { status: "submitted" as const };
    assertEditableBy(co, scope.party);
    const now = Date.now();
    await ctx.db.patch(co._id, { status: "submitted", submittedAt: now, updatedAt: now });
    const label = labelOf(co);
    const title = co.title ?? co.description;
    if (changeOrderScopeOf(co) === "prime") {
      await notifyParty(ctx, scope.project, "owner", co, {
        kind: "change_order_submitted",
        title: "Change order awaiting your approval",
        body: `${scope.project.title}: ${label} – ${title}, ${formatCents(co.amountCents)}. Open Change orders to approve or reject it.`,
      });
    } else {
      await notifyParty(ctx, scope.project, otherParty(co, scope.party), co, {
        kind: "change_order_submitted",
        title: `Change order ${label} submitted – ${formatCents(co.amountCents)}`,
        body: `${scope.project.title}: ${title}.`,
      });
    }
    await audit(ctx, scope, co, `Change order submitted: ${label}`, `${label} – ${title}: ${formatCents(co.amountCents)} submitted for a decision.`);
    return { status: "submitted" as const };
  },
});

/** Withdraws a submitted CO back to Draft; only the party that submitted it, and only before a decision. */
export const withdrawChangeOrder = mutation({
  args: { changeOrderId: v.string() },
  handler: async (ctx, args) => {
    const scope = partyScope(await requireDocScope(ctx, "changeOrders", args.changeOrderId, { roles: ALL_PARTIES, write: true }));
    const co = scope.doc;
    if (co.status !== "submitted") {
      throw locked(changeOrderEditBlock(co.status as ChangeOrderStatus) ?? "Only a submitted change order can be withdrawn.");
    }
    if (requesterPartyOf(co) !== scope.party) throw notFound();
    await ctx.db.patch(co._id, { status: "draft", submittedAt: undefined, updatedAt: Date.now() });
    await audit(ctx, scope, co, `Change order withdrawn: ${labelOf(co)}`, `${labelOf(co)} was withdrawn to Draft by the requester.`);
    return { status: "draft" as const };
  },
});

/** Only the deciding party may approve or reject; the requester and every other caller get "Not found.". */
function assertDecider(co: Doc<"changeOrders">, party: CoParty): void {
  if (deciderOf(changeOrderScopeOf(co)) !== party) throw notFound();
}

function assertSubmitted(co: Doc<"changeOrders">, verb: "approved" | "rejected"): void {
  if (co.status === "submitted") return;
  const label = labelOf(co);
  if (co.status === "draft") throw locked(`${label} is a draft; it can be ${verb} once it is submitted.`);
  throw locked(`${label} was already decided (${co.status}); decided change orders cannot be changed – create a new change order`);
}

/**
 * Approves a submitted subcontract CO: appends SOV line "CO #n – title" linked to the CO (never
 * rewriting the original lines), so the contract sum to date changes and the next pay app carries it.
 * A deductive CO may not take the contract sum to date below what approved pay apps already billed.
 */
export async function approveSubcontract(ctx: MutationCtx, access: ProjectAccess, co: Doc<"changeOrders">) {
  if (co.agreementId === undefined) throw notFound();
  const agreement = await ctx.db.get(co.agreementId);
  if (agreement === null || agreement.status === "superseded") throw notFound();
  if (!sovIsApproved(agreement)) throw new ConvexError({ code: "INVALID_STATE", message: SOV_FIRST });
  const preview = await approvalPreviewFor(ctx, agreement, co);
  if (preview.floorProblem !== null) throw new ConvexError({ code: "DEDUCTIVE_FLOOR", message: preview.floorProblem });
  const label = labelOf(co);
  if ((await loadSovRows(ctx, agreement._id)).length >= SOV_MAX_TOTAL_LINES) {
    throw new ConvexError({ code: "SOV_CAPACITY", message: `${SOV_CAPACITY_MESSAGE} ${label} cannot add another line.` });
  }
  const title = co.title ?? co.description;
  const sovLineId = await ctx.db.insert("scheduleOfValues", {
    agreementId: agreement._id,
    lineNo: preview.lineNo,
    description: `${label} – ${title}`.slice(0, 300),
    scheduledValueCents: co.amountCents,
    excludedScope: false,
    changeOrderId: co._id,
  });
  const now = Date.now();
  await ctx.db.patch(co._id, {
    status: "approved",
    approvedBy: access.user._id,
    approvedAt: now,
    sovLineId,
    contractSumBeforeCents: preview.contractSumToDateCents,
    contractSumAfterCents: preview.contractSumAfterCents,
    updatedAt: now,
  });
  await notifyParty(ctx, access.project, "sub", co, {
    kind: "change_order_approved",
    title: `Change order ${label} approved`,
    body: `${access.project.title} · ${agreement.agreementNumber}: SOV line ${preview.lineNo} ${formatCents(co.amountCents)}; contract sum to date ${formatCents(preview.contractSumAfterCents)}.`,
  });
  await audit(
    ctx,
    access,
    co,
    `Change order approved: ${label}`,
    `${agreement.agreementNumber}: ${label} – ${title} adds SOV line ${preview.lineNo} for ${formatCents(co.amountCents)}; contract sum to date ${formatCents(preview.contractSumToDateCents)} → ${formatCents(preview.contractSumAfterCents)}.`,
  );
  return { status: "approved" as const, sovLineId, lineNo: preview.lineNo, contractSumToDateCents: preview.contractSumAfterCents };
}

/**
 * What the owner has been billed on the prime contract: completed and stored on the latest
 * owner-approved owner pay app, plus prime COs billed directly with "Invoice now".
 */
async function ownerBilledToDateCents(ctx: QueryCtx, project: Doc<"projects">, primeCos: readonly Doc<"changeOrders">[]) {
  const apps = await ctx.db
    .query("ownerPayApps")
    .withIndex("by_projectId_and_applicationNo", (q) => q.eq("projectId", project._id))
    .order("desc")
    .take(500);
  const latest = apps.find((a) => OWNER_APPROVED_STATUSES.has(a.status));
  const direct = primeCos
    .filter((c) => CO_APPROVED_STATUSES.has(c.status as ChangeOrderStatus) && c.amountCents > 0 && isDirectlyInvoiced(c))
    .reduce((acc, c) => acc + c.amountCents, 0);
  return { cents: (latest?.figures.completedAndStoredCents ?? 0) + direct, direct };
}

/**
 * Approves a submitted prime CO for the owner: the prime contract sum to date changes. A deductive CO
 * may not take the prime contract sum below what the owner was already billed (nor below zero).
 */
export async function approvePrime(
  ctx: MutationCtx,
  access: ProjectAccess,
  co: Doc<"changeOrders">,
  opts: { approvedBy: Id<"users">; judgeDemo?: { runId: Id<"judgeDemoRuns">; approvedFor: string } },
) {
  const before = (await primeContractSum(ctx, access.project))?.toDateCents ?? 0;
  if (co.amountCents < 0) {
    const billed = await ownerBilledToDateCents(ctx, access.project, await primeChangeOrders(ctx, access.project._id));
    const problem = deductiveFloorProblem({
      contractSumToDateCents: before,
      amountCents: co.amountCents,
      billedCents: billed.cents,
      billedOn: billed.direct > 0 ? "to the owner (approved owner pay apps and change orders invoiced directly)" : "to the owner on approved owner pay apps",
    });
    if (problem !== null) throw new ConvexError({ code: "DEDUCTIVE_FLOOR", message: problem });
  }
  const now = Date.now();
  await ctx.db.patch(co._id, {
    status: "approved",
    approvedBy: opts.approvedBy,
    approvedAt: now,
    contractSumBeforeCents: before,
    contractSumAfterCents: before + co.amountCents,
    updatedAt: now,
    ...(opts.judgeDemo ? { judgeDemo: opts.judgeDemo } : {}),
  });
  const sum = await primeContractSum(ctx, access.project);
  const label = labelOf(co);
  await notifyParty(ctx, access.project, "gc", co, {
    kind: "change_order_approved",
    title: `Change order ${label} approved`,
    body: `${access.project.title}: ${co.title ?? co.description}, ${formatCents(co.amountCents)}.${
      sum ? ` Prime contract sum to date ${formatCents(sum.toDateCents)}.` : ""
    }`,
  });
  await audit(
    ctx,
    access,
    co,
    `Prime change order approved: ${label}`,
    `${label} – ${co.title ?? co.description}: ${formatCents(co.amountCents)} approved${opts.judgeDemo ? ` by the judge demo for ${opts.judgeDemo.approvedFor}` : " by the owner"}.${
      sum ? ` Prime contract sum to date ${formatCents(sum.toDateCents)}.` : ""
    }`,
  );
  return { status: "approved" as const, primeContractSumToDateCents: sum?.toDateCents ?? null };
}

export const approveChangeOrder = mutation({
  args: { changeOrderId: v.string() },
  handler: async (ctx, args) => {
    const scope = partyScope(await requireDocScope(ctx, "changeOrders", args.changeOrderId, { roles: ALL_PARTIES, write: true }));
    const co = scope.doc;
    assertDecider(co, scope.party);
    // A repeated click on an approval that already went through changes nothing.
    if (co.status === "approved" && co.approvedBy !== undefined) return { status: "approved" as const, alreadyApproved: true };
    assertSubmitted(co, "approved");
    if (changeOrderScopeOf(co) === "prime") return { ...(await approvePrime(ctx, scope, co, { approvedBy: scope.user._id })), alreadyApproved: false };
    return { ...(await approveSubcontract(ctx, scope, co)), alreadyApproved: false };
  },
});

export const rejectChangeOrder = mutation({
  args: { changeOrderId: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const scope = partyScope(await requireDocScope(ctx, "changeOrders", args.changeOrderId, { roles: ALL_PARTIES, write: true }));
    const co = scope.doc;
    assertDecider(co, scope.party);
    assertSubmitted(co, "rejected");
    const reason = args.reason.trim();
    if (reason.length === 0) throw invalid("Enter a reason for rejecting the change order.", { reason: "Enter a reason." });
    if (reason.length > CO_MAX_REASON) throw invalid(`The reason is limited to ${CO_MAX_REASON} characters.`);
    const now = Date.now();
    await ctx.db.patch(co._id, { status: "rejected", rejectedBy: scope.user._id, rejectedAt: now, rejectionReason: reason, updatedAt: now });
    const label = labelOf(co);
    await notifyParty(ctx, scope.project, otherParty(co, scope.party), co, {
      kind: "change_order_rejected",
      title: `Change order ${label} rejected`,
      body: `${scope.project.title}: ${co.title ?? co.description}. Reason: ${reason}`,
    });
    await audit(ctx, scope, co, `Change order rejected: ${label}`, `${label} – ${co.title ?? co.description} rejected. Reason: ${reason}`);
    return { status: "rejected" as const };
  },
});

// ---- Migration ----------------------------------------------------------------------------------

/**
 * Backfills change orders written before v2: they were invoiced to the owner, so they become prime
 * COs of their agreement's project with the description as the title.
 *   npx convex run billing/changeOrders:backfillChangeOrderScope
 */
export const backfillChangeOrderScope = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("changeOrders").take(2000);
    let patched = 0;
    for (const co of rows) {
      if (co.scope !== undefined && co.projectId !== undefined) continue;
      const agreement = co.agreementId ? await ctx.db.get(co.agreementId) : null;
      const projectId = co.projectId ?? agreement?.projectId;
      await ctx.db.patch(co._id, {
        scope: co.scope ?? "prime",
        ...(projectId ? { projectId } : {}),
        ...(co.title === undefined ? { title: co.description.slice(0, 200) } : {}),
        requestedByParty: co.requestedByParty ?? "gc",
        ...(co.requestedBy === undefined && co.createdBy ? { requestedBy: co.createdBy } : {}),
      });
      patched++;
    }
    return { patched, scanned: rows.length };
  },
});

/**
 * Captures the contract sum before and after each approved change order that predates the snapshot,
 * reconstructed in approval order per contract. Idempotent.
 *   npx convex run billing/changeOrders:backfillChangeOrderSumSnapshots
 */
export const backfillChangeOrderSumSnapshots = internalMutation({
  args: {},
  handler: async (ctx) => {
    const contracts = new Set<string>();
    let scanned = 0;
    for (const status of CO_APPROVED_STATUSES) {
      const rows = await ctx.db
        .query("changeOrders")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(2000);
      scanned += rows.length;
      for (const co of rows) {
        if (co.contractSumBeforeCents !== undefined && co.contractSumAfterCents !== undefined) continue;
        if (changeOrderScopeOf(co) === "prime") {
          if (co.projectId !== undefined) contracts.add(`prime:${co.projectId}`);
        } else if (co.agreementId !== undefined) contracts.add(`sub:${co.agreementId}`);
      }
    }
    let patched = 0;
    for (const key of contracts) {
      const [kind, id] = key.split(":");
      let original: number;
      let cos: Doc<"changeOrders">[];
      if (kind === "prime") {
        const project = await ctx.db.get(id as Id<"projects">);
        if (project === null) continue;
        original = project.contractValueCents ?? 0;
        cos = await primeChangeOrders(ctx, project._id);
      } else {
        const agreement = await ctx.db.get(id as Id<"agreements">);
        if (agreement === null) continue;
        original = agreementContractSumCents(agreement);
        cos = await subcontractChangeOrders(ctx, agreement._id);
      }
      const approved = cos.filter((c) => CO_APPROVED_STATUSES.has(c.status as ChangeOrderStatus));
      const sums = contractSumsByApproval(
        original,
        approved.map((c) => ({ id: c._id, amountCents: c.amountCents, approvedAt: c.approvedAt, createdAt: c.createdAt, number: c.number })),
      );
      for (const co of approved) {
        if (co.contractSumBeforeCents !== undefined && co.contractSumAfterCents !== undefined) continue;
        const sum = sums.get(co._id)!;
        await ctx.db.patch(co._id, { contractSumBeforeCents: sum.beforeCents, contractSumAfterCents: sum.afterCents });
        patched++;
      }
    }
    return { patched, scanned, contracts: contracts.size };
  },
});
