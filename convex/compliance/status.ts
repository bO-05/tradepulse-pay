import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { resolveAgreementTerms } from "../lib/agreementDocument";
import { DEFAULT_INSURANCE } from "../lib/agreementTerms";
import { computeCompliance, maskedTin, todayIso, W9_ENTITY_LABEL, type ComplianceResult, type InsuranceRequirements } from "../lib/complianceRules";
import { liveVendor } from "../lib/vendorRead";
import { CACHEABLE_STATUSES, STATUS_LABEL, type CslbStatus } from "../kernel/cslb";
import { DOCUMENT_DOWNLOAD_PREFIX } from "../documents/kinds";

/**
 * Database side of compliance (architecture §17): which vendor a sub company is on a project, which
 * agreement's insurance terms apply, and the computed state of a vendor on a project. Read-only
 * helpers; callers authorize first.
 */

/** Most compliance records one vendor can hold on one project; reads take at most this many. */
export const ITEMS_PER_VENDOR_LIMIT = 200;

/** The GC's vendor record for a sub company on a project: the project member row's vendor, else the directory link. */
export async function subVendorOnProject(
  ctx: QueryCtx,
  project: Doc<"projects">,
  subCompanyId: Id<"companies">,
): Promise<Doc<"vendors"> | null> {
  const gcCompanyId = project.gcCompanyId;
  if (gcCompanyId === undefined) return null;
  const member = await ctx.db
    .query("projectMembers")
    .withIndex("by_project_company_and_status", (q) =>
      q.eq("projectId", project._id).eq("companyId", subCompanyId).eq("status", "active"),
    )
    .first();
  if (member?.vendorId !== undefined) {
    const vendor = await liveVendor(ctx, member.vendorId);
    if (vendor !== null && vendor.companyId === gcCompanyId) return vendor;
  }
  const linked = await ctx.db
    .query("vendors")
    .withIndex("by_companyId_and_linkedCompanyId", (q) => q.eq("companyId", gcCompanyId).eq("linkedCompanyId", subCompanyId))
    .take(10);
  return linked.find((v) => v.status !== "merged") ?? null;
}

/** The vendor's subcontract on the project: the executed one if any, else the newest open draft. */
export async function agreementForVendor(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  vendor: Doc<"vendors">,
): Promise<Doc<"agreements"> | null> {
  const agreements = await ctx.db
    .query("agreements")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(500);
  const mine: Doc<"agreements">[] = [];
  for (const a of agreements) {
    if (a.status === "superseded") continue;
    const contractor = await ctx.db.get(a.contractorId);
    if (contractor === null) continue;
    const vendorMatch = contractor.vendorId !== undefined && (contractor.vendorId === vendor._id || (await liveVendor(ctx, contractor.vendorId))?._id === vendor._id);
    const companyMatch = vendor.linkedCompanyId !== undefined && contractor.linkedCompanyId === vendor.linkedCompanyId;
    if (vendorMatch || companyMatch) mine.push(a);
  }
  mine.sort((a, b) => Number(b.status === "executed") - Number(a.status === "executed") || b.createdAt - a.createdAt);
  return mine[0] ?? null;
}

/** A bidder row of the vendor on the project, used to key CSLB lookups. */
export async function contractorForVendor(
  ctx: QueryCtx,
  project: Doc<"projects">,
  vendor: Doc<"vendors">,
): Promise<Id<"contractors"> | null> {
  const agreement = await agreementForVendor(ctx, project._id, vendor);
  if (agreement !== null) return agreement.contractorId;
  const rows = await ctx.db
    .query("contractors")
    .withIndex("by_vendorId", (q) => q.eq("vendorId", vendor._id))
    .take(100);
  for (const c of rows) {
    const pkg = await ctx.db.get(c.tradePackageId);
    if (pkg?.projectId === project._id) return c._id;
  }
  return null;
}

export type RequirementsSource = { agreementId: Id<"agreements">; agreementNumber: string } | null;

export async function requirementsFor(
  ctx: QueryCtx,
  project: Doc<"projects">,
  vendor: Doc<"vendors">,
): Promise<{ requirements: InsuranceRequirements; source: RequirementsSource; agreement: Doc<"agreements"> | null }> {
  const agreement = await agreementForVendor(ctx, project._id, vendor);
  if (agreement === null) return { requirements: { ...DEFAULT_INSURANCE }, source: null, agreement: null };
  return {
    requirements: resolveAgreementTerms(agreement, project).insurance,
    source: { agreementId: agreement._id, agreementNumber: agreement.agreementNumber },
    agreement,
  };
}

