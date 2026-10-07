// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
/**
 * A7-01b: same matrix on a Division 26 package (electrical, 12-wk baseline) to test the
 * audit's expected values: 16w -> +$24,000, 17w -> +$30,000, 20w -> +$48,000.
 * Reuses the AUDIT7-LEAD fixture project.
 */
import { delay, openApp, q, makePackage, addContractor, ingestQuote, levelingCardText, poll, writeEvidence, DAILY, PREFIX } from "./lib.mjs";

const TITLE = `${PREFIX}LEAD-${DAILY}`;

function quoteFor(n) {
  return [
    "PROPOSAL AND QUOTATION",
    "Subcontractor: AUDIT7 Lead Volt Electric",
    `Project: ${TITLE}`,
    "Base Bid Price: $500,000.00",
    "Scope: complete Division 26 electrical switchgear and distribution scope.",
    `Schedule: equipment procurement lead time is ${n} weeks from notice to proceed; the project target is 12 weeks.`,
    "Insurance: fully compliant ACORD 25 with $5M commercial umbrella.",
    "Value Engineering: none proposed.",
  ].join("\n");
}

const out = { startedAt: new Date().toISOString(), rows: [] };
const proj = ((await q("projects:listProjects", {})) || []).find((p) => p.title === TITLE);
if (!proj) throw new Error("fixture project missing");

const { browser, page } = await openApp(1440, 900);
try {
  await page.evaluate((pid) => {
    const s = document.querySelector('select[aria-label="Select Commercial Construction Project"]');
    s.value = pid;
    s.dispatchEvent(new Event("change", { bubbles: true }));
  }, proj._id);
  await delay(1600);
  await makePackage(page, "26 00 00", "AUDIT7 Div 26 Electrical", 900000, "Division 26 electrical scope: switchgear, distribution, lighting.");
  const pkgs = await poll(() => q("tradePackages:listByProject", { projectId: proj._id }), (x) => (x || []).some((p) => p.csiDivision.startsWith("26")), 30000, 1200);
  const p26 = (pkgs || []).find((p) => p.csiDivision.startsWith("26"));
  out.p26 = p26 ? { _id: p26._id, csiDivision: p26.csiDivision, tradeName: p26.tradeName } : null;
  await addContractor(page, p26.tradeName, "AUDIT7 Lead Volt Electric", "estimating@audit7-volt.invalid", "OR-AUDIT7-LV");
  const ctrs = await q("contractors:listByPackage", { tradePackageId: p26._id });
  const c1 = (ctrs || []).find((c) => /AUDIT7 Lead Volt/.test(c.companyName));
  out.contractor = c1 ? { _id: c1._id, companyName: c1.companyName } : null;

  for (const n of [16, 17, 20, 16]) {
    await ingestQuote(page, c1._id, quoteFor(n));
    const bid = await poll(
      () => q("bids:listByPackage", { tradePackageId: p26._id }).then((bs) => bs.find((b) => b.contractorId === c1._id)),
      (b) => Boolean(b) && b.longLeadEquipmentWeeks === n,
      120000,
      2500
    );
    await delay(1000);
    const card = await levelingCardText(page);
    out.rows.push({
      inputWeeks: n,
      persistedWeeks: bid?.longLeadEquipmentWeeks ?? null,
      persistedPenalty: bid?.leadTimePenalty ?? null,
      persistedLeveled: bid?.leveledTotalCost ?? null,
      expectedDiv26Rule: Math.max(0, n - 12) * 6000,
      cardText: card,
    });
    console.log(`[lead26] N=${n} -> weeks=${bid?.longLeadEquipmentWeeks} penalty=$${bid?.leadTimePenalty} expected(12wk)=$${Math.max(0, n - 12) * 6000}`);
  }
} catch (err) {
  out.error = String(err?.stack ?? err);
  console.error(err);
} finally {
  await browser.close();
}
await writeEvidence("fix6-a7-01b-leadtime-div26.json", out);