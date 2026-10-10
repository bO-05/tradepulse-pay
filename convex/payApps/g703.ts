import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireRole, type Viewer } from "../lib/roles";
import { auditActor, requireDocScope } from "../lib/projectScope";
import { scopedAgreements } from "../lib/agreementScope";
import { formatCents } from "../lib/money";
import { notify } from "../lib/notify";
import { notFound, type ProjectAccess } from "../lib/tenancy";
import { viewerAgentAuditFields } from "../lib/agentAudit";
import { SOV_NOT_APPROVED_MESSAGE } from "../lib/sovRules";
import type { g702FiguresValidator } from "../schema";
import { agreementContractSumCents, sovIsApproved } from "../payments/sov";
import { retainagePercentFor } from "../payments/payoutMath";
import { billingPayAppHistory } from "./billingHistory";
import {
  APPROVED_PAY_APP_STATUSES,
  MAX_NOTES_LENGTH,
  WITHDRAWABLE_PAY_APP_STATUSES,
  priorBillingByLine,
} from "./validation";
import { payAppChangeOrderSummary } from "../billing/changeOrderView";
import {
  MAX_STORED_NOTE_LENGTH,
  approvedWorkAndStored,
  formatIsoDate,
  g702Summary,
  g703LineErrors,
  isoDate,
  lineIncrementCents,
  nextBillingDate,
  nextBillingPeriod,
  percentHundredths,
  previousCertificatesCents,
  type BillingPeriod,
  type G702Summary,
} from "./g703Math";

/**
 * G702/G703 pay applications (architecture §16). A sub opens one application per billing period as a
 * draft, which autosaves; submitting freezes the previous-application values and the entries, fills the
 * Phase-1 `lines` (per-line billing increments) so review, proposals and billing history keep working,
 * and notifies the GC company in-app.
 */

const DEFAULT_BILLING_DAY = 25;
/** A G703 application in one of these states blocks opening another one on the same agreement. */
const OPEN_G703_STATUSES = new Set(["draft", "submitted", "under_review", "reviewed", "revision_requested"]);
const MAX_LINE_CENTS = 100_000_000_000_000;

type G702Figures = Infer<typeof g702FiguresValidator>;
type StoredG703 = NonNullable<Doc<"payApplications">["g703"]>;
type StoredG703Line = StoredG703["lines"][number];

export type G703ContextLine = {
  sovLineId: Id<"scheduleOfValues">;
  lineNo: number;
  description: string;
  csiCode: string | null;
  scheduledValueCents: number;
  retainageBps: number;
  previousWorkCents: number;
  previousStoredCents: number;
  pendingCents: number;
};

const BPS_PER_PERCENT = 100;

export function agreementRetainageBps(agreement: Doc<"agreements">): number {
  const percent = retainagePercentFor(agreement);
  return Math.round(percent * BPS_PER_PERCENT);
}

async function sovRows(ctx: QueryCtx, agreementId: Id<"agreements">) {
  return await ctx.db
    .query("scheduleOfValues")
    .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreementId))
    .take(500);
}

function approvedIncrementOf(p: Doc<"payApplications">, sovLineId: string): number {
  return p.finalApproval?.lines.find((l) => l.sovLineId === sovLineId)?.approvedCents ?? 0;
}

function createdOrder(a: Doc<"payApplications">, b: Doc<"payApplications">): number {
  return a.createdAt - b.createdAt || a._creationTime - b._creationTime;
}

/** Per line: approved E and F of an approved G703 application (its approved increment split back). */
function approvedLineSplit(p: Doc<"payApplications">, l: StoredG703Line) {
  return approvedWorkAndStored(l, approvedIncrementOf(p, l.sovLineId));
}

/**
 * Live G703 context for the next application on an agreement: per SOV line the approved work (D) and
 * stored material (previous F) of earlier applications and what other open applications reserve.
 */
export async function g703Context(
  ctx: QueryCtx,
  agreement: Doc<"agreements">,
  opts: { excludePayAppId?: Id<"payApplications"> } = {},
) {
  const sov = await sovRows(ctx, agreement._id);
  const history = (await billingPayAppHistory(ctx, agreement._id)).filter((p) => p._id !== opts.excludePayAppId);
  const prior = priorBillingByLine(history);
  const approved = history.filter((p) => APPROVED_PAY_APP_STATUSES.has(p.status)).sort(createdOrder);
  const latestG703 = [...approved].reverse().find((p) => p.g703 !== undefined);
  const storedPrev = new Map<string, number>();
  for (const l of latestG703?.g703?.lines ?? []) storedPrev.set(l.sovLineId, approvedLineSplit(latestG703!, l).storedCents);
  const bps = agreementRetainageBps(agreement);
  const lines: G703ContextLine[] = sov.map((s) => {
    const p = prior.get(s._id);
    const totalPrev = p?.approvedCents ?? 0;
    const fPrev = Math.min(storedPrev.get(s._id) ?? 0, totalPrev);
    return {
      sovLineId: s._id,
      lineNo: s.lineNo,
      description: s.description,
      csiCode: s.csiCode ?? null,
      scheduledValueCents: s.scheduledValueCents,
      retainageBps: s.retainageBps ?? bps,
      previousWorkCents: totalPrev - fPrev,
      previousStoredCents: fPrev,
      pendingCents: p?.pendingRequestedCents ?? 0,
    };
  });
  return {
    lines,
    approved,
    retainageBps: bps,
    originalContractSumCents: agreementContractSumCents(agreement),
    previousCertificatesCents: previousCertificatesCents(
      lines.map((l) => ({ previousTotalCents: l.previousWorkCents + l.previousStoredCents, retainageBps: l.retainageBps })),
    ),
  };
}

