import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { formatCents } from "../lib/money";
import { notify } from "../lib/notify";
import { auditActor, callerProjects, requireDocScope, requireProjectScope } from "../lib/projectScope";
import { requireRole } from "../lib/roles";
import { notFound, requireProjectAccess, type ProjectAccess } from "../lib/tenancy";
import { formatIsoDate, isoDate, nextBillingPeriod, percentHundredths } from "../payApps/g703Math";
import { invoiceRecipientForProject } from "../payments/changeOrderRecipient";
import { CO_APPROVED_STATUSES, changeOrderLabel, isDirectlyInvoiced, type ChangeOrderStatus } from "../payments/changeOrderMath";
import { primeChangeOrders } from "./changeOrderView";
import {
  OWNER_APPROVED_STATUSES,
  OWNER_COMMENT_MAX,
  OWNER_EDITABLE_STATUSES,
  gcEntryErrors,
  changeOrderKey,
  ownerLineFigures,
  ownerPayAppReadyTitle,
  ownerSheetChanges,
  pendingSubPayAppsNote,
  staleSheetMessage,
  type OwnerPayAppStatus,
} from "./ownerBillingMath";
import {
  buildOwnerSheet,
  ownerRetainageBps,
  primeRetainageHeld,
  projectOwnerCompanyId,
  projectOwnerPayApps,
  sheetFigures,
} from "./ownerRollup";

/**
 * Owner pay apps (architecture §16): the GC creates one per billing period from the approved sub pay
 * apps plus its own lines, enters this period's GC amounts and submits it; the owner approves it in
 * the owner portal (which creates the PayPal invoice, see ownerInvoices.ts) or requests changes.
 * Only the project's GC and owner can reach an owner pay app; everyone else gets "Not found.".
 * The owner never sees drafts, the sub-level retainage or which agreement a trade line comes from.
 */

const PARTIES = ["gc", "owner"] as const;
const DEFAULT_BILLING_DAY = 25;
export const OWNER_PAY_APPS_HASH = "#/owner-pay-apps";
export const GC_OWNER_BILLING_HASH = "#/billing/owner-billing";

type Party = "gc" | "owner";

function invalid(message: string, extra: Record<string, unknown> = {}) {
  return new ConvexError({ code: "INVALID_ARGUMENT", message, ...extra });
}
function invalidState(message: string) {
  return new ConvexError({ code: "INVALID_STATE", message });
}

function partyOf(access: ProjectAccess): Party {
  if (access.partyRole === "gc" || access.partyRole === "owner") return access.partyRole;
  throw notFound();
}

/** An owner pay app the caller may see: the GC always, the owner once the GC has submitted it. */
function visibleTo<S extends ProjectAccess & { doc: Doc<"ownerPayApps"> }>(scope: S): S & { party: Party } {
  const party = partyOf(scope);
  if (party === "owner" && scope.doc.status === "draft") throw notFound();
  return { ...scope, party };
}

function historyEntry(access: ProjectAccess, status: OwnerPayAppStatus, comment?: string): Doc<"ownerPayApps">["history"][number] {
  const actor = auditActor(access);
  return { status, at: Date.now(), byUserId: actor.actorUserId, byName: actor.actor, ...(comment !== undefined ? { comment } : {}) };
}

async function audit(ctx: MutationCtx, access: ProjectAccess, title: string, description: string): Promise<void> {
  await ctx.db.insert("auditLogs", {
    projectId: access.project._id,
    eventType: "compliance_audit",
    title,
    description,
    ...auditActor(access),
    timestamp: Date.now(),
  });
}

function nextPeriodFor(project: Doc<"projects">, previous: Doc<"ownerPayApps"> | null) {
  return nextBillingPeriod({
    previousPeriodEnd: previous?.periodEnd ?? null,
    firstPeriodStart: project.startDate ?? isoDate(new Date(project.createdAt)),
    billingDay: project.billingDay ?? DEFAULT_BILLING_DAY,
  });
}

/** Why the GC cannot open the next owner pay app on this project, or null. */
function createBlock(project: Doc<"projects">, apps: readonly Doc<"ownerPayApps">[]): string | null {
  if (project.contractValueCents === undefined) return "Set the prime contract value in Project settings before billing the owner.";
  const open = apps.find((a) => !OWNER_APPROVED_STATUSES.has(a.status));
  if (open) return `Owner pay app #${open.applicationNo} is still open. The owner must approve it before the next one.`;
  return null;
}

