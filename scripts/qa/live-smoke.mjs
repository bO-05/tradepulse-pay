// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
import { ConvexHttpClient } from "convex/browser";
import { BACKEND_URL } from "./lib.mjs";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Judge-runnable live smoke test for the guarantees fixed in remediation pass 2.
 * Self-provisioning and self-cleaning: creates one AUDIT-QA-SMOKE-* project,
 * asserts the durability/immutability/credit guarantees against the deployed
 * backend, then deletes everything it created.
 *
 * Usage:
 *   node scripts/qa/live-smoke.mjs
 *   QA_BACKEND_URL=http://127.0.0.1:3210 node scripts/qa/live-smoke.mjs   # local convex dev
 *
 * Exit code 0 = all checks passed, 1 = at least one failed.
 */

const http = new ConvexHttpClient(BACKEND_URL);
const stamp = Date.now().toString().slice(-6);
const FIXTURE = `AUDIT-QA-SMOKE-${stamp}`;
const results = [];
let projectId = null;

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? null });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    const message = errorMessage(err);
    results.push({ name, ok: false, detail: message });
    console.error(`FAIL  ${name} — ${message}`);
  }
}

/** Convex HTTP clients put ConvexError payloads on `err.data`; plain server
 *  errors are masked in `err.message` as "[Request ID] Server Error". Read the
 *  same field the app's getErrorMessage() reads so assertions test the real text. */
function errorMessage(err) {
  if (err && err.data !== undefined) {
    if (typeof err.data === "string" && err.data.trim()) return err.data.trim();
    if (err.data && typeof err.data === "object") {
      if (typeof err.data.message === "string" && err.data.message.trim()) return err.data.message.trim();
      if (typeof err.data.error === "string" && err.data.error.trim()) return err.data.error.trim();
      try {
        const json = JSON.stringify(err.data);
        if (json && json !== "{}") return json;
      } catch {
        // fall through
      }
    }
  }
  return err && err.message ? err.message : String(err);
}

async function expectThrow(label, fn, pattern) {
  try {
    await fn();
  } catch (err) {
    const message = errorMessage(err);
    if (pattern && !pattern.test(message)) throw new Error(`${label}: refused with unexpected message "${message}"`);
    return message;
  }
  throw new Error(`${label}: expected refusal but the call succeeded`);
}

function deadlineInDays(days) {
  const d = new Date(Date.now() + days * 86400_000);
  return d.toISOString().slice(0, 10);
}

const estimate = (bid) => (Array.isArray(bid.lineItems) ? bid.lineItems.length : 0);