/** Application number and billing period of the agreement's next application. */
export function nextApplicationFor(
  project: Doc<"projects">,
  agreement: Doc<"agreements">,
  approved: readonly Doc<"payApplications">[],
): BillingPeriod & { applicationNo: number } {
  const billingDay = project.billingDay ?? DEFAULT_BILLING_DAY;
  let previousPeriodEnd: string | null = null;
  for (const p of approved) {
    // Phase-1 applications have no period; their period is taken to end on the billing day after filing.
    const end = p.periodEnd ?? nextBillingDate(isoDate(new Date(p.createdAt)), billingDay);
    if (previousPeriodEnd === null || end > previousPeriodEnd) previousPeriodEnd = end;
  }
  const firstPeriodStart = project.startDate ?? isoDate(new Date(agreement.executedAt ?? agreement.createdAt));
  return { applicationNo: approved.length + 1, ...nextBillingPeriod({ previousPeriodEnd, firstPeriodStart, billingDay }) };
}

function blockedReasonOf(agreement: Doc<"agreements">): string | null {
  if (!sovIsApproved(agreement)) return SOV_NOT_APPROVED_MESSAGE;
  if (agreement.status !== "executed") return "Pay applications open once the GC records execution of this agreement.";
  return null;
}

function assertBillable(agreement: Doc<"agreements">): void {
  const reason = blockedReasonOf(agreement);
  if (reason !== null) throw new ConvexError({ code: "INVALID_STATE", message: reason });
}

function submittedByFor(viewer: Viewer): Doc<"payApplications">["submittedBy"] {
  if (viewer.user.actorType === "agent") {
    return {
      userId: viewer.userId,
      actorType: "agent",
      agentEmail: viewer.user.email,
      ownerEmail: viewer.user.ownerEmail,
      ownerName: viewer.user.ownerName,
    };
  }
  return { userId: viewer.userId, actorType: "human" };
}

async function openG703PayApp(ctx: QueryCtx, agreementId: Id<"agreements">) {
  const rows = await ctx.db
    .query("payApplications")
    .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
    .order("desc")
    .take(100);
  return rows.find((p) => p.g703 !== undefined && OPEN_G703_STATUSES.has(p.status)) ?? null;
}

function periodLabelFor(applicationNo: number, periodEnd: string): string {
  return `Pay app #${applicationNo} – period ending ${formatIsoDate(periodEnd)}`;
}

function figuresOf(s: G702Summary): G702Figures {
  return {
    originalContractSumCents: s.originalContractSumCents,
    netChangeOrdersCents: s.netChangeOrdersCents,
    contractSumToDateCents: s.contractSumToDateCents,
    completedAndStoredCents: s.completedAndStoredCents,
    retainageCents: s.retainageCents,
    retainageWorkCents: s.retainageWorkCents,
    retainageStoredCents: s.retainageStoredCents,
    earnedLessRetainageCents: s.earnedLessRetainageCents,
    previousCertificatesCents: s.previousCertificatesCents,
    currentPaymentDueCents: s.currentPaymentDueCents,
    balanceToFinishInclRetainageCents: s.balanceToFinishInclRetainageCents,
  };
}

/** The display name the GC knows the sub by: its company, else the vendor record, else the agreement. */
async function subNameOf(ctx: QueryCtx, agreement: Doc<"agreements">, payApp?: Doc<"payApplications">): Promise<string> {
  const company = payApp?.subCompanyId ? await ctx.db.get(payApp.subCompanyId) : null;
  if (company) return company.name;
  const contractor = await ctx.db.get(agreement.contractorId);
  return contractor?.companyName ?? agreement.subcontractorName;
}

export function payAppHash(payAppId: Id<"payApplications">): string {
  return `#/pay-apps/${payAppId}`;
}

