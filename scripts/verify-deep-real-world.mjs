// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
import { ConvexHttpClient } from "convex/browser";

const convexUrl = "https://brilliant-ferret-962.convex.cloud";
const client = new ConvexHttpClient(convexUrl);

async function runDeepRealWorldVerifications() {
  console.log("================================================================================");
  console.log("   TRADEPULSE PRO — DEEP REAL-WORLD COMMERCIAL SIMULATION & EDGE CASE AUDIT     ");
  console.log("================================================================================");

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = "") {
    if (condition) {
      console.log(`✓ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`✗ FAIL: ${testName} — ${details}`);
      failed++;
    }
  }

  try {
    // 1. Fetch or create a project in Denver, CO (non-Austin/non-Texas)
    console.log("\n[Test 1] Testing Non-Texas Project & Trade Package Creation...");
    const projects = await client.query("projects:listProjects");
    assert(Array.isArray(projects) && projects.length > 0, "Active projects found in database");

    // Create a temporary Denver, CO project for testing real-world multi-state logic
    const denverProjectId = await client.mutation("projects:createProject", {
      title: "Rocky Mountain Medical Center - Tower B",
      location: "Denver, CO",
      projectType: "Healthcare / Commercial Hospital",
      estBudget: 8500000,
      targetCompletionWeeks: 48,
      specDocumentText: "Denver Health Tower B Commercial Concrete & Structural Package",
      isDemoProject: false,
    });
    assert(Boolean(denverProjectId), "Created Denver, CO project record", `ID: ${denverProjectId}`);

    // Create a Division 03 Concrete trade package in Denver
    const concretePackageId = await client.mutation("tradePackages:createTradePackage", {
      projectId: denverProjectId,
      csiDivision: "03 30 00",
      tradeName: "Cast-In-Place Concrete",
      budgetEstimate: 1450000,
      scopeSummary: "Furnish and install structural concrete foundations, slabs on grade, and shear walls.",
      mandatoryInclusions: ["3,000 PSI Mix Design", "Vapor Barrier 15 mil", "Seismic reinforcement ties"],
      bidDeadline: "October 15, 2026",
    });
    assert(Boolean(concretePackageId), "Created Division 03 Concrete trade package in Denver");

    // 2. Discover subcontractors in Denver for Division 03 (Concrete)
    console.log("\n[Test 2] Testing Trade-Appropriate Contractor Discovery for Non-Texas / Division 03...");
    const discoveryResult = await client.action("contractorDiscovery:discoverSubcontractors", {
      tradePackageId: concretePackageId,
    });
    assert(discoveryResult.success === true, "Contractor discovery action succeeded");
    assert(discoveryResult.discoveredCount > 0, "Discovered trade contractors for Division 03");

    // Query discovered contractors
    const discoveredContractors = await client.query("contractors:listByPackage", {
      tradePackageId: concretePackageId,
    });
    assert(discoveredContractors.length > 0, "Contractors successfully retrieved from package");

    // Verify none of them are Austin plumbing companies!
    const firstContractor = discoveredContractors[0];
    console.log(`   Sample Contractor: "${firstContractor.companyName}" | License: "${firstContractor.licenseNumber}" | Phone: "${firstContractor.phone}"`);
    assert(
      !firstContractor.companyName.includes("Plumbing") && !firstContractor.companyName.includes("Piping"),
      "Division 03 does NOT return plumbing contractors (fixed Division fallback)",
      `Found: ${firstContractor.companyName}`
    );
    assert(
      firstContractor.licenseNumber.includes("CO") || firstContractor.phone?.includes("303"),
      "Contractor has state-appropriate licensing / area code for Denver, CO",
      `License: ${firstContractor.licenseNumber}, Phone: ${firstContractor.phone}`
    );

    // 3. Test Direct Quote Extraction WITHOUT contractorId (auto-provisioning)
    console.log("\n[Test 3] Testing Quote Extraction with Missing contractorId & Dynamic Base Bid...");
    const customQuoteText = `
PROPOSAL AND SCOPE SUBMISSION
Subcontractor: Mile High Concrete & Pumping Services LLC
Project: Rocky Mountain Medical Center
Base Bid Lump Sum: $1,420,000.00
Detailed Line Items:
- Foundation footings and grade beams: $620,000
- Slab-on-grade 6" with welded wire mesh: $480,000
- Elevated deck composite pour: $320,000
Exclusions:
- Winter cold weather heating blankets & admixtures: $35,000.00
Value Engineering:
- Alternate lightweight aggregate mix deduct: ($45,000.00)
Equipment Lead Time: 8 weeks
Insurance: Compliant ACORD 25 Certificate attached with $5M Umbrella liability.
    `;

    const extractRes = await client.action("files:extractBidFromQuoteFile", {
      projectId: denverProjectId,
      tradePackageId: concretePackageId,
      // NOTE: contractorId is deliberately omitted!
      quoteText: customQuoteText,
      fileName: "Mile_High_Concrete_Proposal.pdf",
    });

    assert(extractRes.success === true, "extractBidFromQuoteFile succeeded without explicit contractorId");
    assert(Boolean(extractRes.bidId), "Parsed bid record created in database");
    console.log(`   Extracted Subcontractor: "${extractRes.subcontractorName}" | Base Bid: $${extractRes.baseBidAmount.toLocaleString()} | Leveled: $${extractRes.leveledTotalCost.toLocaleString()}`);
    assert(
      extractRes.baseBidAmount === 1420000,
      "Extracted dynamic base bid $1,420,000 instead of hardcoded 1.1M / 1.15M fallback",
      `Got $${extractRes.baseBidAmount}`
    );

    // Check bid in DB
    const packageBids = await client.query("bids:listByPackage", { tradePackageId: concretePackageId });
    const insertedBid = packageBids.find((b) => b._id === extractRes.bidId);
    assert(Boolean(insertedBid), "Inserted bid retrieved from bids table");
    assert(
      insertedBid.coiPenalty === 0,
      "Affirmative ACORD 25 with $5M Umbrella incurs $0 COI penalty (no false positive)",
      `coiPenalty was $${insertedBid?.coiPenalty}`
    );

    // 4. Test AIA A401 Agreement Generation for Denver Project
    console.log("\n[Test 4] Testing AIA Document A401 Agreement Generation for Denver, CO...");
    const agreement = await client.mutation("agreements:generateAgreement", {
      bidId: insertedBid._id,
      tradePackageId: concretePackageId,
    });
    assert(Boolean(agreement?._id), "AIA A401 Subcontract Agreement generated");
    console.log(`   Agreement Number: ${agreement.agreementNumber} | Contract Sum: $${agreement.contractSum.toLocaleString()}`);
    assert(
      agreement.contractText.includes("Denver, CO") || agreement.contractText.includes("CO-GC-901844"),
      "Agreement reflects Denver, CO project location and CO licensing",
      agreement.contractText.slice(0, 300)
    );

    // 5. Test Cross-Trade Clash Reasoning Action (taskType clash_detection)
    console.log("\n[Test 5] Testing Cross-Trade Clash Engine...");
    const clashScan = await client.action("coordination:scanCrossTradeClashes", {
      projectId: denverProjectId,
    });
    assert(clashScan.success === true, "scanCrossTradeClashes completed with taskType clash_detection");
    assert(typeof clashScan.analysis === "string" && clashScan.analysis.length > 0, "Returned valid clash analysis");

    // Clean up temporary test project
    console.log("\n[Cleanup] Cleaning up temporary test project...");
    await client.mutation("projects:deleteProject", { projectId: denverProjectId });
    console.log("✓ Successfully cleaned up temporary project.");

  } catch (err) {
    console.error("Deep verification failed with unexpected exception:", err);
    failed++;
  }

  console.log("\n================================================================================");
  console.log(`DEEP REAL-WORLD AUDIT COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log("================================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runDeepRealWorldVerifications();
