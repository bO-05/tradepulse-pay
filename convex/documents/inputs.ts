import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { contractSumCentsOf, projectPlace, resolveAgreementTerms } from "../lib/agreementDocument";
import { paymentTermsText, retainageText, stateName } from "../lib/agreementTerms";
import { notFound } from "../lib/tenancy";
import { payAppChangeOrderSummary, primeChangeOrders, subcontractChangeOrders } from "../billing/changeOrderView";
import { CO_APPROVED_STATUSES, changeOrderLabel, changeOrderScopeOf, contractSumsByApproval, type ChangeOrderStatus } from "../payments/changeOrderMath";
import { agreementContractSumCents } from "../payments/sov";
import { buildSheet, subNameOf } from "../payApps/g703";
import { formatIsoDate, formatPercentHundredths, g703Line, isoDate, percentHundredths } from "../payApps/g703Math";
import { DOCUMENT_KINDS, type DocumentKind } from "./kinds";
import type { G702Figures, LoadedDocument, SheetLine, SheetTotals } from "./inputTypes";
import { fileSlug } from "./pdfText";
import { loadSovRows } from "../lib/sovLines";

/**
 * Loads the plain-data input of a document from the database (no authorization here: callers
 * authorize first, see access.ts). The result is deterministic for unchanged data, so its hash
 * tells whether a stored document is current.
 */

const STATUS_TEXT: Record<string, string> = {
  submitted_to_owner: "Submitted to owner",
  changes_requested: "Changes requested",
  approved_invoiced: "Approved, invoiced",
  approved_as_noted: "Approved as noted",
  revision_requested: "Revision requested",
  under_review: "Under review",
  generated: "Not executed",
};