/** In-app notice to every member of the project's GC company that a pay app was submitted. */
export async function notifyPayAppSubmitted(
  ctx: MutationCtx,
  agreement: Doc<"agreements">,
  payApp: Doc<"payApplications">,
  amountDueCents: number,
): Promise<number> {
  const project = await ctx.db.get(agreement.projectId);
  if (project === null || project.gcCompanyId === undefined) return 0;
  const subName = await subNameOf(ctx, agreement, payApp);
  const which = `${payApp.applicationNo !== undefined ? `#${payApp.applicationNo}` : `"${payApp.periodLabel}"`}${
    (payApp.version ?? 1) > 1 ? ` (version ${payApp.version})` : ""
  }`;
  const period = payApp.periodEnd ? `, period ending ${formatIsoDate(payApp.periodEnd)}` : "";
  return await notify(
    ctx,
    { companyId: project.gcCompanyId },
    {
      kind: "pay_app_submitted",
      title: `${subName} submitted pay app ${which} – ${formatCents(amountDueCents)}`,
      body: `${project.title} · ${agreement.agreementNumber}${period}. Open it to review.`,
      link: payAppHash(payApp._id),
      projectId: project._id,
    },
  );
}

// ---- Views --------------------------------------------------------------------------------------

export type PayAppSheetLine = G703ContextLine & {
  workThisPeriodCents: number;
  storedCents: number;
  note: string | null;
  /** As submitted, when the approved figures differ. */
  requestedWorkCents: number | null;
  requestedStoredCents: number | null;
};

function sheetSummary(lines: readonly PayAppSheetLine[], originalContractSumCents: number, previousCerts: number): G702Summary {
  return g702Summary(lines, { originalContractSumCents, previousCertificatesCents: previousCerts });
}

/**
 * The continuation sheet of a pay app and its G702 summary. Drafts use live previous values; submitted
 * applications use the values frozen at submission; approved ones show the GC-approved E and F. Phase-1
 * applications map their per-line request to E with no stored material.
 */
async function buildSheet(ctx: QueryCtx, agreement: Doc<"agreements">, payApp: Doc<"payApplications">) {
  const sov = await sovRows(ctx, agreement._id);
  const sovById = new Map(sov.map((s) => [s._id as string, s]));
  const bps = payApp.g703?.retainageBps ?? agreementRetainageBps(agreement);
  const approvedBasis = APPROVED_PAY_APP_STATUSES.has(payApp.status) && payApp.finalApproval !== undefined;

  if (payApp.g703 === undefined) {
    const history = await billingPayAppHistory(ctx, agreement._id).catch(() => [] as Doc<"payApplications">[]);
    const before = history.filter((p) => APPROVED_PAY_APP_STATUSES.has(p.status) && createdOrder(p, payApp) < 0);
    const prior = priorBillingByLine(before);
    const requested = new Map(payApp.lines.map((l) => [l.sovLineId as string, l.requestedCents]));
    const lines: PayAppSheetLine[] = sov.map((s) => {
      const req = requested.get(s._id) ?? 0;
      const work = approvedBasis ? approvedIncrementOf(payApp, s._id) : req;
      return {
        sovLineId: s._id,
        lineNo: s.lineNo,
        description: s.description,
        csiCode: s.csiCode ?? null,
        scheduledValueCents: s.scheduledValueCents,
        retainageBps: s.retainageBps ?? bps,
        previousWorkCents: prior.get(s._id)?.approvedCents ?? 0,
        previousStoredCents: 0,
        pendingCents: 0,
        workThisPeriodCents: work,
        storedCents: 0,
        note: null,
        requestedWorkCents: approvedBasis && work !== req ? req : null,
        requestedStoredCents: null,
      };
    });
    const previousCerts = previousCertificatesCents(
      lines.map((l) => ({ previousTotalCents: l.previousWorkCents, retainageBps: l.retainageBps })),
    );
    const summary = sheetSummary(lines, agreementContractSumCents(agreement), previousCerts);
    return { lines, summary, requestedSummary: null as G702Summary | null, basis: approvedBasis ? "approved" : "requested", errors: [] };
  }

  const g = payApp.g703;
  const isDraft = payApp.status === "draft";
  const live = isDraft ? await g703Context(ctx, agreement, { excludePayAppId: payApp._id }) : null;
  const entered = new Map(g.lines.map((l) => [l.sovLineId as string, l]));
  const lineSource: G703ContextLine[] = live
    ? live.lines
    : g.lines.flatMap((l) => {
        const s = sovById.get(l.sovLineId);
        if (!s) return [];
        return [
          {
            sovLineId: s._id,
            lineNo: s.lineNo,
            description: s.description,
            csiCode: s.csiCode ?? null,
            scheduledValueCents: s.scheduledValueCents,
            retainageBps: s.retainageBps ?? bps,
            previousWorkCents: l.previousWorkCents,
            previousStoredCents: l.previousStoredCents,
            pendingCents: 0,
          },
        ];
      });
  const requestedLines: PayAppSheetLine[] = lineSource.map((c) => {
    const e = entered.get(c.sovLineId);
    return {
      ...c,
      workThisPeriodCents: e?.workThisPeriodCents ?? 0,
      storedCents: e?.storedCents ?? c.previousStoredCents,
      note: e?.note ?? null,
      requestedWorkCents: null,
      requestedStoredCents: null,
    };
  });
  const originalSum = live?.originalContractSumCents ?? g.originalContractSumCents;
  const previousCerts = live?.previousCertificatesCents ?? g.previousCertificatesCents;
  const requestedSummary = sheetSummary(requestedLines, originalSum, previousCerts);
  const errors = isDraft
    ? g703LineErrors(
        requestedLines.map((l) => ({
          sovLineId: l.sovLineId,
          lineNo: l.lineNo,
          scheduledValueCents: l.scheduledValueCents,
          previousWorkCents: l.previousWorkCents,
          previousStoredCents: l.previousStoredCents,
          pendingCents: l.pendingCents,
          workThisPeriodCents: l.workThisPeriodCents,
          storedCents: l.storedCents,
          note: l.note ?? undefined,
        })),
      )
    : [];
  if (!approvedBasis) return { lines: requestedLines, summary: requestedSummary, requestedSummary: null, basis: "requested", errors };

  const lines: PayAppSheetLine[] = requestedLines.map((l) => {
    const split = approvedWorkAndStored(l, approvedIncrementOf(payApp, l.sovLineId));
    const changed = split.workThisPeriodCents !== l.workThisPeriodCents || split.storedCents !== l.storedCents;
    return {
      ...l,
      ...split,
      requestedWorkCents: changed ? l.workThisPeriodCents : null,
      requestedStoredCents: changed ? l.storedCents : null,
    };
  });
  return { lines, summary: sheetSummary(lines, originalSum, previousCerts), requestedSummary, basis: "approved", errors };
}

type VersionLines = readonly { sovLineId: string; workThisPeriodCents: number; storedCents: number; note?: string }[];

/** Field-level changes from one submitted version's entries to the next. */
export function versionChanges(
  before: VersionLines,
  after: VersionLines,
  lineNoOf: (sovLineId: string) => number,
): { sovLineId: string; lineNo: number; field: "E" | "F" | "note"; from: number | string; to: number | string }[] {
  const prev = new Map(before.map((l) => [l.sovLineId, l]));
  const out: ReturnType<typeof versionChanges> = [];
  for (const l of after) {
    const b = prev.get(l.sovLineId);
    const lineNo = lineNoOf(l.sovLineId);
    const fromE = b?.workThisPeriodCents ?? 0;
    const fromF = b?.storedCents ?? 0;
    if (fromE !== l.workThisPeriodCents) out.push({ sovLineId: l.sovLineId, lineNo, field: "E", from: fromE, to: l.workThisPeriodCents });
    if (fromF !== l.storedCents) out.push({ sovLineId: l.sovLineId, lineNo, field: "F", from: fromF, to: l.storedCents });
    if ((b?.note ?? "") !== (l.note ?? "")) out.push({ sovLineId: l.sovLineId, lineNo, field: "note", from: b?.note ?? "", to: l.note ?? "" });
  }
  return out.sort((a, b) => a.lineNo - b.lineNo);
}

async function decisionView(
  ctx: QueryCtx,
  d: NonNullable<Doc<"payApplications">["gcDecision"]>,
  lineInfo: (sovLineId: string) => { lineNo: number; description: string },
  isSub: boolean,
) {
  const by = await ctx.db.get(d.decidedBy);
  return {
    outcome: d.outcome,
    reason: d.reason ?? null,
    decidedAt: d.decidedAt,
    decidedByName: by?.name ?? by?.email ?? "GC",
    lines: d.lines
      .map((l) => ({
        sovLineId: l.sovLineId,
        ...lineInfo(l.sovLineId),
        action: l.action,
        // The review's figure is GC-side detail; the sub sees only what the GC decided.
        recommendedCents: isSub ? null : l.recommendedCents,
        approvedCents: l.approvedCents,
        reason: l.reason ?? null,
      }))
      .sort((a, b) => a.lineNo - b.lineNo),
  };
}

const DECIDABLE = new Set(["submitted", "under_review", "reviewed"]);

async function payAppView(ctx: QueryCtx, scope: ProjectAccess & { doc: Doc<"payApplications"> }) {
  const payApp = scope.doc;
  const agreement = await ctx.db.get(payApp.agreementId);
  if (agreement === null) throw notFound();
  const sheet = await buildSheet(ctx, agreement, payApp);
  const isSub = scope.partyRole === "sub";
  const proposals = await ctx.db
    .query("agentProposals")
    .withIndex("by_payAppId", (q) => q.eq("payAppId", payApp._id))
    .take(200);
  const decided = proposals.some((p) => p.status === "approved" || p.status === "executed");
  const sovById = new Map((await sovRows(ctx, agreement._id)).map((s) => [s._id as string, s]));
  const lineInfo = (id: string) => {
    const s = sovById.get(id);
    return { lineNo: s?.lineNo ?? 0, description: s?.description ?? "Unknown line" };
  };
  const decision = payApp.gcDecision ? await decisionView(ctx, payApp.gcDecision, lineInfo, isSub) : null;
  const past = payApp.versions ?? [];
  const lastPast = past.length > 0 ? past[past.length - 1] : null;
  // While the sub revises, the GC's reasons from the version it sent back stay visible.
  const revisionRequest =
    payApp.status === "revision_requested"
      ? decision
      : payApp.status === "draft" && lastPast?.decision?.outcome === "revision_requested"
        ? await decisionView(ctx, lastPast.decision, lineInfo, isSub)
        : null;
  const currentVersion = payApp.version ?? 1;
  const versionRows = [
    ...past.map((ver, i) => ({
      version: ver.version,
      current: false,
      submittedAt: ver.submittedAt as number | null,
      requestedTotalCents: ver.requestedTotalCents,
      currentPaymentDueCents: ver.requested?.currentPaymentDueCents ?? null,
      outcome: ver.decision?.outcome ?? null,
      reason: ver.decision?.reason ?? ver.decision?.lines.find((l) => l.reason)?.reason ?? null,
      lines: ver.lines
        .map((l) => ({ sovLineId: l.sovLineId, ...lineInfo(l.sovLineId), workThisPeriodCents: l.workThisPeriodCents, storedCents: l.storedCents, note: l.note ?? null }))
        .sort((a, b) => a.lineNo - b.lineNo),
      changes: i === 0 ? [] : versionChanges(past[i - 1].lines, ver.lines, (id) => lineInfo(id).lineNo),
    })),
  ];
  if (past.length > 0 && payApp.g703) {
    versionRows.push({
      version: currentVersion,
      current: true,
      submittedAt: payApp.status === "draft" ? null : (payApp.submittedAt ?? payApp.createdAt),
      requestedTotalCents: payApp.status === "draft" ? 0 : payApp.requestedTotalCents,
      currentPaymentDueCents: payApp.status === "draft" ? null : (payApp.g703.requested?.currentPaymentDueCents ?? null),
      outcome: payApp.gcDecision?.outcome ?? null,
      reason: payApp.gcDecision?.reason ?? null,
      lines: payApp.g703.lines
        .map((l) => ({ sovLineId: l.sovLineId, ...lineInfo(l.sovLineId), workThisPeriodCents: l.workThisPeriodCents, storedCents: l.storedCents, note: l.note ?? null }))
        .sort((a, b) => a.lineNo - b.lineNo),
      changes: versionChanges(lastPast!.lines, payApp.g703.lines, (id) => lineInfo(id).lineNo),
    });
  }
  const requested = new Map(payApp.lines.map((l) => [l.sovLineId as string, l.requestedCents]));
  const review =
    !isSub && payApp.review
      ? {
          engine: payApp.review.engine,
          provider: payApp.review.provider,
          model: payApp.review.model,
          fallbackReason: payApp.review.fallbackReason ?? null,
          reviewedAt: payApp.review.reviewedAt,
          approvedTotalCents: payApp.review.approvedTotalCents,
          flags: payApp.review.flags,
          lines: payApp.review.lines
            .map((l) => ({
              sovLineId: l.sovLineId,
              ...lineInfo(l.sovLineId),
              verdict: l.verdict,
              recommendedPctToDate: l.recommendedPctToDate,
              approvedCents: l.approvedCents,
              requestedCents: requested.get(l.sovLineId) ?? 0,
              reason: l.reason,
            }))
            .sort((a, b) => a.lineNo - b.lineNo),
        }
      : null;
  const lineErrors = sheet.errors.map((e) => ({ sovLineId: e.sovLineId, message: e.message }));
  const changeOrders = await payAppChangeOrderSummary(ctx, payApp, new Set(sheet.lines.map((l) => l.sovLineId as string)));
  const claimedCents = sheet.lines.reduce((acc, l) => acc + lineIncrementCents(l), 0);
  return {
    _id: payApp._id,
    format: payApp.g703 ? ("g703" as const) : ("legacy" as const),
    viewerRole: scope.partyRole,
    status: payApp.status,
    applicationNo: payApp.applicationNo ?? null,
    periodLabel: payApp.periodLabel,
    periodStart: payApp.periodStart ?? null,
    periodEnd: payApp.periodEnd ?? null,
    dueDate: payApp.dueDate ?? null,
    savedAt: payApp.g703?.savedAt ?? null,
    submittedAt: payApp.status === "draft" ? null : (payApp.submittedAt ?? payApp.createdAt),
    notes: payApp.notes,
    submittedBy: { actorType: payApp.submittedBy.actorType, isCaller: payApp.submittedBy.userId === scope.viewer.userId },
    rejectionReason: payApp.status === "rejected" ? (payApp.rejectionReason ?? null) : null,
    withdrawnAt: payApp.withdrawnAt ?? null,
    agreement: {
      _id: agreement._id,
      agreementNumber: agreement.agreementNumber,
      projectTitle: agreement.projectTitle,
      subcontractorName: await subNameOf(ctx, agreement, payApp),
    },
    basis: sheet.basis,
    retainageBps: payApp.g703?.retainageBps ?? agreementRetainageBps(agreement),
    lines: sheet.lines,
    summary: sheet.summary,
    requestedSummary: sheet.requestedSummary,
    lineErrors,
    editable: isSub && payApp.status === "draft",
    canSubmit: isSub && payApp.status === "draft" && lineErrors.length === 0 && claimedCents > 0,
    canWithdraw: isSub && WITHDRAWABLE_PAY_APP_STATUSES.has(payApp.status) && !decided && payApp.gcDecision === undefined,
    canRevise: isSub && payApp.status === "revision_requested" && payApp.g703 !== undefined,
    canApprove: !isSub && payApp.status === "reviewed" && payApp.review !== undefined,
    canRequestRevision: !isSub && DECIDABLE.has(payApp.status) && payApp.g703 !== undefined,
    canReject: !isSub && DECIDABLE.has(payApp.status),
    version: currentVersion,
    versions: versionRows,
    decision,
    revisionRequest,
    review,
    excludedScopeNotes: isSub ? [] : (agreement.excludedScopeNotes ?? []),
    changeOrders,
  };
}

/** Sub drafts stay private until submitted: the GC gets "Not found." for them. */
function hideDraftFromGc<S extends { doc: Doc<"payApplications">; partyRole: string }>(scope: S): S {
  if (scope.doc.status === "draft" && scope.partyRole !== "sub") throw notFound();
  return scope;
}

/**
 * One pay app with its G703 continuation sheet and G702 summary, for the GC and the filing sub. Owners,
 * other subs and other companies get "Not found.".
 */
export const getPayApp = query({
  args: { payAppId: v.string() },
  handler: async (ctx, args) => {
    const scope = hideDraftFromGc(await requireDocScope(ctx, "payApplications", args.payAppId, { roles: ["gc", "sub"] }));
    return await payAppView(ctx, scope);
  },
});

/** The continuation-sheet lines of one pay app (same access as getPayApp). */
export const payAppLines = query({
  args: { payAppId: v.string() },
  handler: async (ctx, args) => {
    const scope = hideDraftFromGc(await requireDocScope(ctx, "payApplications", args.payAppId, { roles: ["gc", "sub"] }));
    const agreement = await ctx.db.get(scope.doc.agreementId);
    if (agreement === null) throw notFound();
    return (await buildSheet(ctx, agreement, scope.doc)).lines;
  },
});

// ---- Sub: pay apps page -----------------------------------------------------------------------

function listRow(p: Doc<"payApplications">) {
  const figures = p.g703?.approved ?? p.g703?.requested;
  return {
    _id: p._id,
    applicationNo: p.applicationNo ?? null,
    periodLabel: p.periodLabel,
    periodEnd: p.periodEnd ?? null,
    dueDate: p.dueDate ?? null,
    status: p.status,
    currentPaymentDueCents: figures?.currentPaymentDueCents ?? null,
    requestedTotalCents: p.requestedTotalCents,
    submittedAt: p.status === "draft" ? null : (p.submittedAt ?? p.createdAt),
  };
}

/** The sub's executed agreements with the open or next application of each and their recent pay apps. */
export const mySubPayAppAgreements = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["sub"]);
    const { rows } = await scopedAgreements(ctx, { parties: ["sub"], limit: 100 });
    const out = [];
    for (const { agreement, access } of rows) {
      if (agreement.status === "superseded") continue;
      const payApps = await ctx.db
        .query("payApplications")
        .withIndex("by_agreementId", (q) => q.eq("agreementId", agreement._id))
        .order("desc")
        .take(25);
      const open = payApps.find((p) => p.g703 !== undefined && OPEN_G703_STATUSES.has(p.status)) ?? null;
      let blockedReason = blockedReasonOf(agreement);
      let next: (BillingPeriod & { applicationNo: number }) | null = null;
      if (blockedReason === null && open === null) {
        try {
          const live = await g703Context(ctx, agreement);
          next = nextApplicationFor(access.project, agreement, live.approved);
        } catch (err) {
          blockedReason = err instanceof ConvexError ? String((err.data as { message?: string }).message ?? "Billing is blocked.") : "Billing is blocked.";
        }
      }
      out.push({
        agreementId: agreement._id,
        agreementNumber: agreement.agreementNumber,
        projectTitle: agreement.projectTitle,
        tradeName: agreement.tradeName,
        contractSumCents: agreementContractSumCents(agreement),
        blockedReason,
        openPayApp: open ? listRow(open) : null,
        nextApplication: next,
        payApps: payApps.map(listRow),
      });
    }
    return out;
  },
});

/**
 * Opens the agreement's next pay application as a draft (or returns the one already open). Its number
 * and period follow the last approved application, so the next period opens as soon as the previous
 * application is approved; stored material carries forward into F.
 */
export const startPayApp = mutation({
  args: { agreementId: v.string() },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "agreements", args.agreementId, { roles: ["sub"], write: true });
    const agreement = scope.doc;
    assertBillable(agreement);
    const open = await openG703PayApp(ctx, agreement._id);
    if (open !== null) return { payAppId: open._id, created: false };
    const live = await g703Context(ctx, agreement);
    const next = nextApplicationFor(scope.project, agreement, live.approved);
    const now = Date.now();
    const contractor = await ctx.db.get(agreement.contractorId);
    const payAppId = await ctx.db.insert("payApplications", {
      agreementId: agreement._id,
      contractorId: agreement.contractorId,
      ...(contractor?.linkedCompanyId ? { subCompanyId: contractor.linkedCompanyId } : {}),
      subUserId: scope.viewer.userId,
      periodLabel: periodLabelFor(next.applicationNo, next.periodEnd),
      lines: [],
      requestedTotalCents: 0,
      notes: "",
      lienWaiver: false,
      status: "draft",
      submittedBy: submittedByFor(scope.viewer),
      applicationNo: next.applicationNo,
      periodStart: next.periodStart,
      periodEnd: next.periodEnd,
      dueDate: next.dueDate,
      g703: {
        lines: live.lines.map((l) => ({
          sovLineId: l.sovLineId,
          previousWorkCents: l.previousWorkCents,
          previousStoredCents: l.previousStoredCents,
          workThisPeriodCents: 0,
          storedCents: l.previousStoredCents,
        })),
        originalContractSumCents: live.originalContractSumCents,
        retainageBps: live.retainageBps,
        previousCertificatesCents: live.previousCertificatesCents,
        savedAt: now,
      },
      createdAt: now,
    });
    await ctx.db.insert("auditLogs", {
      projectId: agreement.projectId,
      agreementId: agreement._id,
      eventType: "pay_app_draft_started",
      title: "Pay application draft started",
      description: `${agreement.agreementNumber} pay app #${next.applicationNo}: period ${formatIsoDate(next.periodStart)} – ${formatIsoDate(next.periodEnd)}, due ${formatIsoDate(next.dueDate)}.`,
      ...auditActor(scope),
      timestamp: now,
      ...viewerAgentAuditFields(scope.viewer),
    });
    return { payAppId, created: true };
  },
});

