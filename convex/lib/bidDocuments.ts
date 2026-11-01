import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { contractorCanBidOnPackage } from "./packageContractors";
import type { ProjectAccess } from "./tenancy";

const BIDDER_HIDDEN_FILE_TYPES = new Set(["quote_pdf", "coi_certificate"]);
const PROJECT_WIDE_BID_DOCUMENT_TYPES = new Set(["blueprint", "spec", "addendum"]);

/**
 * Whether an invited bidder may read a project file for a package: the package's own documents and
 * project-wide drawings, specs and addenda, never bidders' quotes or insurance certificates.
 */
export function isBidDocumentForPackage(file: Doc<"projectFiles">, pkg: Doc<"tradePackages">): boolean {
  if (file.projectId !== pkg.projectId || BIDDER_HIDDEN_FILE_TYPES.has(file.fileType)) return false;
  if (file.tradePackageId === pkg._id) return true;
  return file.tradePackageId === undefined && PROJECT_WIDE_BID_DOCUMENT_TYPES.has(file.fileType);
}

/** Bid documents visible to the caller's bidder record on any package of the file's project. */
export async function bidderMayDownloadFile(ctx: QueryCtx, access: ProjectAccess, file: Doc<"projectFiles">): Promise<boolean> {
  if (access.partyRole !== "sub" || access.user.actorType === "agent") return false;
  const packages = file.tradePackageId
    ? [await ctx.db.get(file.tradePackageId)]
    : await ctx.db.query("tradePackages").withIndex("by_project", (q) => q.eq("projectId", file.projectId)).take(200);
  for (const pkg of packages) {
    if (pkg === null || !isBidDocumentForPackage(file, pkg)) continue;
    for (const contractorId of access.contractorIds) {
      const contractor = await ctx.db.get(contractorId);
      if (contractor !== null && contractorCanBidOnPackage(contractor, pkg)) return true;
    }
  }
  return false;
}

