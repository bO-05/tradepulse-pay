import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { complianceForAgreement, subVendorOnProject } from "../compliance/status";
import { liveVendor } from "./vendorRead";

/**
 * Test-only: accepted COI, W-9 and license records for an agreement's vendor so the compliance
 * payment hold passes. Links a vendor record to the contractor first when it has none. Returns the
 * vendor and the inserted record ids.
 */
export async function seedCompliantAgreement(
  ctx: MutationCtx,
  agreementId: Id<"agreements">,
  opts: { coiExpiryDate?: string; licenseExpiryDate?: string } = {},
): Promise<{ vendorId: Id<"vendors">; coiId: Id<"complianceItems">; w9Id: Id<"complianceItems">; licenseId: Id<"complianceItems"> }> {
  const agreement = (await ctx.db.get(agreementId))!;
  const project = (await ctx.db.get(agreement.projectId))!;
  const contractor = (await ctx.db.get(agreement.contractorId))!;
  const gcCompanyId = project.gcCompanyId!;
  let vendor = contractor.vendorId === undefined ? null : await liveVendor(ctx, contractor.vendorId);
  if (vendor === null && contractor.linkedCompanyId !== undefined) vendor = await subVendorOnProject(ctx, project, contractor.linkedCompanyId);
  let subCompanyId = vendor?.linkedCompanyId ?? contractor.linkedCompanyId;
  if (subCompanyId === undefined) {
    subCompanyId = await ctx.db.insert("companies", { name: contractor.companyName, kind: "sub", isDemo: false, createdAt: Date.now() });
    await ctx.db.patch(contractor._id, { linkedCompanyId: subCompanyId });
  }
  if (vendor === null) {
    const vendorId = await ctx.db.insert("vendors", {
      companyId: gcCompanyId,
      name: contractor.companyName,
      trades: [],
      contactName: contractor.companyName,
      email: "compliance-fixture@vendor.test",
      linkedCompanyId: subCompanyId,
      status: "active",
      createdAt: Date.now(),
    });
    await ctx.db.patch(contractor._id, { vendorId });
    vendor = (await ctx.db.get(vendorId))!;
  }
  const now = Date.now();
  const base = {
    projectId: project._id,
    vendorId: vendor._id,
    companyId: subCompanyId,
    gcCompanyId,
    status: "accepted" as const,
    uploadedByName: "Compliance fixture",
    reviewedByName: "Compliance fixture",
    reviewedAt: now,
    createdAt: now,
  };
  const coiId = await ctx.db.insert("complianceItems", {
    ...base,
    kind: "coi",
    coi: {
      insurer: "Fixture Mutual",
      glPolicyNumber: "GL-FIXTURE",
      glEachOccurrenceCents: 1_000_000_000,
      glAggregateCents: 2_000_000_000,
      autoCents: 1_000_000_000,
      umbrellaCents: 5_000_000_000,
      workersComp: true,
      additionalInsured: true,
      effectiveDate: "2020-01-01",
      expiryDate: opts.coiExpiryDate ?? "2099-12-31",
    },
  });
  const w9Id = await ctx.db.insert("complianceItems", { ...base, kind: "w9", w9: { entityType: "c_corporation", tinLast4: "1234", signedDate: "2020-01-15" } });
  const licenseId = await ctx.db.insert("complianceItems", {
    ...base,
    kind: "license",
    license: { licenseNumber: "FIXTURE-1", state: "TX", classification: "Fixture", expiryDate: opts.licenseExpiryDate ?? "2099-12-31", verification: "manual" },
  });
  if ((await complianceForAgreement(ctx, agreement, now)) === null) throw new Error("compliance fixture: vendor not resolvable");
  return { vendorId: vendor._id, coiId, w9Id, licenseId };
}