const entryArg = v.object({
  sovLineId: v.string(),
  workThisPeriodCents: v.number(),
  storedCents: v.number(),
  note: v.optional(v.string()),
});

type EntryArg = Infer<typeof entryArg>;

function invalid(message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "INVALID_PAY_APP", message });
}

/**
 * Merges entered E/F values into a draft's stored lines and refreshes the previous-application values
 * from the live context (a change order may have added a line). Over-100% values are kept so the sub
 * sees them with their errors; submit refuses them.
 */
function mergeEntries(
  live: Awaited<ReturnType<typeof g703Context>>,
  existing: StoredG703,
  entries: readonly EntryArg[] | undefined,
): StoredG703["lines"] {
  const known = new Set(live.lines.map((l) => l.sovLineId as string));
  const deductive = new Set(live.lines.filter((l) => l.scheduledValueCents < 0).map((l) => l.sovLineId as string));
  const byId = new Map(existing.lines.map((l) => [l.sovLineId as string, l]));
  const seen = new Set<string>();
  for (const e of entries ?? []) {
    if (!known.has(e.sovLineId)) throw invalid("A line does not belong to this agreement's schedule of values.");
    if (seen.has(e.sovLineId)) throw invalid("A line appears more than once.");
    seen.add(e.sovLineId);
    for (const cents of [e.workThisPeriodCents, e.storedCents]) {
      if (!Number.isSafeInteger(cents)) throw invalid("Amounts must be whole cents.");
      // A deductive change-order line bills a negative E; its range is checked with the line errors.
      const negativeAllowed = deductive.has(e.sovLineId) && cents === e.workThisPeriodCents;
      if (cents < 0 && !negativeAllowed) throw invalid("Amounts cannot be negative; the total to date cannot drop below the previous applications.");
      if (Math.abs(cents) > MAX_LINE_CENTS) throw invalid("An amount is too large.");
    }
    if (e.note !== undefined && e.note.length > MAX_STORED_NOTE_LENGTH) {
      throw invalid(`A line note must be at most ${MAX_STORED_NOTE_LENGTH} characters.`);
    }
  }
  const entryById = new Map((entries ?? []).map((e) => [e.sovLineId, e]));
  return live.lines.map((c) => {
    const e = entryById.get(c.sovLineId);
    const prev = byId.get(c.sovLineId);
    const note = (e ? e.note : prev?.note)?.trim();
    return {
      sovLineId: c.sovLineId,
      previousWorkCents: c.previousWorkCents,
      previousStoredCents: c.previousStoredCents,
      workThisPeriodCents: e?.workThisPeriodCents ?? prev?.workThisPeriodCents ?? 0,
      storedCents: e?.storedCents ?? prev?.storedCents ?? c.previousStoredCents,
      ...(note ? { note } : {}),
    };
  });
}

