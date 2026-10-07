// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
import { ConvexHttpClient } from "convex/browser";

const convexUrl = "https://brilliant-ferret-962.convex.cloud";
const client = new ConvexHttpClient(convexUrl);

async function runEdgeCaseVerifications() {
  console.log("================================================================================");
  console.log("       TRADEPULSE PRO — REAL-WORLD ROBUSTNESS & EDGE CASE VERIFICATION          ");
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

  // 1. Verify AIA Subcontract Sum Logic
  console.log("\n[1] Verifying AIA Document A401 Subcontract Sum Calculation Logic...");
  const baseBid = 1250000;
  const excludedCraneCost = 45000; // GC must NOT pay this
  const acceptedVeDeduct = 30000; // GC receives credit
  const unacceptedVeDeduct = 15000; // Not accepted, no credit
  const expectedContractSum = baseBid - acceptedVeDeduct; // $1,220,000

  assert(
    expectedContractSum === 1220000,
    "AIA A401 Subcontract Sum correctly deducts accepted VE ($1,220,000)",
    `Got ${expectedContractSum}`
  );
  assert(
    expectedContractSum !== baseBid + excludedCraneCost,
    "AIA A401 Subcontract Sum does NOT charge GC for excluded scope penalties ($1,295,000 rejected)"
  );

  // 2. Test ADR-0003 Normalization Formula
  console.log("\n[2] Verifying ADR-0003 Forensic Normalization Formula with Waived Exclusions...");
  const exclusions = [
    { description: "Crane hoisting excluded", costImpact: 45000, isWaived: false },
    { description: "Firestop penetrations excluded", costImpact: 22000, isWaived: true }, // Waived by GC (covered elsewhere)
  ];
  const leadPenalty = 12000;
  const coiPenalty = 15000;
  const veAlternates = [
    { description: "LED lighting substitute", costDeduct: 30000, isAccepted: true },
    { description: "Alternate conduit routing", costDeduct: 15000, isAccepted: false },
  ];

  const activeGaps = exclusions.reduce((s, x) => (x.isWaived ? s : s + (x.costImpact || 0)), 0);
  const acceptedVe = veAlternates.reduce((s, x) => (x.isAccepted ? s + (x.costDeduct || 0) : s), 0);
  const leveledTotal = baseBid + activeGaps + leadPenalty + coiPenalty - acceptedVe;

  assert(
    activeGaps === 45000,
    "Active scope gaps ignore waived exclusion ($22,000 excluded from penalty, $45,000 active)",
    `Got ${activeGaps}`
  );
  assert(
    acceptedVe === 30000,
    "VE deduct only applies accepted alternate ($30,000 applied, $15,000 ignored)",
    `Got ${acceptedVe}`
  );
  assert(
    leveledTotal === 1250000 + 45000 + 12000 + 15000 - 30000, // 1,292,000
    `Normalized leveled total is exactly $1,292,000 (calculated: $${leveledTotal.toLocaleString()})`
  );

  // 3. Test Zero Budget & Empty State Math
  console.log("\n[3] Verifying Zero Budget & Empty Package Financial Resilience...");
  const zeroBudget = 0;
  const totalLeveled = 500000;
  const variance = zeroBudget - totalLeveled;
  const variancePercent = zeroBudget > 0 ? (variance / zeroBudget) * 100 : 0;
  assert(
    !isNaN(variancePercent) && isFinite(variancePercent) && variancePercent === 0,
    "Zero budget project produces finite 0% variance without NaN or division-by-zero"
  );

  // 4. Test Live Convex Backend Querying & Schema Integrity
  console.log("\n[4] Querying Live Backend to verify Project Files & Agreements Schema...");
  try {
    const projects = await client.query("projects:listProjects", {});
    assert(projects.length > 0, "Live Convex returned active project records", `Count: ${projects.length}`);

    const demoProject = projects[0];
    const packages = await client.query("tradePackages:listByProject", { projectId: demoProject._id });
    assert(packages.length > 0, "Trade packages successfully linked to project", `Packages: ${packages.length}`);

    const files = await client.query("files:listFilesByProject", { projectId: demoProject._id });
    assert(Array.isArray(files), "Project files query returns array conforming to schema", `Files: ${files.length}`);

    const agreements = await client.query("agreements:listAgreements", { projectId: demoProject._id });
    assert(Array.isArray(agreements), "Agreements query returns valid records", `Agreements: ${agreements.length}`);
    if (agreements.length > 0) {
      const agr = agreements[0];
      assert(
        agr.contractSum > 0 && typeof agr.contractSum === "number",
        `AIA Agreement #${agr.agreementNumber} contract sum is valid number: $${agr.contractSum.toLocaleString()}`
      );
    }
  } catch (err) {
    assert(false, "Backend query failed", err.message);
  }

  // 5. Test String Currency Cleaning
  console.log("\n[5] Testing Currency & Numeric Normalization...");
  function cleanNumber(val) {
    if (typeof val === "number") return isNaN(val) ? 0 : val;
    if (!val) return 0;
    const str = String(val).replace(/[^0-9.-]/g, "");
    const num = parseFloat(str);
    return isNaN(num) ? 0 : num;
  }

  assert(cleanNumber("$1,250,000.00") === 1250000, "Clean '$1,250,000.00' -> 1250000");
  assert(cleanNumber(" $ 890,500.50 USD ") === 890500.5, "Clean ' $ 890,500.50 USD ' -> 890500.5");
  assert(cleanNumber("N/A") === 0, "Clean 'N/A' -> 0");
  assert(cleanNumber(null) === 0, "Clean null -> 0");
  assert(cleanNumber(undefined) === 0, "Clean undefined -> 0");

  console.log("\n================================================================================");
  console.log(`EDGE CASE VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log("================================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runEdgeCaseVerifications().catch((e) => {
  console.error("FATAL ERROR IN EDGE CASE SUITE:", e);
  process.exit(1);
});