function lineView(l: Doc<"ownerPayApps">["lines"][number], index: number, party: Party) {
  const f = ownerLineFigures(l);
  return {
    key: l.key,
    lineNo: index + 1,
    kind: l.kind,
    description: l.description,
    scheduledValueCents: l.scheduledValueCents,
    previousWorkCents: l.previousWorkCents,
    previousStoredCents: l.previousStoredCents,
    workThisPeriodCents: l.workThisPeriodCents,
    storedCents: l.storedCents,
    totalCents: f.totalCents,
    percentHundredths: f.percentHundredths,
    balanceCents: f.balanceCents,
    retainageCents: f.retainageCents,
    // A deductive change-order line (negative value) has a remaining deduction, at most 0.00.
    remainingCents:
      l.scheduledValueCents < 0
        ? Math.min(0, l.scheduledValueCents - l.previousWorkCents - l.previousStoredCents)
        : Math.max(0, l.scheduledValueCents - l.previousWorkCents - l.previousStoredCents),
    // Sub-level detail stays with the GC.
    subRetainageCents: party === "gc" ? (l.subRetainageCents ?? null) : null,
    agreementId: party === "gc" ? (l.agreementId ?? null) : null,
  };
}

function summaryView(app: Doc<"ownerPayApps">) {
  return {
    _id: app._id,
    applicationNo: app.applicationNo,
    periodStart: app.periodStart,
    periodEnd: app.periodEnd,
    status: app.status,
    currentPaymentDueCents: app.figures.currentPaymentDueCents,
    retainageCents: app.figures.retainageCents,
    submittedAt: app.submittedAt ?? null,
    approvedAt: app.approvedAt ?? null,
    paidAt: app.paidAt ?? null,
  };
}

/**
 * The roll-up of an editable owner pay app rebuilt from the current approved sub pay apps, GC lines
 * and prime change orders, keeping the GC's saved (or given) this-period amounts.
 */
async function rebuildSheet(ctx: QueryCtx, project: Doc<"projects">, app: Doc<"ownerPayApps">, entries?: ReadonlyMap<string, number>) {
  const apps = await projectOwnerPayApps(ctx, project._id);
  const previous = apps.filter((a) => a.applicationNo < app.applicationNo).pop() ?? null;
  const saved = new Map(app.lines.filter((l) => l.kind !== "trade").map((l) => [l.key, l.workThisPeriodCents]));
  const sheet = await buildOwnerSheet(ctx, project, { periodEnd: app.periodEnd, previous, entries: entries ?? saved });
  return { sheet, previous, figures: sheetFigures(project, sheet, previous) };
}

/** What the rebuilt roll-up would change on the saved owner pay app, or null when it is current. */
async function pendingRefresh(ctx: QueryCtx, project: Doc<"projects">, app: Doc<"ownerPayApps">) {
  const fresh = await rebuildSheet(ctx, project, app);
  return ownerSheetChanges(
    { lines: app.lines, figures: app.figures, pendingSubPayApps: app.pendingSubPayApps },
    { lines: fresh.sheet.lines, figures: fresh.figures, pendingSubPayApps: fresh.sheet.pendingSubPayApps },
  );
}

/** Approved prime COs billed with "Invoice now" and therefore not on this owner pay app. */
async function directlyInvoicedChangeOrders(ctx: QueryCtx, app: Doc<"ownerPayApps">) {
  const onSheet = new Set(app.lines.map((l) => l.key));
  return (await primeChangeOrders(ctx, app.projectId))
    .filter((co) => CO_APPROVED_STATUSES.has(co.status as ChangeOrderStatus) && isDirectlyInvoiced(co) && !onSheet.has(changeOrderKey(co._id)))
    .map((co) => ({ _id: co._id, label: changeOrderLabel(co.number, "prime"), title: co.title ?? co.description, amountCents: co.amountCents }));
}

