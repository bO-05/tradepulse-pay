// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const client = new ConvexHttpClient("https://brainy-skunk-440.convex.cloud");

async function run() {
  const projects = await client.query(api.projects.listProjects);
  console.log("=== PROJECTS ===");
  console.log(`Found ${projects.length} projects`);
  for (const p of projects) {
    console.log(`- Project: ${p.title} (${p._id}), isDemo: ${p.isDemoProject}`);
    const pkgs = await client.query(api.tradePackages.listByProject, { projectId: p._id });
    console.log(`  Packages: ${pkgs.length}`);
    for (const pkg of pkgs) {
      console.log(`  - Package: ${pkg.csiDivision} ${pkg.tradeName} (${pkg._id})`);
      const contractors = await client.query(api.contractors.listByPackage, { tradePackageId: pkg._id });
      console.log(`    Contractors (${contractors.length}):`);
      for (const c of contractors) {
        console.log(`      * ${c.companyName} | ${c.contactEmail} | ${c.phone} | ${c.licenseNumber} | ${c.sourceUrl}`);
      }
      const bids = await client.query(api.bids.listByPackage, { tradePackageId: pkg._id });
      console.log(`    Bids (${bids.length}):`);
      for (const b of bids) {
        console.log(`      * ${b.subcontractorName} | Base: $${b.baseBidAmount} | Leveled: $${b.leveledTotalCost} | Awarded: ${b.isAwarded}`);
      }
    }
    const agreements = await client.query(api.agreements.listAgreements, { projectId: p._id });
    console.log(`  Agreements (${agreements.length}):`);
    for (const a of agreements) {
      console.log(`    * ${a.agreementNumber} | ${a.subcontractorName} | $${a.contractSum} | Status: ${a.status}`);
    }
    const files = await client.query(api.files.listFilesByProject, { projectId: p._id });
    console.log(`  Project Files (${files.length}):`);
    for (const f of files) {
      console.log(`    * ${f.fileName} (${f.fileType}) -> storageId: ${f.storageId}, url: ${f.url}`);
    }
  }
}

run().catch(console.error);
