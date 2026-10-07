// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
/**
 * A7-03: BEFORE-fix live probes for A6-34 (Record Execution Status row control),
 * A6-35 (fabricated corpus contact on quote-created contractors) and A6-14 (retainage).
 * Uses the AUDIT7-LEAD fixture: awards the Div 22 bid, then ingests a zero-contractor
 * quote for "Willamette Mechanical Systems Inc." on the Div 03 package and awards it.
 */
import { delay, openApp, q, clickTab, selectProject, selectRibbonPackage, clickText, poll, writeEvidence, DAILY, PREFIX } from "./lib.mjs";

const TITLE = `${PREFIX}LEAD-${DAILY}`;
const out = { startedAt: new Date().toISOString(), steps: [] };

const proj = ((await q("projects:listProjects", {})) || []).find((p) => p.title === TITLE);
if (!proj) throw new Error("fixture missing");
const pkgs = (await q("tradePackages:listByProject", { projectId: proj._id })) || [];
const p22 = pkgs.find((p) => p.csiDivision.startsWith("22"));
const p03 = pkgs.find((p) => p.csiDivision.startsWith("03"));

async function dialogProbe(page) {
  return page.evaluate(() => {
    const ds = [...document.querySelectorAll('[role="alertdialog"],[role="dialog"]')].filter((d) => d.getBoundingClientRect().width > 1);
    return {
      count: ds.length,
      roles: ds.map((d) => d.getAttribute("role")),
      titles: ds.map((d) => (d.querySelector("h2,h3") || {}).textContent || null),
      buttons: ds.map((d) => [...d.querySelectorAll("button")].map((b) => (b.textContent || "").trim())),
    };
  });
}

