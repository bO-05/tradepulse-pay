import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { DemoCompanyIds, DemoCompanyKey } from "../lib/demoTenancy";
import type { ComplianceKind } from "./validators";
import { contractorForVendor, itemsFor, requirementsFor, subVendorOnProject } from "./status";

const DEMO_SUBS: DemoCompanyKey[] = ["sub:rosendin", "sub:tdindustries", "sub:clarke-kent"];
const DEMO_REVIEWER = "Demo GC (seed)";
const DEMO_COI_INSURER = "Demo Mutual Insurance Co. (demo)";
const GENEROUS_LIMITS = {
  glEachOccurrenceCents: 200_000_000,
  glAggregateCents: 400_000_000,
  autoCents: 200_000_000,
  umbrellaCents: 1_000_000_000,
};

export type DemoComplianceCounts = { itemsCreated: number };

/**
 * Accepted demo compliance records (COI, W-9, license) for each Demo sub company on each Demo GC
 * project it works on, so the Phase-1 demo payouts stay compliant. Records carry `demoRecord: true`
 * and no file. The license record uses the bidder's license number on file; its CSLB lookup stays
 * advisory (a `1000000` result shows the expired flag but is not a hold). Only Demo companies (by id)
 * are touched; existing records are never changed or removed. Idempotent.
 */
export async function ensureDemoCompliance(ctx: MutationCtx, ids: DemoCompanyIds, demoGcUserId: Id<"users"> | null): Promise<DemoComplianceCounts> {
  const counts: DemoComplianceCounts = { itemsCreated: 0 };
  for (const key of DEMO_SUBS) {
    const sub = await ctx.db.get(ids[key]);
    if (sub === null || !sub.isDemo) continue;
    const memberships = await ctx.db
      .query("projectMembers")
      .withIndex("by_companyId", (q) => q.eq("companyId", sub._id))
      .take(200);
    for (const m of memberships) {
      if (m.status !== "active" || m.partyRole !== "sub") continue;
      const project = await ctx.db.get(m.projectId);
      if (project === null || project.gcCompanyId !== ids.gc) continue;
      const vendor = await subVendorOnProject(ctx, project, sub._id);
      if (vendor === null) continue;
      const existing = await itemsFor(ctx, project._id, vendor._id);
      const has = (kind: ComplianceKind) => existing.some((i) => i.kind === kind && (i.status === "accepted" || i.demoRecord === true));
      const { requirements } = await requirementsFor(ctx, project, vendor);
      const now = Date.now();
      const base = {
        projectId: project._id,
        vendorId: vendor._id,
        companyId: sub._id,
        gcCompanyId: ids.gc,
        status: "accepted" as const,
        uploadedByName: `${sub.name} (seed)`,
        reviewedByName: DEMO_REVIEWER,
        ...(demoGcUserId !== null ? { reviewedByUserId: demoGcUserId } : {}),
        reviewedAt: now,
        demoRecord: true,
        createdAt: now,
      };
      if (!has("coi")) {
        await ctx.db.insert("complianceItems", {
          ...base,
          kind: "coi",
          coi: {
            insurer: DEMO_COI_INSURER,
            glPolicyNumber: "DEMO-GL-0001",
            glEachOccurrenceCents: Math.max(GENEROUS_LIMITS.glEachOccurrenceCents, requirements.glEachOccurrenceCents),
            glAggregateCents: Math.max(GENEROUS_LIMITS.glAggregateCents, requirements.glAggregateCents),
            autoCents: Math.max(GENEROUS_LIMITS.autoCents, requirements.autoCents),
            umbrellaCents: Math.max(GENEROUS_LIMITS.umbrellaCents, requirements.umbrellaCents),
            workersComp: true,
            additionalInsured: true,
            effectiveDate: "2026-01-01",
            expiryDate: "2027-12-31",
          },
        });
        counts.itemsCreated++;
      }
      if (!has("w9")) {
        await ctx.db.insert("complianceItems", { ...base, kind: "w9", w9: { entityType: "c_corporation", tinLast4: "0000", signedDate: "2026-01-15" } });
        counts.itemsCreated++;
      }
      if (!has("license")) {
        const contractorId = await contractorForVendor(ctx, project, vendor);
        const contractor = contractorId === null ? null : await ctx.db.get(contractorId);
        const number = contractor?.licenseNumber?.trim();
        const cslbNumber = number !== undefined && /^\d{3,8}$/.test(number) ? number : null;
        await ctx.db.insert("complianceItems", {
          ...base,
          kind: "license",
          license: {
            licenseNumber: cslbNumber ?? "DEMO-LICENSE",
            state: cslbNumber !== null ? "CA" : "TX",
            classification: "Demo classification",
            expiryDate: "2028-06-30",
            verification: cslbNumber !== null ? "unverified" : "manual",
          },
        });
        counts.itemsCreated++;
      }
    }
  }
  if (counts.itemsCreated > 0) {
    await ctx.db.insert("auditLogs", {
      eventType: "compliance_seeded",
      title: "Demo compliance records seeded",
      description: `The demo seed added ${counts.itemsCreated} accepted demo compliance record(s) (no files) for the Demo sub companies.`,
      actor: "system:demo-seed",
      ...(demoGcUserId !== null ? { actorUserId: demoGcUserId } : {}),
      actorCompanyId: ids.gc,
      timestamp: Date.now(),
    });
  }
  return counts;
}