try {
  console.log(`Backend: ${BACKEND_URL}`);
  console.log(`Fixture: ${FIXTURE}\n`);

  projectId = await http.mutation("projects:createProject", {
    title: FIXTURE,
    location: "Austin, TX",
    projectType: "Class-A Commercial Mixed-Use",
    estBudget: 2_400_000,
    targetCompletionWeeks: 52,
    specDocumentText: "QA smoke fixture. Division 26 and 23 MEP scopes.",
    isDemoProject: false,
  });

  const elecId = await http.mutation("tradePackages:createTradePackage", {
    projectId,
    csiDivision: "26 00 00",
    tradeName: "QA Smoke Electrical",
    budgetEstimate: 1_250_000,
    scopeSummary: "Switchgear, distribution, and branch power.",
    mandatoryInclusions: ["Crane hoisting", "Seismic bracing"],
    bidDeadline: deadlineInDays(30),
  });
  const hvacId = await http.mutation("tradePackages:createTradePackage", {
    projectId,
    csiDivision: "23 00 00",
    tradeName: "QA Smoke HVAC",
    budgetEstimate: 1_100_000,
    scopeSummary: "Rooftop units and hydronic piping.",
    mandatoryInclusions: ["Crane pick"],
    bidDeadline: deadlineInDays(30),
  });

  const elecContractor = await http.mutation("contractors:createContractor", {
    tradePackageId: elecId,
    companyName: "QA Smoke Electric LLC",
    contactEmail: `qa-smoke-elec-${stamp}@smoke.test`,
    licenseNumber: "QA-SMOKE-01",
    licenseStatus: "Active / Verified",
    sourceUrl: "https://smoke.test/electric",
    rfqStatus: "invited",
  });
  const hvacContractor = await http.mutation("contractors:createContractor", {
    tradePackageId: hvacId,
    companyName: "QA Smoke Mechanical LLC",
    contactEmail: `qa-smoke-hvac-${stamp}@smoke.test`,
    licenseNumber: "QA-SMOKE-02",
    licenseStatus: "Active / Verified",
    sourceUrl: "https://smoke.test/mechanical",
    rfqStatus: "invited",
  });

  const elecBid = await http.mutation("bids:submitDirectBid", {
    tradePackageId: elecId,
    contractorId: elecContractor,
    subcontractorName: "QA Smoke Electric LLC",
    baseBidAmount: 1_150_000,
  });
  const hvacBid = await http.mutation("bids:submitDirectBid", {
    tradePackageId: hvacId,
    contractorId: hvacContractor,
    subcontractorName: "QA Smoke Mechanical LLC",
    baseBidAmount: 1_050_000,
  });

  await check("F1: RFI row is persisted before analysis (question preserved)", async () => {
    const question = "Smoke: does the base scope include crane hoisting for the main switchgear?";
    const res = await http.mutation("simulation:submitCustomRfi", {
      tradePackageId: elecId,
      subject: "QA smoke RFI",
      question,
    });
    if (!res || !res.conversationId) throw new Error("submitCustomRfi did not return a conversationId");
    for (let i = 0; i < 20; i++) {
      const convos = await http.query("rfq:listConversations", { tradePackageId: elecId });
      const row = convos.find((c) => c._id === res.conversationId);
      if (row) {
        if (!row.inboundQuestion.includes("crane hoisting")) throw new Error("question text was not preserved");
        return `row persisted (status=${row.status})`;
      }
      await delay(1000);
    }
    throw new Error("row was not persisted within 20s");
  });

  await check("Cross-trade: evidence gate refuses unknown clash ids", async () => {
    const msg = await expectThrow(
      "unknown clash",
      () =>
        http.mutation("coordination:deductDoubleBuyCredit", {
          projectId,
          clashId: "clash-not-real",
          tradePackageId: hvacId,
          deductAmount: 12_000,
          description: "smoke unknown clash",
          bidId: hvacBid.bidId,
        }),
      /Unknown clash id/i
    );
    return msg.slice(0, 80);
  });

  await check("Cross-trade: credit applies once and duplicates are refused", async () => {
    const before = await http.query("bids:listByPackage", { tradePackageId: hvacId });
    const beforeCost = before.find((b) => b._id === hvacBid.bidId).leveledTotalCost;
    await http.mutation("coordination:deductDoubleBuyCredit", {
      projectId,
      clashId: "clash-vfd-01",
      tradePackageId: hvacId,
      deductAmount: 12_000,
      description: "VFD double buy",
      bidId: hvacBid.bidId,
    });
    const after = await http.query("bids:listByPackage", { tradePackageId: hvacId });
    const afterCost = after.find((b) => b._id === hvacBid.bidId).leveledTotalCost;
    if (afterCost !== beforeCost - 12_000) throw new Error(`leveled ${beforeCost} -> ${afterCost}, expected -12000`);
    await expectThrow(
      "duplicate credit",
      () =>
        http.mutation("coordination:deductDoubleBuyCredit", {
          projectId,
          clashId: "clash-vfd-01",
          tradePackageId: hvacId,
          deductAmount: 12_000,
          description: "VFD double buy again",
          bidId: hvacBid.bidId,
        }),
      /already been applied/i
    );
    return "$12,000 applied once; duplicate refused";
  });

  await check("Cross-trade: reversal restores the exact leveled cost", async () => {
    const reversed = await http.mutation("coordination:reverseDoubleBuyCredit", {
      projectId,
      clashId: "clash-vfd-01",
      tradePackageId: hvacId,
    });
    if (!reversed || reversed.success !== true) throw new Error("reverse did not succeed");
    const bids = await http.query("bids:listByPackage", { tradePackageId: hvacId });
    const cost = bids.find((b) => b._id === hvacBid.bidId).leveledTotalCost;
    if (cost !== 1_050_000) throw new Error(`leveled cost ${cost}, expected 1050000`);
    return `restored to $${cost.toLocaleString()}`;
  });

  let agreementId = null;
  await check("Executed subcontracts are immutable (revision/award/delete refused)", async () => {
    const agreement = await http.mutation("agreements:generateAgreement", {
      bidId: hvacBid.bidId,
      tradePackageId: hvacId,
    });
    agreementId = agreement._id;
    await http.mutation("agreements:executeAgreement", { agreementId });

    // Revising the awarded bid must be refused.
    await expectThrow(
      "revise executed bid",
      () =>
        http.mutation("bids:submitDirectBid", {
          tradePackageId: hvacId,
          contractorId: hvacContractor,
          subcontractorName: "QA Smoke Mechanical LLC",
          baseBidAmount: 1_020_000,
        }),
      /immutable/i
    );

    // Awarding another bid must be refused.
    const secondContractor = await http.mutation("contractors:createContractor", {
      tradePackageId: hvacId,
      companyName: "QA Smoke Challenger LLC",
      contactEmail: `qa-smoke-challenger-${stamp}@smoke.test`,
      licenseNumber: "QA-SMOKE-03",
      licenseStatus: "Active / Verified",
      sourceUrl: "https://smoke.test/challenger",
      rfqStatus: "invited",
    });
    const second = await http.mutation("bids:submitDirectBid", {
      tradePackageId: hvacId,
      contractorId: secondContractor,
      subcontractorName: "QA Smoke Challenger LLC",
      baseBidAmount: 1_030_000,
    });
    await expectThrow(
      "award other bid",
      () => http.mutation("agreements:generateAgreement", { bidId: second.bidId, tradePackageId: hvacId }),
      /executed subcontract/i
    );
    await expectThrow(
      "delete contractor",
      () => http.mutation("contractors:deleteContractor", { contractorId: hvacContractor }),
      /executed subcontract/i
    );
    return "revision, award-other, and contractor delete were refused";
  });

  await check("Void execution record reopens the package (audited escape hatch)", async () => {
    const res = await http.mutation("agreements:voidExecutedAgreement", {
      agreementId,
      reason: "QA smoke test cleanup; external amendment not applicable.",
    });
    if (!res || res.success !== true) throw new Error("void did not succeed");
    const agreements = await http.query("agreements:listAgreements", { projectId });
    const agreement = agreements.find((a) => a._id === agreementId);
    if (!agreement || agreement.status !== "superseded") throw new Error("agreement not superseded");
    return "agreement superseded; project deletable";
  });

  await check("Fixture cleanup", async () => {
    const del = await http.mutation("projects:deleteProject", { projectId });
    if (!del || del.success !== true) throw new Error("deleteProject did not succeed");
    const projects = await http.query("projects:listProjects", {});
    if (projects.some((p) => p._id === projectId)) throw new Error("fixture still listed after delete");
    projectId = null;
    return "fixture deleted";
  });
} catch (err) {
  console.error(`\nABORTED: ${err && err.message ? err.message : err}`);
  results.push({ name: "aborted", ok: false, detail: String(err && err.message ? err.message : err) });
} finally {
  if (projectId) {
    try {
      await http.mutation("projects:deleteProject", { projectId });
      console.log("cleanup: fixture deleted after abort");
    } catch (cleanupErr) {
      console.error(`cleanup: could not delete fixture ${projectId}: ${cleanupErr.message}`);
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);