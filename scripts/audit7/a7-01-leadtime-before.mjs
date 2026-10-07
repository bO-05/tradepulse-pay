// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
/**
 * A7-01: BEFORE-fix live reproduction of A6-05r / A6-54.
 * Creates AUDIT7-LEAD-<date>, a Div 22 package and one contractor through the UI,
 * then ingests five quotes through the real UI modal:
 *   N = 12, 16, 17, 20, then 17 again (determinism repeat).
 * Records the persisted longLeadEquipmentWeeks / leadTimePenalty / leveledTotalCost
 * plus the rendered leveling-card text after each ingest.
 */
import { delay, openApp, closeTour, q, call, makeFixtureProject, makePackage, addContractor,
  ingestQuote, levelingCardText, poll, writeEvidence, deleteProject, demoSnapshot, DAILY, PREFIX } from "./lib.mjs";

const TITLE = `${PREFIX}LEAD-${DAILY}`;

function quoteFor(n) {
  return [
    "PROPOSAL AND QUOTATION",
    "Subcontractor: AUDIT7 Lead Prime Mechanical",
    `Project: ${TITLE}`,
    "Base Bid Price: $500,000.00",
    "Scope: complete Division 22 domestic water booster pump system, piping and fixtures.",
    `Schedule: equipment procurement lead time is ${n} weeks from notice to proceed; the project target is 12 weeks.`,
    "Insurance: fully compliant ACORD 25 with $5M commercial umbrella.",
    "Value Engineering: none proposed.",
  ].join("\n");
}

async function main() {
  const out = { startedAt: new Date().toISOString(), title: TITLE, before: [], ui: {}, notes: [] };
  out.demoBefore = await demoSnapshot();

  for (const p of ((await q("projects:listProjects", {})) || []).filter((x) => x.title.startsWith(PREFIX))) {
    const ok = await deleteProject(p._id);
    out.notes.push(`pre-clean ${p.title}: ${ok ? "deleted" : "FAILED"}`);
  }

  const { browser, page } = await openApp(1440, 900);
  try {
    const proj = await makeFixtureProject(page, {
      title: TITLE,
      gc: "AUDIT7 Cedar Water Works Constructors JV",
      budget: 3000000,
      weeks: 52,
      spec: "Division 22 plumbing and Division 26 electrical scope for the AUDIT7 lead-time probe.",
    });
    out.project = proj.proj;
    if (!proj.proj) throw new Error("fixture project not created");

    const pkg = await makePackage(page, "22 00 00", "AUDIT7 Div 22 Plumbing", 900000, "Division 22 plumbing scope: booster pumps, domestic water, backflow.");
    out.package = pkg;
    const pkgs = await poll(() => q("tradePackages:listByProject", { projectId: proj.proj._id }), (x) => (x || []).length >= 1, 30000, 1200);
    const p22 = (pkgs || []).find((p) => p.csiDivision.startsWith("22"));
    out.p22 = p22 ? { _id: p22._id, csiDivision: p22.csiDivision, tradeName: p22.tradeName } : null;
    if (!p22) throw new Error("Div22 package not created");

    const ctr = await addContractor(page, p22.tradeName, "AUDIT7 Lead Prime Mechanical", "estimating@audit7-lead.invalid", "OR-AUDIT7-LP");
    const ctrs = await q("contractors:listByPackage", { tradePackageId: p22._id });
    const c1 = (ctrs || []).find((c) => /AUDIT7 Lead Prime/.test(c.companyName));
    out.contractor = c1 ? { _id: c1._id, companyName: c1.companyName } : { addCtr: ctr };
    if (!c1) throw new Error("contractor not created");

    for (const n of [12, 16, 17, 20, 17]) {
      const before = (await q("bids:listByPackage", { tradePackageId: p22._id })) || [];
      const open = await ingestQuote(page, c1._id, quoteFor(n));
      const bid = await poll(
        () => q("bids:listByPackage", { tradePackageId: p22._id }).then((bs) => bs.find((b) => b.contractorId === c1._id)),
        (b) => Boolean(b) && (b.longLeadEquipmentWeeks === n || (b.revisionNumber || 1) > (before[0]?.revisionNumber || 0)),
        120000,
        2500
      );
      await delay(1200);
      const card = await levelingCardText(page);
      const rec = {
        inputWeeks: n,
        open,
        persistedWeeks: bid?.longLeadEquipmentWeeks ?? null,
        persistedPenalty: bid?.leadTimePenalty ?? null,
        persistedLeveled: bid?.leveledTotalCost ?? null,
        base: bid?.baseBidAmount ?? null,
        coiPenalty: bid?.coiPenalty ?? null,
        exclusionSum: (bid?.identifiedExclusions || []).reduce((s, e) => s + (e.isWaived ? 0 : e.costImpact || 0), 0),
        veAccepted: (bid?.valueEngineeringAlternates || []).reduce((s, v) => s + (v.isAccepted ? v.costDeduct || 0 : 0), 0),
        expectedDiv22Rule: Math.max(0, n - 16) * 6000,
        expectedAuditRule: Math.max(0, n - 12) * 6000,
        cardText: card,
      };
      rec.leveledRecomputes = bid
        ? rec.base + rec.exclusionSum + rec.persistedPenalty + rec.coiPenalty - rec.veAccepted === rec.persistedLeveled
        : null;
      out.before.push(rec);
      console.log(`[lead] N=${n} -> weeks=${rec.persistedWeeks} penalty=$${rec.persistedPenalty} leveled=$${rec.persistedLeveled} expectedDiv22=$${rec.expectedDiv22Rule}`);
    }

    const finalBid = (await q("bids:listByPackage", { tradePackageId: p22._id }))?.find((b) => b.contractorId === c1._id);
    out.finalBid = finalBid
      ? {
          longLeadEquipmentWeeks: finalBid.longLeadEquipmentWeeks,
          leadTimePenalty: finalBid.leadTimePenalty,
          leadTimeTargetWeeks: finalBid.leadTimeTargetWeeks ?? null,
          leveledTotalCost: finalBid.leveledTotalCost,
          revisionNumber: finalBid.revisionNumber,
        }
      : null;
    out.uiAfter = await levelingCardText(page);
    out.fullLevelingText = (await page.evaluate(() => (document.querySelector("main") || document.body).innerText)).slice(0, 6000);
  } catch (err) {
    out.error = String(err?.stack ?? err);
    console.error("[lead] FAILED:", out.error);
  } finally {
    await browser.close();
  }

  // Leave the fixture in place for the AFTER comparison, but record its id.
  await writeEvidence("fix6-a7-01-leadtime-before.json", out);
  console.log(JSON.stringify({ projectId: out.project?._id, rows: out.before.map((r) => [r.inputWeeks, r.persistedWeeks, r.persistedPenalty]) }, null, 2));
}

main().catch(async (e) => {
  console.error(e);
  await writeEvidence("fix6-a7-01-leadtime-before.json", { fatal: String(e?.stack ?? e) });
  process.exit(1);
});