async function detailView(ctx: QueryCtx, app: Doc<"ownerPayApps">, project: Doc<"projects">, party: Party) {
  const editable = party === "gc" && OWNER_EDITABLE_STATUSES.has(app.status);
  const refresh = editable ? await pendingRefresh(ctx, project, app) : null;
  const invoicePending = app.status === "approved" && app.figures.currentPaymentDueCents > 0;
  const recipient = await invoiceRecipientForProject(ctx, project._id);
  return {
    ...summaryView(app),
    projectId: project._id,
    projectTitle: project.title,
    party,
    retainageBps: app.retainageBps,
    figures: app.figures,
    percentCompleteHundredths: percentHundredths(app.figures.completedAndStoredCents, app.figures.contractSumToDateCents),
    lines: app.lines.map((l, i) => lineView(l, i, party)),
    pendingNote: party === "gc" ? pendingSubPayAppsNote(app.pendingSubPayApps) : null,
    // Changes the current roll-up makes to the saved figures; the GC refreshes before submitting.
    refresh,
    directlyInvoicedChangeOrders: await directlyInvoicedChangeOrders(ctx, app),
    history: app.history.map((h) => ({ status: h.status, at: h.at, byName: h.byName, comment: h.comment ?? null })),
    changesRequestedComment: app.changesRequestedComment ?? null,
    paypalInvoiceId: app.paypalInvoiceId ?? null,
    payerViewUrl: app.payerViewUrl ?? null,
    paypalInvoiceStatus: app.paypalInvoiceStatus ?? null,
    recipientEmail: app.recipientEmail ?? (recipient?.ok ? recipient.email : null),
    invoiceBlockedReason: recipient.ok ? null : recipient.reason,
    error: app.error ?? null,
    controls: {
      edit: editable,
      submit: editable,
      refresh: editable && refresh !== null,
      delete: party === "gc" && app.status === "draft" && app.history.every((h) => h.status === "draft"),
      approve: party === "owner" && app.status === "submitted_to_owner",
      requestChanges: party === "owner" && app.status === "submitted_to_owner",
      // Resumes an invoice whose create or send did not finish after the owner approved.
      sendInvoice: invoicePending,
      refreshStatus: app.paypalInvoiceId !== undefined && app.status === "approved_invoiced",
    },
  };
}

// ---- Reads --------------------------------------------------------------------------------------

/** The caller's projects where it is the GC or the owner, for the owner billing project picker. */
export const ownerBillingProjects = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, PARTIES);
    const out = [];
    for (const project of (await callerProjects(ctx)).slice(0, 100)) {
      const access = await requireProjectAccess(ctx, project._id).catch(() => null);
      if (access === null || (access.partyRole !== "gc" && access.partyRole !== "owner")) continue;
      out.push({ _id: project._id, title: project.title, partyRole: access.partyRole });
    }
    return out;
  },
});

/** Owner pay apps of one project; the owner sees submitted ones only. */
export const listOwnerPayApps = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: PARTIES });
    const party = partyOf(access);
    const project = access.project;
    const apps = await projectOwnerPayApps(ctx, project._id);
    const latest = apps[apps.length - 1] ?? null;
    const block = party === "gc" ? createBlock(project, apps) : null;
    const held = primeRetainageHeld(apps);
    return {
      projectId: project._id,
      projectTitle: project.title,
      party,
      retainageBps: ownerRetainageBps(project),
      contractValueCents: project.contractValueCents ?? null,
      primeRetainageHeldCents: held?.cents ?? null,
      create: party === "gc" ? { allowed: block === null, reason: block, nextPeriodEnd: block === null ? nextPeriodFor(project, latest).periodEnd : null } : null,
      rows: apps.filter((a) => party === "gc" || a.status !== "draft").map(summaryView).reverse(),
    };
  },
});

export const getOwnerPayApp = query({
  args: { ownerPayAppId: v.string() },
  handler: async (ctx, args) => {
    const scope = visibleTo(await requireDocScope(ctx, "ownerPayApps", args.ownerPayAppId, { roles: PARTIES }));
    return await detailView(ctx, scope.doc, scope.project, scope.party);
  },
});

// ---- GC writes ----------------------------------------------------------------------------------