const { browser, page } = await openApp(1440, 900);
try {
  await selectProject(page, proj._id);

  // ---- Award Div 22 (existing AUDIT7 Lead Prime bid)
  await clickTab(page, "Bid Leveling");
  await delay(1500);
  await selectRibbonPackage(page, p22.tradeName);
  await delay(1200);
  let award = await clickText(page, "Award Compliant Winner");
  if (!award.ok) award = await clickText(page, "Award Subcontract");
  const dlgsAfterAward = await dialogProbe(page);
  if (dlgsAfterAward.count > 0) {
    const btn = await page.evaluate(() => {
      const ds = [...document.querySelectorAll('[role="alertdialog"],[role="dialog"]')].filter((d) => d.getBoundingClientRect().width > 1);
      const d = ds[ds.length - 1];
      const b = [...d.querySelectorAll("button")].find((x) => /Award|Draft|Generate|Confirm/i.test(x.textContent || ""));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: b.textContent.trim() };
    });
    if (btn) await page.mouse.click(btn.x, btn.y);
  }
  const agrs = await poll(() => q("agreements:listAgreements", { projectId: proj._id }), (x) => (x || []).some((a) => a.csiDivision && String(a.csiDivision).startsWith("22")), 60000, 2000);
  const agr22 = (agrs || []).find((a) => String(a.csiDivision).startsWith("22"));
  out.award22 = { awardClick: award.ok, dialogAfterAward: dlgsAfterAward, agreement: agr22 ? { _id: agr22._id, number: agr22.agreementNumber, status: agr22.status, sum: agr22.contractSum, retainage: agr22.retainagePercent, ld: agr22.liquidatedDamagesDaily, sub: agr22.subcontractorName, email: agr22.subcontractorEmail } : null };
  await page.keyboard.press("Escape");
  await delay(800);

  // ---- A6-34: Contracts register; click the ROW button (not the viewer button)
  await clickTab(page, "Subcontracts");
  await delay(1600);
  out.registerBefore = await page.evaluate(() => (document.querySelector("main") || document.body).innerText.replace(/\n+/g, " | ").slice(0, 1500));
  const rowBtn = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("table tbody tr")];
    for (const tr of rows) {
      const b = [...tr.querySelectorAll("button")].find((x) => (x.textContent || "").includes("Record Execution Status"));
      if (b) {
        b.scrollIntoView({ block: "center" });
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, rowText: tr.innerText.replace(/\n+/g, " ") };
      }
    }
    return null;
  });
  out.rowButton = rowBtn;
  if (rowBtn) {
    await page.mouse.click(rowBtn.x, rowBtn.y);
    await delay(1500);
    out.dialogAfterRowClick = await dialogProbe(page);
    out.headerAfterRowClick = await page.evaluate(() => {
      const t = (document.querySelector("main") || document.body).innerText.replace(/\n+/g, " | ");
      const m = /Execution Status Recorded[^|]*/.exec(t);
      return m ? m[0].trim() : null;
    });
    // second click for reproduction
    await page.mouse.click(rowBtn.x, rowBtn.y);
    await delay(1200);
    out.dialogAfterSecondClick = await dialogProbe(page);
    await page.keyboard.press("Escape");
    await delay(500);
  }

  // ---- A6-35: zero-contractor quote on Div 03 naming a mechanical company
  await clickTab(page, "01:");
  await delay(900);
  await page.evaluate((name) => {
    const h = [...document.querySelectorAll("h3")].find((x) => x.textContent.trim() === name);
    h?.click();
  }, p03.tradeName);
  await clickTab(page, "04:");
  await delay(1000);
  await clickText(page, "Ingest Quote / PDF");
  await delay(800);
  await page.evaluate(() => {
    const ta = document.querySelector('input[aria-label="New subcontractor company name"]');
    if (!ta) return;
    const proto = HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(ta, "Willamette Mechanical Systems Inc.");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const quote = [
    "PROPOSAL AND QUOTATION",
    "Subcontractor: Willamette Mechanical Systems Inc.",
    `Project: ${TITLE}`,
    "Base Bid Price: $837,450.00",
    "Scope: Division 03 concrete equipment pads and foundations.",
    "Exclusions: crane rigging and hoisting excluded ($18,600); firestopping excluded ($9,950); seismic bracing excluded ($7,400).",
    "Schedule: equipment procurement lead time is 17 weeks from notice to proceed; the project target is 12 weeks.",
    "Insurance: umbrella liability endorsement excluded.",
  ].join("\n");
  const taBox = await page.evaluate(() => {
    const ta = document.querySelector('textarea[aria-label="Proposal OCR text or pasted quote"]');
    if (!ta) return null;
    ta.scrollIntoView({ block: "center" });
    const r = ta.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(taBox.x, taBox.y);
  await page.keyboard.type(quote, { delay: 0.3 });
  await clickText(page, "Extract & Level Bid");
  const bids03 = await poll(() => q("bids:listByPackage", { tradePackageId: p03._id }), (x) => (x || []).length > 0, 120000, 2500);
  const ctrs03 = await q("contractors:listByPackage", { tradePackageId: p03._id });
  const bid03 = (bids03 || [])[0];
  out.ingest03 = {
    bid: bid03 ? { base: bid03.baseBidAmount, weeks: bid03.longLeadEquipmentWeeks, penalty: bid03.leadTimePenalty, coi: bid03.coiPenalty, leveled: bid03.leveledTotalCost } : null,
    contractors: (ctrs03 || []).map((c) => ({ name: c.companyName, email: c.contactEmail, sourceUrl: c.sourceUrl, licenseNumber: c.licenseNumber, licenseStatus: c.licenseStatus })),
  };

  // Award Div 03 and inspect the generated draft contact
  if (bid03) {
    await clickTab(page, "04:");
    await delay(900);
    await clickText(page, "Award Compliant Winner");
    await delay(1000);
    const dlg2 = await dialogProbe(page);
    if (dlg2.count > 0) {
      const btn = await page.evaluate(() => {
        const ds = [...document.querySelectorAll('[role="alertdialog"],[role="dialog"]')].filter((d) => d.getBoundingClientRect().width > 1);
        const d = ds[ds.length - 1];
        const b = [...d.querySelectorAll("button")].find((x) => /Award|Draft|Generate|Confirm/i.test(x.textContent || ""));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      if (btn) await page.mouse.click(btn.x, btn.y);
    }
    const agrs2 = await poll(() => q("agreements:listAgreements", { projectId: proj._id }), (x) => (x || []).some((a) => String(a.csiDivision).startsWith("03")), 60000, 2000);
    const agr03 = (agrs2 || []).find((a) => String(a.csiDivision).startsWith("03"));
    out.agreement03 = agr03 ? { number: agr03.agreementNumber, sub: agr03.subcontractorName, email: agr03.subcontractorEmail, contractText: String(agr03.contractText || "").slice(0, 5000) } : null;
    if (agr03?.contractText) {
      const lines = String(agr03.contractText).split(/\r?\n/).filter((l) => /Contact:|Subcontractor:|Email|email/i.test(l));
      out.agreement03ContactLines = lines.slice(0, 8);
    }
  }
} catch (err) {
  out.error = String(err?.stack ?? err);
  console.error(err);
} finally {
  await browser.close();
}
await writeEvidence("fix6-a7-03-award-contracts-before.json", out);
console.log(JSON.stringify({
  award22: out.award22,
  rowButton: out.rowButton && { rowText: out.rowButton.rowText },
  dialogAfterRowClick: out.dialogAfterRowClick,
  dialogAfterSecondClick: out.dialogAfterSecondClick,
  ingest03: out.ingest03,
  agreement03: out.agreement03 && { number: out.agreement03.number, sub: out.agreement03.sub, email: out.agreement03.email },
  contactLines: out.agreement03ContactLines,
}, null, 2));