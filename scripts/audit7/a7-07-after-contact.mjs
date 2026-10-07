// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
/**
 * A7-07: AFTER-fix live verification for the A6-35 contact-integrity path (client
 * pre-creation + stated-amount pricing) and a second A6-27 discovery run.
 */
import { delay, openApp, q, call, clickTab, selectProject, selectRibbonPackage, clickText, makePackage, poll, writeEvidence, PREFIX, DAILY } from "./lib.mjs";

const TITLE = `${PREFIX}AFTER-${DAILY}`;
const out = { startedAt: new Date().toISOString() };

const proj = ((await q("projects:listProjects", {})) || []).find((p) => p.title === TITLE);
if (!proj) throw new Error("after fixture missing");

const { browser, page } = await openApp(1440, 900);
try {
  await selectProject(page, proj._id);
  await clickTab(page, "01:");
  await delay(900);
  await makePackage(page, "07 54 00", "AUDIT7 After Div 07 Roofing", 350000, "Division 07 roofing scope.");
  const pkgs = await q("tradePackages:listByProject", { projectId: proj._id });
  const p07 = pkgs.find((p) => p.csiDivision.startsWith("07"));
  await clickTab(page, "01:");
  await delay(700);
  await page.evaluate((name) => {
    const h = [...document.querySelectorAll("h3")].find((x) => x.textContent.trim() === name);
    h?.click();
  }, p07.tradeName);
  await clickTab(page, "04:");
  await delay(900);
  await clickText(page, "Ingest Quote / PDF");
  await delay(800);
  await page.evaluate(() => {
    const input = document.getElementById("ingest-new-contractor-name");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, "Willamette Mechanical Systems Inc.");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const quote = [
    "PROPOSAL AND QUOTATION",
    "Subcontractor: Willamette Mechanical Systems Inc.",
    `Project: ${TITLE}`,
    "Base Bid Price: $837,450.00",
    "Scope: Division 07 roofing scope.",
    "Exclusions: crane rigging and hoisting excluded ($18,600); firestopping excluded ($9,950); seismic bracing excluded ($7,400).",
    "Schedule: equipment procurement lead time is 17 weeks from notice to proceed; the project target is 12 weeks.",
    "Insurance: umbrella liability endorsement excluded.",
  ].join("\n");
  const taBox = await page.evaluate(() => {
    const ta = document.getElementById("ingest-quote-text");
    ta.scrollIntoView({ block: "center" });
    const r = ta.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(taBox.x, taBox.y);
  await page.keyboard.type(quote, { delay: 0.3 });
  await clickText(page, "Extract & Level Bid");
  const bids07 = await poll(() => q("bids:listByPackage", { tradePackageId: p07._id }), (x) => (x || []).length > 0, 120000, 2500);
  const ctrs07 = (await q("contractors:listByPackage", { tradePackageId: p07._id })) || [];
  out.quoteCreatedContractor = ctrs07.map((c) => ({ name: c.companyName, email: c.contactEmail, licenseNumber: c.licenseNumber, licenseStatus: c.licenseStatus, sourceUrl: c.sourceUrl }));
  const bid = (bids07 || [])[0];
  out.bid07 = bid
    ? {
        base: bid.baseBidAmount,
        exclusions: (bid.identifiedExclusions || []).map((e) => e.costImpact),
        exclusionSum: (bid.identifiedExclusions || []).reduce((s, e) => s + e.costImpact, 0),
        weeks: bid.longLeadEquipmentWeeks,
        target: bid.leadTimeTargetWeeks,
        lead: bid.leadTimePenalty,
        coi: bid.coiPenalty,
        leveled: bid.leveledTotalCost,
        expectedLeveled: 837450 + 35950 + 30000 + 15000,
      }
    : null;

  // Award via UI and inspect the draft contact/license lines
  if (bid) {
    await clickTab(page, "04:");
    await delay(900);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("Award Compliant Winner"));
      b?.click();
    });
    const agrs = await poll(() => q("agreements:listAgreements", { projectId: proj._id }), (x) => (x || []).some((a) => String(a.csiDivision).startsWith("07")), 60000, 2000);
    const agr = (agrs || []).find((a) => String(a.csiDivision).startsWith("07"));
    out.agreement07 = agr ? { number: agr.agreementNumber, sub: agr.subcontractorName, email: agr.subcontractorEmail, sum: agr.contractSum } : null;
    if (agr?.contractText) {
      out.contactLine = String(agr.contractText).split(/\r?\n/).find((l) => /^\s*Contact:/.test(l)) || null;
      out.licenseLine = String(agr.contractText).split(/\r?\n/).find((l) => /^\s*License No:/.test(l)) || null;
    }
  }

  // A6-27 re-run: same Div 26 discovery query; junk sources must not become records
  const p26 = pkgs.find((p) => p.csiDivision.startsWith("26"));
  await clickTab(page, "Discovery");
  await delay(1200);
  await selectRibbonPackage(page, p26.tradeName);
  const beforeCtrs = (await q("contractors:listByPackage", { tradePackageId: p26._id })) || [];
  await clickText(page, "Discover Trade Contractors");
  let afterCtrs = beforeCtrs;
  for (let i = 0; i < 30; i++) {
    await delay(3000);
    afterCtrs = (await q("contractors:listByPackage", { tradePackageId: p26._id })) || [];
    if (afterCtrs.length > beforeCtrs.length) break;
    const t = await page.evaluate(() => document.body.innerText);
    if (/Discovery failed|no usable/i.test(t)) break;
  }
  out.discoveryBefore = beforeCtrs.map((c) => c.companyName);
  out.discoveryAfter = afterCtrs.map((c) => ({ companyName: c.companyName, sourceUrl: c.sourceUrl, licenseStatus: c.licenseStatus }));
  const logs = (await q("auditLogs:listRecentLogs", { projectId: proj._id, limit: 60 })) || [];
  out.discoveryLog = logs.find((l) => /Discovery returned no usable|Contractors Discovered/i.test(l.title));
  out.discoveryLog = out.discoveryLog ? { title: out.discoveryLog.title, description: out.discoveryLog.description } : null;
} catch (err) {
  out.error = String(err?.stack ?? err);
  console.error(err);
} finally {
  await browser.close();
}
await writeEvidence("fix6-a7-07-after.json", out);
console.log(JSON.stringify({ quoteCreatedContractor: out.quoteCreatedContractor, bid07: out.bid07, agreement07: out.agreement07, contactLine: out.contactLine, licenseLine: out.licenseLine, discoveryAfter: out.discoveryAfter, discoveryLog: out.discoveryLog }, null, 2));