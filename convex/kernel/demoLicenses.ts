import type { MutationCtx } from "../_generated/server";
import { findDemoContractorId } from "../demoAccounts";

/**
 * Public California CSLB license numbers on the demo contractors, looked up
 * through KERNEL on 2026-10-07. Rosendin, Bergelectric and TDIndustries hold
 * these real licenses. Alterman and Prism carry demo assignments: #1000000 is a
 * public expired record for another business and #9999999 has no CSLB record.
 * The contractor's licenseStatus text never claims a result; only a check does.
 */
export const DEMO_CA_LICENSES: ReadonlyArray<{ companyName: string; licenseNumber: string; licenseStatus: string }> = [
  {
    companyName: "Rosendin Electric, Inc.",
    licenseNumber: "142881",
    licenseStatus: "CA CSLB #142881 on file (Rosendin Electric Inc, San Jose). Status comes from the CSLB license check.",
  },
  {
    companyName: "Bergelectric Corp.",
    licenseNumber: "85046",
    licenseStatus: "CA CSLB #85046 on file (Bergelectric Corp, Carlsbad). Status comes from the CSLB license check.",
  },
  {
    companyName: "TDIndustries, Inc.",
    licenseNumber: "512239",
    licenseStatus: "CA CSLB #512239 on file (TDIndustries Inc, Dallas). Status comes from the CSLB license check.",
  },
  {
    companyName: "TDIndustries, Inc. (Plumbing)",
    licenseNumber: "512239",
    licenseStatus: "CA CSLB #512239 on file (TDIndustries Inc, Dallas). Status comes from the CSLB license check.",
  },
  {
    companyName: "Alterman, Inc.",
    licenseNumber: "1000000",
    licenseStatus:
      "Demo assignment: CSLB #1000000 is a public expired record of another business (Hala Tree Service Inc), used to show an expired result.",
  },
  {
    companyName: "Prism Electric, Inc.",
    licenseNumber: "9999999",
    licenseStatus: "Demo assignment: CSLB has no license #9999999, used to show a not-found result.",
  },
];

/** Idempotent: sets the CA license numbers above on the demo project's contractors. */
export async function applyDemoLicenseNumbers(ctx: MutationCtx): Promise<number> {
  let updated = 0;
  for (const entry of DEMO_CA_LICENSES) {
    const id = await findDemoContractorId(ctx, entry.companyName);
    if (id === undefined) continue;
    const contractor = await ctx.db.get(id);
    if (contractor === null) continue;
    if (contractor.licenseNumber === entry.licenseNumber && contractor.licenseStatus === entry.licenseStatus) continue;
    await ctx.db.patch(id, { licenseNumber: entry.licenseNumber, licenseStatus: entry.licenseStatus });
    updated++;
  }
  return updated;
}