async function editableDraft(ctx: MutationCtx, scope: ProjectAccess & { doc: Doc<"payApplications"> }) {
  const payApp = scope.doc;
  if (payApp.g703 === undefined) throw notFound();
  if (payApp.status !== "draft") {
    throw new ConvexError({
      code: "LOCKED",
      message: "This pay application was submitted; its entries are locked.",
    });
  }
  const agreement = await ctx.db.get(payApp.agreementId);
  if (agreement === null) throw notFound();
  assertBillable(agreement);
  return { scope, payApp, agreement, g703: payApp.g703 };
}

function checkNotes(notes: string | undefined): void {
  if (notes !== undefined && notes.length > MAX_NOTES_LENGTH) throw invalid(`Notes must be at most ${MAX_NOTES_LENGTH} characters.`);
}

/** Autosaves a draft's entries. Only the filing sub's side may edit, and only while it is a draft. */
export const saveDraft = mutation({
  args: { payAppId: v.string(), lines: v.optional(v.array(entryArg)), notes: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { payApp, agreement, g703 } = await editableDraft(
      ctx,
      await requireDocScope(ctx, "payApplications", args.payAppId, { roles: ["sub"], write: true }),
    );
    checkNotes(args.notes);
    const live = await g703Context(ctx, agreement, { excludePayAppId: payApp._id });
    const now = Date.now();
    await ctx.db.patch(payApp._id, {
      g703: {
        ...g703,
        lines: mergeEntries(live, g703, args.lines),
        originalContractSumCents: live.originalContractSumCents,
        previousCertificatesCents: live.previousCertificatesCents,
        savedAt: now,
      },
      ...(args.notes !== undefined ? { notes: args.notes.trim() } : {}),
    });
    return { savedAt: now };
  },
});