/** GC: opens the next owner pay app, rolled up from the approved sub pay apps for its period. */
export const createOwnerPayApp = mutation({
  args: { projectId: v.string() },
  returns: v.object({ ownerPayAppId: v.id("ownerPayApps") }),
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: ["gc"], write: true });
    const project = access.project;
    const apps = await projectOwnerPayApps(ctx, project._id);
    const block = createBlock(project, apps);
    if (block !== null) throw invalidState(block);
    const previous = apps[apps.length - 1] ?? null;
    const period = nextPeriodFor(project, previous);
    const sheet = await buildOwnerSheet(ctx, project, { periodEnd: period.periodEnd, previous });
    const now = Date.now();
    const applicationNo = (previous?.applicationNo ?? 0) + 1;
    const ownerPayAppId = await ctx.db.insert("ownerPayApps", {
      projectId: project._id,
      applicationNo,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      status: "draft",
      lines: sheet.lines,
      retainageBps: ownerRetainageBps(project),
      figures: sheetFigures(project, sheet, previous),
      pendingSubPayApps: sheet.pendingSubPayApps,
      history: [historyEntry(access, "draft")],
      createdBy: access.user._id,
      createdAt: now,
      updatedAt: now,
    });
    await audit(ctx, access, `Owner pay app #${applicationNo} created`, `Period ending ${formatIsoDate(period.periodEnd)}.`);
    return { ownerPayAppId };
  },
});

/**
 * GC: saves this period's amounts on the GC and prime change-order lines and refreshes the trade
 * lines from the sub pay apps approved since. Amounts above a line's remaining balance are refused.
 */
export const saveOwnerPayApp = mutation({
  args: {
    ownerPayAppId: v.string(),
    entries: v.array(v.object({ key: v.string(), workThisPeriodCents: v.number() })),
  },
  handler: async (ctx, args) => {
    const scope = visibleTo(await requireDocScope(ctx, "ownerPayApps", args.ownerPayAppId, { roles: ["gc"], write: true }));
    const app = scope.doc;
    if (!OWNER_EDITABLE_STATUSES.has(app.status)) {
      throw invalidState("This owner pay app was submitted to the owner and can no longer be edited.");
    }
    const editable = new Map(app.lines.filter((l) => l.kind !== "trade").map((l) => [l.key, l]));
    const entries = new Map(app.lines.filter((l) => l.kind !== "trade").map((l) => [l.key, l.workThisPeriodCents]));
    for (const e of args.entries) {
      if (!editable.has(e.key)) throw invalid("Only GC lines and prime change-order lines take amounts; trade lines come from approved sub pay apps.");
      entries.set(e.key, e.workThisPeriodCents);
    }
    return await storeRebuiltSheet(ctx, scope.project, app, entries);
  },
});

async function storeRebuiltSheet(ctx: MutationCtx, project: Doc<"projects">, app: Doc<"ownerPayApps">, entries?: ReadonlyMap<string, number>) {
  const { sheet, figures } = await rebuildSheet(ctx, project, app, entries);
  const order = new Map(sheet.lines.map((l, i) => [l.key, i + 1]));
  const errors = gcEntryErrors(sheet.lines, (key) => order.get(key) ?? 0);
  if (errors.length > 0) throw invalid(errors[0].message, { lineErrors: errors.map((e) => ({ key: e.sovLineId, message: e.message })) });
  await ctx.db.patch(app._id, {
    lines: sheet.lines,
    figures,
    pendingSubPayApps: sheet.pendingSubPayApps,
    retainageBps: ownerRetainageBps(project),
    updatedAt: Date.now(),
  });
  return { currentPaymentDueCents: figures.currentPaymentDueCents };
}

/**
 * GC: rebuilds an editable owner pay app from the sub pay apps approved since it was saved (and the
 * current GC lines and prime change orders), keeping the GC's this-period amounts.
 */
export const refreshOwnerPayApp = mutation({
  args: { ownerPayAppId: v.string() },
  handler: async (ctx, args) => {
    const scope = visibleTo(await requireDocScope(ctx, "ownerPayApps", args.ownerPayAppId, { roles: ["gc"], write: true }));
    if (!OWNER_EDITABLE_STATUSES.has(scope.doc.status)) {
      throw invalidState("This owner pay app was submitted to the owner and can no longer be edited.");
    }
    return await storeRebuiltSheet(ctx, scope.project, scope.doc);
  },
});