export function statusText(code: string): string {
  const known = STATUS_TEXT[code];
  if (known) return known;
  const words = code.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function dayOf(ms: number | undefined | null): string | null {
  return ms === undefined || ms === null ? null : formatIsoDate(isoDate(new Date(ms)));
}

async function personName(ctx: QueryCtx, userId: Id<"users"> | undefined): Promise<string | null> {
  if (userId === undefined) return null;
  const user = await ctx.db.get(userId);
  if (user === null) return null;
  return user.name?.trim() || user.email || null;
}

async function gcNameOf(ctx: QueryCtx, project: Doc<"projects">, fallback?: string): Promise<string> {
  const company = project.gcCompanyId ? await ctx.db.get(project.gcCompanyId) : null;
  return company?.name ?? project.generalContractorName ?? fallback ?? "General contractor";
}

async function ownerNameOf(ctx: QueryCtx, project: Doc<"projects">): Promise<string | null> {
  if (project.ownerName?.trim()) return project.ownerName.trim();
  const company = project.ownerCompanyId ? await ctx.db.get(project.ownerCompanyId) : null;
  return company?.name ?? null;
}

async function projectOf(ctx: QueryCtx, projectId: Id<"projects">): Promise<Doc<"projects">> {
  const project = await ctx.db.get(projectId);
  if (project === null) throw notFound();
  return project;
}

function sheetLine(item: string, description: string, l: { scheduledValueCents: number; previousWorkCents: number; workThisPeriodCents: number; storedCents: number; retainageBps: number }): SheetLine {
  const f = g703Line(l);
  return {
    item,
    description,
    scheduledValueCents: l.scheduledValueCents,
    previousCents: l.previousWorkCents,
    thisPeriodCents: l.workThisPeriodCents,
    storedCents: l.storedCents,
    totalCents: f.totalCents,
    percentText: formatPercentHundredths(f.percentHundredths),
    balanceCents: f.balanceCents,
    retainageCents: f.retainageCents,
  };
}

function totalsOf(lines: readonly SheetLine[]): SheetTotals {
  const sum = (pick: (l: SheetLine) => number) => lines.reduce((acc, l) => acc + pick(l), 0);
  const scheduledValueCents = sum((l) => l.scheduledValueCents);
  const totalCents = sum((l) => l.totalCents);
  return {
    scheduledValueCents,
    previousCents: sum((l) => l.previousCents),
    thisPeriodCents: sum((l) => l.thisPeriodCents),
    storedCents: sum((l) => l.storedCents),
    totalCents,
    percentText: formatPercentHundredths(percentHundredths(totalCents, scheduledValueCents)),
    balanceCents: sum((l) => l.balanceCents),
    retainageCents: sum((l) => l.retainageCents),
  };
}

function figuresOf(f: G702Figures): G702Figures {
  return {
    originalContractSumCents: f.originalContractSumCents,
    netChangeOrdersCents: f.netChangeOrdersCents,
    contractSumToDateCents: f.contractSumToDateCents,
    completedAndStoredCents: f.completedAndStoredCents,
    retainageCents: f.retainageCents,
    retainageWorkCents: f.retainageWorkCents,
    retainageStoredCents: f.retainageStoredCents,
    earnedLessRetainageCents: f.earnedLessRetainageCents,
    previousCertificatesCents: f.previousCertificatesCents,
    currentPaymentDueCents: f.currentPaymentDueCents,
    balanceToFinishInclRetainageCents: f.balanceToFinishInclRetainageCents,
  };
}

async function agreementOf(ctx: QueryCtx, agreementId: Id<"agreements">): Promise<Doc<"agreements">> {
  const agreement = await ctx.db.get(agreementId);
  if (agreement === null) throw notFound();
  return agreement;
}

async function payAppSheet(ctx: QueryCtx, payApp: Doc<"payApplications">) {
  const agreement = await agreementOf(ctx, payApp.agreementId);
  const sheet = await buildSheet(ctx, agreement, payApp);
  const lines = sheet.lines.map((l) => sheetLine(String(l.lineNo), l.description, l));
  return { agreement, sheet, lines, totals: totalsOf(lines) };
}

function payAppNoText(payApp: Doc<"payApplications">): string {
  return payApp.applicationNo !== undefined ? `pay-app-${payApp.applicationNo}` : `pay-app-${fileSlug(payApp.periodLabel)}`;
}

async function subPayAppDocument(ctx: QueryCtx, payApp: Doc<"payApplications">): Promise<LoadedDocument> {
  const { agreement, sheet, lines, totals } = await payAppSheet(ctx, payApp);
  const project = await projectOf(ctx, agreement.projectId);
  const changeOrders = await payAppChangeOrderSummary(ctx, payApp, new Set(sheet.lines.map((l) => l.sovLineId as string)));
  const approved = sheet.basis === "approved" ? sheet.finalApproval : undefined;
  const isDraft = payApp.status === "draft";
  return {
    projectId: project._id,
    fileName: `${fileSlug(agreement.agreementNumber)}-${payAppNoText(payApp)}.pdf`,
    asOf: approved?.approvedAt ?? payApp.submittedAt ?? payApp.g703?.savedAt ?? payApp.createdAt,
    input: {
      kind: "sub_pay_app_pdf",
      data: {
        gcName: await gcNameOf(ctx, project, agreement.generalContractorName),
        subName: await subNameOf(ctx, agreement, payApp),
        ownerName: await ownerNameOf(ctx, project),
        projectTitle: project.title,
        projectAddress: projectPlace(project).address,
        agreementNumber: agreement.agreementNumber,
        applicationNo: payApp.applicationNo ?? null,
        periodLabel: payApp.periodLabel,
        periodStart: payApp.periodStart ?? null,
        periodEnd: payApp.periodEnd ?? null,
        dueDate: payApp.dueDate ?? null,
        statusLabel: statusText(payApp.status),
        basisLabel: approved
          ? "GC-approved amounts"
          : sheet.basis === "unverified"
            ? "Approved amounts cannot be verified; as submitted by the subcontractor"
            : isDraft
              ? "Draft, not submitted"
              : "As submitted by the subcontractor",
        retainageBps: payApp.g703?.retainageBps ?? (lines.length > 0 ? sheet.lines[0].retainageBps : 0),
        figures: figuresOf(sheet.summary),
        lines,
        totals,
        changeOrders: changeOrders.map((co) => ({ label: co.label, title: co.title, amountCents: co.amountCents, approvedOn: dayOf(co.approvedAt) })),
        approvedBy: approved ? await personName(ctx, approved.approvedBy) : null,
        approvedOn: approved ? dayOf(approved.approvedAt) : null,
      },
    },
  };
}

async function payAppLinesDocument(ctx: QueryCtx, payApp: Doc<"payApplications">): Promise<LoadedDocument> {
  const { agreement, lines, totals } = await payAppSheet(ctx, payApp);
  return {
    projectId: agreement.projectId,
    fileName: `${fileSlug(agreement.agreementNumber)}-${payAppNoText(payApp)}-lines.csv`,
    asOf: 0,
    input: { kind: "pay_app_lines_csv", data: { lines, totals } },
  };
}

async function ownerPayAppDocument(ctx: QueryCtx, app: Doc<"ownerPayApps">): Promise<LoadedDocument> {
  const project = await projectOf(ctx, app.projectId);
  const lines = app.lines.map((l, i) => sheetLine(String(i + 1), l.description, l));
  const approval = [...app.history].reverse().find((h) => h.status === "approved");
  return {
    projectId: project._id,
    fileName: `${fileSlug(project.title)}-owner-pay-app-${app.applicationNo}.pdf`,
    asOf: app.approvedAt ?? app.submittedAt ?? app.updatedAt,
    input: {
      kind: "owner_pay_app_pdf",
      data: {
        gcName: await gcNameOf(ctx, project),
        ownerName: (await ownerNameOf(ctx, project)) ?? "Owner",
        projectTitle: project.title,
        projectAddress: projectPlace(project).address,
        applicationNo: app.applicationNo,
        periodStart: app.periodStart,
        periodEnd: app.periodEnd,
        statusLabel: statusText(app.status),
        retainageBps: app.retainageBps,
        figures: figuresOf(app.figures),
        lines,
        totals: totalsOf(lines),
        submittedOn: dayOf(app.submittedAt),
        approvedBy: approval?.byName ?? null,
        approvedOn: dayOf(app.approvedAt ?? approval?.at),
      },
    },
  };
}

async function changeOrderDocument(ctx: QueryCtx, co: Doc<"changeOrders">): Promise<LoadedDocument> {
  const scope = changeOrderScopeOf(co);
  const agreement = co.agreementId !== undefined ? await ctx.db.get(co.agreementId) : null;
  const projectId = co.projectId ?? agreement?.projectId;
  if (projectId === undefined) throw notFound();
  const project = await projectOf(ctx, projectId);
  const gcName = await gcNameOf(ctx, project, agreement?.generalContractorName);
  let original: number;
  let siblings: Doc<"changeOrders">[];
  let partyFrom: { role: string; name: string };
  let partyTo: { role: string; name: string };
  let contractRef: string;
  if (scope === "prime") {
    original = project.contractValueCents ?? 0;
    siblings = await primeChangeOrders(ctx, project._id);
    partyFrom = { role: "Owner", name: (await ownerNameOf(ctx, project)) ?? "Owner" };
    partyTo = { role: "Contractor", name: gcName };
    contractRef = "Prime contract (owner and contractor)";
  } else {
    if (agreement === null) throw notFound();
    original = agreementContractSumCents(agreement);
    siblings = await subcontractChangeOrders(ctx, agreement._id);
    partyFrom = { role: "Contractor", name: gcName };
    partyTo = { role: "Subcontractor", name: await subNameOf(ctx, agreement) };
    contractRef = `Subcontract ${agreement.agreementNumber}`;
  }
  const isApproved = (c: Doc<"changeOrders">) => CO_APPROVED_STATUSES.has(c.status as ChangeOrderStatus);
  const approved = isApproved(co);
  // An approved CO shows the sums captured at its approval (or, for records approved before those
  // were captured, the sums rebuilt in approval order); any other CO shows what approving it now does.
  let previous: number;
  if (approved && co.contractSumBeforeCents !== undefined) previous = co.contractSumBeforeCents;
  else if (approved) {
    const byApproval = contractSumsByApproval(
      original,
      siblings.filter(isApproved).map((c) => ({ id: c._id, amountCents: c.amountCents, approvedAt: c.approvedAt, createdAt: c.createdAt, number: c.number })),
    );
    previous = byApproval.get(co._id)?.beforeCents ?? original;
  } else previous = original + siblings.filter(isApproved).reduce((acc, c) => acc + c.amountCents, 0);
  const label = changeOrderLabel(co.number, scope);
  return {
    projectId: project._id,
    fileName: `${fileSlug(scope === "prime" ? project.title : (agreement?.agreementNumber ?? project.title))}-${scope === "prime" ? "pco" : "co"}-${co.number}.pdf`,
    asOf: co.approvedAt ?? co.rejectedAt ?? co.submittedAt ?? co.updatedAt ?? co.createdAt,
    input: {
      kind: "change_order_pdf",
      data: {
        scope,
        number: co.number,
        label,
        title: co.title ?? co.description,
        description: co.title === undefined ? "" : co.description,
        amountCents: co.amountCents,
        scheduleDays: co.scheduleDays ?? null,
        statusLabel: co.status === "cancelled" ? "Approved (invoice cancelled)" : statusText(co.status),
        projectTitle: project.title,
        projectAddress: projectPlace(project).address,
        partyFrom,
        partyTo,
        contractRef,
        originalContractSumCents: original,
        previousContractSumCents: previous,
        newContractSumCents: previous + co.amountCents,
        approved,
        approvedBy: approved ? await personName(ctx, co.approvedBy) : null,
        approvedOn: approved ? dayOf(co.approvedAt) : null,
        requestedOn: dayOf(co.submittedAt),
      },
    },
  };
}

async function subcontractDocument(ctx: QueryCtx, agreement: Doc<"agreements">): Promise<LoadedDocument> {
  const project = await projectOf(ctx, agreement.projectId);
  const terms = resolveAgreementTerms(agreement, project);
  return {
    projectId: project._id,
    fileName: `${fileSlug(agreement.agreementNumber)}-subcontract.pdf`,
    asOf: agreement.executedAt ?? agreement.createdAt,
    input: {
      kind: "subcontract_pdf",
      data: {
        agreementNumber: agreement.agreementNumber,
        gcName: await gcNameOf(ctx, project, agreement.generalContractorName),
        subName: await subNameOf(ctx, agreement),
        projectTitle: project.title,
        projectAddress: projectPlace(project).address,
        trade: `${agreement.csiDivision} ${agreement.tradeName}`.trim(),
        contractSumCents: contractSumCentsOf(agreement),
        retainageText: retainageText(terms),
        paymentTermsText: paymentTermsText(terms.paymentTerms),
        governingLaw: stateName(terms.governingState),
        statusLabel: statusText(agreement.status),
        executedOn: dayOf(agreement.executedAt),
        contractText: agreement.contractText,
      },
    },
  };
}

async function sovDocument(ctx: QueryCtx, agreement: Doc<"agreements">): Promise<LoadedDocument> {
  const rows = await loadSovRows(ctx, agreement._id);
  return {
    projectId: agreement.projectId,
    fileName: `${fileSlug(agreement.agreementNumber)}-sov.csv`,
    asOf: 0,
    input: {
      kind: "sov_csv",
      data: { lines: rows.map((r) => ({ lineNo: r.lineNo, description: r.description, csiCode: r.csiCode ?? "", scheduledValueCents: r.scheduledValueCents })) },
    },
  };
}

async function retainageDocument(ctx: QueryCtx, agreement: Doc<"agreements">): Promise<LoadedDocument> {
  const ledger = await ctx.db
    .query("retainageLedger")
    .withIndex("by_agreementId", (q) => q.eq("agreementId", agreement._id))
    .take(1000);
  const rows = [];
  for (const r of ledger) {
    const payment = r.paymentId ? await ctx.db.get(r.paymentId) : null;
    const payApp = payment?.payAppId ? await ctx.db.get(payment.payAppId) : null;
    const reference = payApp
      ? payApp.applicationNo !== undefined
        ? `Pay app #${payApp.applicationNo}`
        : payApp.periodLabel
      : payment
        ? `Payment (${payment.kind})`
        : "Adjustment";
    rows.push({ date: isoDate(new Date(r.createdAt)), reference, description: r.reason, amountCents: r.deltaCents });
  }
  return {
    projectId: agreement.projectId,
    fileName: `${fileSlug(agreement.agreementNumber)}-retainage-ledger.csv`,
    asOf: 0,
    input: { kind: "retainage_ledger_csv", data: { rows } },
  };
}

/** The related record of a document kind, by id; null when missing. */
export async function relatedDoc(ctx: QueryCtx, kind: DocumentKind, relatedId: string) {
  const table = DOCUMENT_KINDS[kind].table;
  const id = ctx.db.normalizeId(table, relatedId);
  return id === null ? null : await ctx.db.get(id);
}

/** Loads the input of `kind` for an already-loaded related record. */
export async function loadDocument(
  ctx: QueryCtx,
  kind: DocumentKind,
  related: Doc<"payApplications"> | Doc<"ownerPayApps"> | Doc<"changeOrders"> | Doc<"agreements">,
): Promise<LoadedDocument> {
  switch (kind) {
    case "sub_pay_app_pdf":
      return await subPayAppDocument(ctx, related as Doc<"payApplications">);
    case "pay_app_lines_csv":
      return await payAppLinesDocument(ctx, related as Doc<"payApplications">);
    case "owner_pay_app_pdf":
      return await ownerPayAppDocument(ctx, related as Doc<"ownerPayApps">);
    case "change_order_pdf":
      return await changeOrderDocument(ctx, related as Doc<"changeOrders">);
    case "subcontract_pdf":
      return await subcontractDocument(ctx, related as Doc<"agreements">);
    case "sov_csv":
      return await sovDocument(ctx, related as Doc<"agreements">);
    case "retainage_ledger_csv":
      return await retainageDocument(ctx, related as Doc<"agreements">);
  }
}

// Bump when the PDF/CSV layout changes, so stored documents of unchanged records are re-rendered.
export const DOCUMENT_RENDER_VERSION = 2;

/** sha256 hex of the canonical input, used to tell whether a stored document is still current. */
export async function inputsHashOf(doc: LoadedDocument): Promise<string> {
  return await sha256Hex(new TextEncoder().encode(JSON.stringify({ v: DOCUMENT_RENDER_VERSION, doc })));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