function pct2(cents: number, scheduled: number): number {
  const h = percentHundredths(cents, scheduled);
  return h === null ? 0 : Math.min(100, Math.max(0, h / 100));
}

/**
 * Submits a draft (optionally applying a last set of entries first). Every line is checked against
 * 100% of its scheduled value on the server; the entries and previous values are then frozen, the
 * per-line increments become the Phase-1 `lines`, the AI review is scheduled and the GC is notified.
 */
export const submitPayApp = mutation({
  args: { payAppId: v.string(), lines: v.optional(v.array(entryArg)), notes: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { scope, payApp, agreement, g703 } = await editableDraft(
      ctx,
      await requireDocScope(ctx, "payApplications", args.payAppId, { roles: ["sub"], write: true }),
    );
    checkNotes(args.notes);
    const live = await g703Context(ctx, agreement, { excludePayAppId: payApp._id });
    const lines = mergeEntries(live, g703, args.lines);
    const ctxById = new Map(live.lines.map((l) => [l.sovLineId as string, l]));
    const errors = g703LineErrors(
      lines.map((l) => {
        const c = ctxById.get(l.sovLineId)!;
        return { ...c, workThisPeriodCents: l.workThisPeriodCents, storedCents: l.storedCents, note: l.note };
      }),
    );
    if (errors.length > 0) {
      throw new ConvexError({ code: "INVALID_PAY_APP", message: errors.map((e) => e.message).join(" "), errors });
    }
    const legacyLines = lines.flatMap((l) => {
      const c = ctxById.get(l.sovLineId)!;
      const inc = lineIncrementCents(l);
      if (inc <= 0) return [];
      const toDate = l.previousWorkCents + l.workThisPeriodCents + l.storedCents;
      return [
        {
          sovLineId: l.sovLineId,
          pctCompleteThisPeriod: pct2(inc, c.scheduledValueCents),
          pctCompleteToDate: pct2(toDate, c.scheduledValueCents),
          requestedCents: inc,
        },
      ];
    });
    const requestedTotalCents = legacyLines.reduce((acc, l) => acc + l.requestedCents, 0);
    if (requestedTotalCents <= 0) throw invalid("Enter work completed or materials stored on at least one line.");
    const summary = g702Summary(
      lines.map((l) => ({ ...l, scheduledValueCents: ctxById.get(l.sovLineId)!.scheduledValueCents, retainageBps: ctxById.get(l.sovLineId)!.retainageBps })),
      { originalContractSumCents: live.originalContractSumCents, previousCertificatesCents: live.previousCertificatesCents },
    );
    const now = Date.now();
    const notes = args.notes !== undefined ? args.notes.trim() : payApp.notes;
    await ctx.db.patch(payApp._id, {
      status: "submitted",
      lines: legacyLines,
      requestedTotalCents,
      notes,
      submittedBy: submittedByFor(scope.viewer),
      subUserId: scope.viewer.userId,
      submittedAt: now,
      createdAt: now,
      g703: {
        ...g703,
        lines,
        originalContractSumCents: live.originalContractSumCents,
        previousCertificatesCents: live.previousCertificatesCents,
        savedAt: now,
        requested: figuresOf(summary),
      },
    });
    const isAgent = scope.viewer.user.actorType === "agent";
    await ctx.db.insert("auditLogs", {
      projectId: agreement.projectId,
      agreementId: agreement._id,
      eventType: "pay_app_submitted",
      title: "Pay application submitted",
      description: `${agreement.agreementNumber} ${payApp.periodLabel}: completed & stored ${formatCents(summary.completedAndStoredCents)}, retainage ${formatCents(summary.retainageCents)}, current payment due ${formatCents(summary.currentPaymentDueCents)}${isAgent ? " (billing agent)" : ""}.`,
      ...auditActor(scope),
      timestamp: now,
      ...viewerAgentAuditFields(scope.viewer),
    });
    await ctx.scheduler.runAfter(0, internal.payApps.review.reviewPayApp, { payAppId: payApp._id });
    const updated = (await ctx.db.get(payApp._id))!;
    await notifyPayAppSubmitted(ctx, agreement, updated, summary.currentPaymentDueCents);
    return { payAppId: payApp._id, status: "submitted" as const, currentPaymentDueCents: summary.currentPaymentDueCents };
  },
});