/** GC: deletes a draft that was never submitted. */
export const deleteOwnerPayApp = mutation({
  args: { ownerPayAppId: v.string() },
  handler: async (ctx, args) => {
    const scope = visibleTo(await requireDocScope(ctx, "ownerPayApps", args.ownerPayAppId, { roles: ["gc"], write: true }));
    const app = scope.doc;
    if (app.status !== "draft" || app.history.some((h) => h.status !== "draft")) {
      throw invalidState("Only a draft that was never submitted can be deleted.");
    }
    await ctx.db.delete(app._id);
    await audit(ctx, scope, `Owner pay app #${app.applicationNo} draft deleted`, `Period ending ${formatIsoDate(app.periodEnd)}.`);
    return null;
  },
});

/** GC: submits the owner pay app; the owner company is notified in-app and the GC can no longer edit it. */
export const submitOwnerPayApp = mutation({
  args: { ownerPayAppId: v.string() },
  handler: async (ctx, args) => {
    const scope = visibleTo(await requireDocScope(ctx, "ownerPayApps", args.ownerPayAppId, { roles: ["gc"], write: true }));
    const app = scope.doc;
    if (!OWNER_EDITABLE_STATUSES.has(app.status)) throw invalidState("This owner pay app was already submitted to the owner.");
    const changes = await pendingRefresh(ctx, scope.project, app);
    if (changes !== null) throw new ConvexError({ code: "OWNER_SHEET_CHANGED", message: staleSheetMessage(changes) });
    const ownerCompanyId = await projectOwnerCompanyId(ctx, scope.project);
    if (ownerCompanyId === null) throw invalidState("No owner on this project – invite the owner before submitting an owner pay app.");
    const now = Date.now();
    await ctx.db.patch(app._id, {
      status: "submitted_to_owner",
      submittedAt: now,
      updatedAt: now,
      history: [...app.history, historyEntry(scope, "submitted_to_owner")],
    });
    const due = app.figures.currentPaymentDueCents;
    await notify(
      ctx,
      { companyId: ownerCompanyId },
      {
        kind: "owner_pay_app_ready",
        title: ownerPayAppReadyTitle(app.applicationNo, due),
        body: `${scope.project.title}: application #${app.applicationNo} for the period ending ${formatIsoDate(app.periodEnd)} is ready for your review.`,
        link: OWNER_PAY_APPS_HASH,
        projectId: scope.project._id,
      },
    );
    await audit(ctx, scope, `Owner pay app #${app.applicationNo} submitted to owner`, `Current payment due ${formatCents(due)}.`);
    return null;
  },
});

// ---- Owner writes -------------------------------------------------------------------------------

/** Owner: returns a submitted owner pay app to the GC with a required comment. */
export const requestOwnerPayAppChanges = mutation({
  args: { ownerPayAppId: v.string(), comment: v.string() },
  handler: async (ctx, args) => {
    const scope = visibleTo(await requireDocScope(ctx, "ownerPayApps", args.ownerPayAppId, { roles: ["owner"], write: true }));
    const app = scope.doc;
    const comment = args.comment.trim();
    if (comment.length === 0) throw invalid("Enter a comment telling the GC what to change.", { fieldErrors: { comment: "Enter a comment." } });
    if (comment.length > OWNER_COMMENT_MAX) throw invalid(`The comment is limited to ${OWNER_COMMENT_MAX} characters.`);
    if (app.status !== "submitted_to_owner") throw invalidState("Only an owner pay app awaiting your review can be returned for changes.");
    await ctx.db.patch(app._id, {
      status: "changes_requested",
      changesRequestedComment: comment,
      updatedAt: Date.now(),
      history: [...app.history, historyEntry(scope, "changes_requested", comment)],
    });
    if (scope.project.gcCompanyId !== undefined) {
      await notify(
        ctx,
        { companyId: scope.project.gcCompanyId },
        {
          kind: "owner_pay_app_changes_requested",
          title: `Owner requested changes to owner pay app #${app.applicationNo}`,
          body: `${scope.project.title}: ${comment}`,
          link: GC_OWNER_BILLING_HASH,
          projectId: scope.project._id,
        },
      );
    }
    await audit(ctx, scope, `Owner requested changes to owner pay app #${app.applicationNo}`, comment);
    return null;
  },
});
