// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
/**
 * A7-06: AFTER-fix live verification for A6-42 (Auto-Scope preview/confirm),
 * A6-27 (discovery filtering) and A6-35 (quote-created contact integrity).
 */
import { delay, openApp, q, clickTab, selectProject, selectRibbonPackage, clickText, makePackage, poll, writeEvidence, PREFIX, DAILY } from "./lib.mjs";

const TITLE = `${PREFIX}AFTER-${DAILY}`;
const out = { startedAt: new Date().toISOString() };

const AMBIGUOUS = `SECTION 22 00 00 - PLUMBING SYSTEMS
Domestic water piping, sanitary waste, and vent systems. Structural steel pipe racks and supports for
exposed piping in the mechanical yard. Black steel and galvanized pipe fabrication. Some 05 12 00
structural steel angle framing may be required for the equipment pads per the structural drawings.
Provide hangers, supports, and seismic restraints. Concrete housekeeping pads by others.`;

const proj = ((await q("projects:listProjects", {})) || []).find((p) => p.title === TITLE);
if (!proj) throw new Error("after fixture missing");

const { browser, page } = await openApp(1440, 900);
try {
  await selectProject(page, proj._id);

  // ---------- A6-42: preview must echo and NOT write
  await clickTab(page, "01:");
  await delay(1000);
  const before = ((await q("tradePackages:listByProject", { projectId: proj._id })) || []).map((p) => p._id);
  out.beforeCount = before.length;
  await clickText(page, "AI Spec Breakdown");
  await delay(900);
  await page.evaluate((txt) => {
    const ta = document.querySelector('textarea[aria-label="Architectural and engineering specifications text"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, txt);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new Event("change", { bubbles: true }));
  }, AMBIGUOUS);
  await clickText(page, "Analyze Specifications");
  let previewDom = null;
  for (let i = 0; i < 30; i++) {
    await delay(2500);
    previewDom = await page.evaluate(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getBoundingClientRect().width > 1);
      if (!dialog) return null;
      const t = dialog.innerText;
      return {
        hasPreview: t.includes("Step 2 of 2"),
        text: t.replace(/\n+/g, " | ").slice(0, 1400),
        buttons: [...dialog.querySelectorAll("button")].map((b) => (b.textContent || "").trim()),
      };
    });
    if (previewDom?.hasPreview) break;
  }
  out.preview = previewDom;
  const during = ((await q("tradePackages:listByProject", { projectId: proj._id })) || []).map((p) => p._id);
  out.wroteBeforeConfirm = during.length !== before.length;
  const clicked = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getBoundingClientRect().width > 1);
    const b = dialog ? [...dialog.querySelectorAll("button")].find((x) => /^Generate \d+ Trade Package/.test((x.textContent || "").trim())) : null;
    b?.click();
    return Boolean(b);
  });
  out.confirmClicked = clicked;
  const after = await poll(
    () => q("tradePackages:listByProject", { projectId: proj._id }),
    (x) => (x || []).length > before.length,
    90000,
    2500
  );
  out.created = (after || []).filter((p) => !before.includes(p._id)).map((p) => ({ csi: p.csiDivision, name: p.tradeName, budget: p.budgetEstimate }));
  await delay(500);

  // ---------- A6-27: discovery filtering on the Div 26 package
  const pkgs = (await q("tradePackages:listByProject", { projectId: proj._id })) || [];
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
  out.discovery = afterCtrs.map((c) => ({ companyName: c.companyName, sourceUrl: c.sourceUrl, contactEmail: c.contactEmail, licenseStatus: c.licenseStatus }));
  out.discoveryBad = out.discovery.filter((c) =>
    /\.gov|\.mil|state\..*\.us|ibew|director/i.test(c.sourceUrl) || /directory|permits|licenses|regulations|secretary of state/i.test(c.companyName)
  );

  // ---------- A6-35: zero-contractor quote on Div 03 naming a mechanical company
  await clickTab(page, "01:");
  await delay(900);
  await makePackage(page, "03 30 00", "AUDIT7 After Div 03 Concrete", 400000, "Division 03 concrete scope.");
  const pkgs3 = await q("tradePackages:listByProject", { projectId: proj._id });
  const p03 = pkgs3.find((p) => p.csiDivision.startsWith("03"));
  await clickTab(page, "01:");
  await delay(700);
  await page.evaluate((name) => {
    const h = [...document.querySelectorAll("h3")].find((x) => x.textContent.trim() === name);
    h?.click();
  }, p03.tradeName);
  await clickTab(page, "04:");
  await delay(1000);
  await clickText(page, "Ingest Quote / PDF");
  await delay(800);
  await page.evaluate(() => {
    const input = document.getElementById("ingest-new-contractor-name");
    if (!input) return;
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
    "Scope: Division 03 concrete equipment pads and foundations.",
    "Exclusions: crane rigging and hoisting excluded ($18,600); firestopping excluded ($9,950); seismic bracing excluded ($7,400).",
    "Schedule: equipment procurement lead time is 17 weeks from notice to proceed; the project target is 12 weeks.",
    "Insurance: umbrella liability endorsement excluded.",
  ].join("\n");
  const taBox = await page.evaluate(() => {
    const ta = document.getElementById("ingest-quote-text");
    if (!ta) return null;
    ta.scrollIntoView({ block: "center" });
    const r = ta.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(taBox.x, taBox.y);
  await page.keyboard.type(quote, { delay: 0.3 });
  await clickText(page, "Extract & Level Bid");
  const bids03 = await poll(() => q("bids:listByPackage", { tradePackageId: p03._id }), (x) => (x || []).length > 0, 120000, 2500);
  const ctrs03 = (await q("contractors:listByPackage", { tradePackageId: p03._id })) || [];
  out.quoteCreatedContractor = ctrs03.map((c) => ({ name: c.companyName, email: c.contactEmail, licenseNumber: c.licenseNumber, licenseStatus: c.licenseStatus, sourceUrl: c.sourceUrl }));
  const bid03 = (bids03 || [])[0];
  out.bid03 = bid03 ? { base: bid03.baseBidAmount, weeks: bid03.longLeadEquipmentWeeks, target: bid03.leadTimeTargetWeeks, penalty: bid03.leadTimePenalty, leveled: bid03.leveledTotalCost } : null;

  // Award Div 03 through the UI and inspect the draft contact line
  if (bid03) {
    await clickTab(page, "04:");
    await delay(900);
    await page.evaluate((name) => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("Award Compliant Winner"));
      b?.click();
      void name;
    });
    const agrs = await poll(() => q("agreements:listAgreements", { projectId: proj._id }), (x) => (x || []).some((a) => String(a.csiDivision).startsWith("03")), 60000, 2000);
    const agr = (agrs || []).find((a) => String(a.csiDivision).startsWith("03"));
    out.agreement03 = agr ? { number: agr.agreementNumber, sub: agr.subcontractorName, email: agr.subcontractorEmail } : null;
    if (agr?.contractText) {
      out.contactLine = String(agr.contractText).split(/\r?\n/).find((l) => /^\s*Contact:/.test(l)) || null;
      out.licenseLine = String(agr.contractText).split(/\r?\n/).find((l) => /^\s*License No:/.test(l)) || null;
    }
  }
} catch (err) {
  out.error = String(err?.stack ?? err);
  console.error(err);
} finally {
  await browser.close();
}
await writeEvidence("fix6-a7-06-after.json", out);
console.log(JSON.stringify({ preview: out.preview && { hasPreview: out.preview.hasPreview, text: out.preview.text }, wroteBeforeConfirm: out.wroteBeforeConfirm, confirmClicked: out.confirmClicked, created: out.created, discovery: out.discovery, discoveryBad: out.discoveryBad, quoteCreatedContractor: out.quoteCreatedContractor, bid03: out.bid03, agreement03: out.agreement03, contactLine: out.contactLine, licenseLine: out.licenseLine }, null, 2));