/**
 * G702 figures from the GC-approved per-line increments of a G703 application, to store when it is
 * approved. Null for Phase-1 applications.
 */
export async function approvedG702Figures(
  ctx: QueryCtx,
  payApp: Doc<"payApplications">,
  finalLines: readonly { sovLineId: Id<"scheduleOfValues">; approvedCents: number }[],
): Promise<G702Figures | null> {
  const g = payApp.g703;
  if (g === undefined) return null;
  const sov = new Map((await sovRows(ctx, payApp.agreementId)).map((s) => [s._id as string, s]));
  const approved = new Map(finalLines.map((l) => [l.sovLineId as string, l.approvedCents]));
  const lines = g.lines.flatMap((l) => {
    const s = sov.get(l.sovLineId);
    if (!s) return [];
    const split = approvedWorkAndStored(l, approved.get(l.sovLineId) ?? 0);
    return [
      {
        scheduledValueCents: s.scheduledValueCents,
        retainageBps: s.retainageBps ?? g.retainageBps,
        previousWorkCents: l.previousWorkCents,
        ...split,
      },
    ];
  });
  return figuresOf(
    g702Summary(lines, { originalContractSumCents: g.originalContractSumCents, previousCertificatesCents: g.previousCertificatesCents }),
  );
}

// ---- GC: billing worklist -----------------------------------------------------------------------

const AWAITING_REVIEW = new Set(["submitted", "under_review", "reviewed"]);

/** Submitted pay apps across the GC's projects, newest first. Drafts are the sub's and never listed. */
export const gcBillingWorklist = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["gc"]);
    const { rows, truncated } = await scopedAgreements(ctx, { parties: ["gc"], limit: 200 });
    const out = [];
    for (const { agreement } of rows) {
      if (agreement.status === "superseded") continue;
      const payApps = await ctx.db
        .query("payApplications")
        .withIndex("by_agreementId", (q) => q.eq("agreementId", agreement._id))
        .order("desc")
        .take(25);
      const subName = await subNameOf(ctx, agreement);
      for (const p of payApps) {
        if (p.status === "draft") continue;
        out.push({
          ...listRow(p),
          agreementId: agreement._id,
          agreementNumber: agreement.agreementNumber,
          projectTitle: agreement.projectTitle,
          subName: p.subCompanyId ? ((await ctx.db.get(p.subCompanyId))?.name ?? subName) : subName,
          awaitingReview: AWAITING_REVIEW.has(p.status),
          isG703: p.g703 !== undefined,
        });
      }
    }
    out.sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0));
    return { rows: out.slice(0, 150), truncated: truncated || out.length > 150 };
  },
});