/** Every compliance record of a vendor on a project, newest first. */
export async function itemsFor(ctx: QueryCtx, projectId: Id<"projects">, vendorId: Id<"vendors">): Promise<Doc<"complianceItems">[]> {
  return await ctx.db
    .query("complianceItems")
    .withIndex("by_projectId_and_vendorId", (q) => q.eq("projectId", projectId).eq("vendorId", vendorId))
    .order("desc")
    .take(ITEMS_PER_VENDOR_LIMIT);
}

export type VendorCompliance = {
  result: ComplianceResult<Doc<"complianceItems">>;
  requirements: InsuranceRequirements;
  source: RequirementsSource;
  items: Doc<"complianceItems">[];
};

export async function vendorCompliance(
  ctx: QueryCtx,
  project: Doc<"projects">,
  vendor: Doc<"vendors">,
  now: number = Date.now(),
): Promise<VendorCompliance> {
  const items = await itemsFor(ctx, project._id, vendor._id);
  const { requirements, source } = await requirementsFor(ctx, project, vendor);
  return { result: computeCompliance(items, requirements, todayIso(now)), requirements, source, items };
}

/** Computed compliance of an agreement's vendor on its project; null when the vendor cannot be resolved. */
export async function complianceForAgreement(ctx: QueryCtx, agreement: Doc<"agreements">, now: number = Date.now()): Promise<VendorCompliance | null> {
  const project = await ctx.db.get(agreement.projectId);
  const contractor = await ctx.db.get(agreement.contractorId);
  if (project === null || contractor === null) return null;
  let vendor = contractor.vendorId === undefined ? null : await liveVendor(ctx, contractor.vendorId);
  if (vendor === null && contractor.linkedCompanyId !== undefined) vendor = await subVendorOnProject(ctx, project, contractor.linkedCompanyId);
  if (vendor === null) return null;
  return await vendorCompliance(ctx, project, vendor, now);
}

export const CSLB_SOURCE = "California CSLB";

/** Client view of one record. Never a storage id or URL: files are fetched from the authenticated route. */
export async function itemView(ctx: QueryCtx, item: Doc<"complianceItems">) {
  const doc = item.documentId === undefined ? null : await ctx.db.get(item.documentId);
  let cslb: null | {
    status: CslbStatus;
    statusLabel: string;
    phase: "running" | "done";
    checkedAt: number;
    source: string;
    succeeded: boolean;
    summary: string;
  } = null;
  if (item.cslbCheckId !== undefined) {
    const check = await ctx.db.get(item.cslbCheckId);
    if (check !== null) {
      const status = check.status as CslbStatus;
      const phase = check.phase === "running" ? "running" : "done";
      cslb = {
        status,
        statusLabel: STATUS_LABEL[status],
        phase,
        checkedAt: check.checkedAt,
        source: CSLB_SOURCE,
        succeeded: phase === "done" && CACHEABLE_STATUSES.has(status),
        summary: check.rawSummary.slice(0, 600),
      };
    }
  }
  return {
    _id: item._id,
    kind: item.kind,
    status: item.status,
    createdAt: item.createdAt,
    uploadedByName: item.uploadedByName,
    reviewedByName: item.reviewedByName ?? null,
    reviewedAt: item.reviewedAt ?? null,
    rejectionReason: item.rejectionReason ?? null,
    demoRecord: item.demoRecord === true,
    coi: item.coi ?? null,
    w9: item.w9 ? { entityType: item.w9.entityType, entityLabel: W9_ENTITY_LABEL[item.w9.entityType], tinMasked: maskedTin(item.w9.tinLast4), signedDate: item.w9.signedDate } : null,
    license: item.license ?? null,
    cslb,
    document:
      doc === null
        ? null
        : {
            _id: doc._id,
            fileName: doc.fileName,
            contentType: doc.contentType,
            sizeBytes: doc.sizeBytes,
            downloadPath: `${DOCUMENT_DOWNLOAD_PREFIX}${encodeURIComponent(doc._id)}`,
          },
  };
}
export type ComplianceItemView = Awaited<ReturnType<typeof itemView>>;

export function summaryView(vc: VendorCompliance) {
  const r = vc.result;
  return {
    status: r.status,
    byKind: r.byKind,
    reasons: r.reasons,
    currentIds: { coi: r.current.coi?._id ?? null, w9: r.current.w9?._id ?? null, license: r.current.license?._id ?? null },
    requirements: vc.requirements,
    requirementsSource: vc.source,
    pendingCount: vc.items.filter((i) => i.status === "pending_review").length,
  };
}
