// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
/**
 * A7-02: BEFORE-fix live probes for A6-27 (discovery quality) and A6-29 (RFQ toast truth)
 * plus A6-22 (ingest modal structure). Uses the AUDIT7-LEAD fixture project.
 */
import { delay, openApp, q, clickTab, selectProject, selectRibbonPackage, selectPackageCard, clickText, waitForBody, makePackage, writeEvidence, DAILY, PREFIX } from "./lib.mjs";

const TITLE = `${PREFIX}LEAD-${DAILY}`;
const out = { startedAt: new Date().toISOString(), toasts: [], audit: [] };

function toastText(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="status"],[aria-live="polite"],[aria-live="assertive"]')]
      .map((e) => (e.innerText || "").trim())
      .filter(Boolean)
      .join(" | ")
  );
}

const proj = ((await q("projects:listProjects", {})) || []).find((p) => p.title === TITLE);
if (!proj) throw new Error("fixture missing");
const pkgs = (await q("tradePackages:listByProject", { projectId: proj._id })) || [];
const p26 = pkgs.find((p) => p.csiDivision.startsWith("26"));
const p22 = pkgs.find((p) => p.csiDivision.startsWith("22"));

const { browser, page } = await openApp(1440, 900);
try {
  await selectProject(page, proj._id);

  // ---- A6-27: discovery on Div 26, Portland OR
  await clickTab(page, "Discovery");
  await delay(1200);
  await selectRibbonPackage(page, p26.tradeName);
  const beforeCtrs = (await q("contractors:listByPackage", { tradePackageId: p26._id })) || [];
  const disco = await clickText(page, "Discover Trade Contractors");
  await delay(1000);
  let afterCtrs = beforeCtrs;
  for (let i = 0; i < 40; i++) {
    await delay(3000);
    afterCtrs = (await q("contractors:listByPackage", { tradePackageId: p26._id })) || [];
    if (afterCtrs.length > beforeCtrs.length) break;
    const t = await toastText(page);
    if (/Discovery failed|no usable/i.test(t)) break;
  }
  const logs = (await q("auditLogs:listRecentLogs", { projectId: proj._id, limit: 100 })) || [];
  out.discovery = {
    click: disco,
    before: beforeCtrs.length,
    after: afterCtrs.length,
    rows: afterCtrs.map((c) => ({
      companyName: c.companyName,
      sourceUrl: c.sourceUrl,
      contactEmail: c.contactEmail,
      licenseNumber: c.licenseNumber,
      licenseStatus: c.licenseStatus,
      rfqStatus: c.rfqStatus,
    })),
    logs: logs.filter((l) => /Discovery|Discovered/i.test(l.title)).slice(0, 5).map((l) => ({ title: l.title, description: l.description })),
  };

  // ---- A6-29: Invite to Bid on the first discovered record (if any)
  const target = afterCtrs.find((c) => c.rfqStatus === "discovered") || (beforeCtrs.length ? beforeCtrs[0] : null);
  if (target) {
    out.dispatchTarget = { _id: target._id, companyName: target.companyName, contactEmail: target.contactEmail };
    await page.evaluate((id) => {
      const row = [...document.querySelectorAll("h4")].find((h) => h.textContent.trim() === id.name);
      const scope = row ? row.closest("div.p-4") : null;
      const b = scope ? [...scope.querySelectorAll("button")].find((x) => x.textContent.includes("Invite to Bid")) : null;
      b?.click();
    }, { name: target.companyName });
    for (let i = 0; i < 8; i++) {
      await delay(2000);
      const t = await toastText(page);
      if (t) out.toasts.push({ at: i, text: t });
    }
    await waitForBody(page, "Invited", 5000).catch(() => {});
    const logs2 = (await q("auditLogs:listRecentLogs", { projectId: proj._id, limit: 100 })) || [];
    out.dispatchLogs = logs2
      .filter((l) => /AgentMail Delivery|RFQ Dispatched|Individual RFQ/i.test(l.title))
      .slice(0, 5)
      .map((l) => ({ title: l.title, description: l.description, actor: l.actor }));
    out.dispatchRow = (await q("contractors:listByPackage", { tradePackageId: p26._id }))?.find((c) => c._id === target._id);
  }

  // ---- A6-22: ingest modal structure, zero-contractor package vs has-contractor package
  await clickTab(page, "04:");
  await delay(1200);
  await selectRibbonPackage(page, p26.tradeName);
  await delay(800);
  await clickText(page, "Ingest Quote / PDF");
  await delay(900);
  out.ingestModalWithContractors = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getBoundingClientRect().width > 1);
    if (!dialog) return null;
    return {
      controls: [...dialog.querySelectorAll("input,select,textarea")].map((e) => ({
        tag: e.tagName,
        aria: e.getAttribute("aria-label"),
        placeholder: e.getAttribute("placeholder"),
        type: e.getAttribute("type"),
      })),
      buttons: [...dialog.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).slice(0, 8),
    };
  });
  await page.keyboard.press("Escape");
  await delay(600);

  await clickTab(page, "01:");
  await delay(1000);
  const p03make = await makePackage(page, "03 30 00", "AUDIT7 Div 03 Concrete", 400000, "Division 03 concrete structure scope.");
  const pkgs3 = await q("tradePackages:listByProject", { projectId: proj._id });
  const p03 = pkgs3.find((p) => p.csiDivision.startsWith("03"));
  out.p03 = p03 ? { _id: p03._id, make: p03make.go } : null;
  const p03Ctrs = p03 ? await q("contractors:listByPackage", { tradePackageId: p03._id }) : [];
  await clickTab(page, "01:");
  await delay(900);
  await selectPackageCard(page, p03.tradeName);
  await clickTab(page, "04:");
  await delay(900);
  await clickText(page, "Ingest Quote / PDF");
  await delay(900);
  out.ingestModalZeroContractors = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getBoundingClientRect().width > 1);
    if (!dialog) return null;
    return {
      zeroContractorsSeen: document.body.innerText.includes("No contractors"),
      controls: [...dialog.querySelectorAll("input,select,textarea")].map((e) => ({
        tag: e.tagName,
        aria: e.getAttribute("aria-label"),
        placeholder: e.getAttribute("placeholder"),
      })),
      buttons: [...dialog.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).slice(0, 8),
    };
  });
  out.p03Contractors = p03Ctrs.length;
  await page.keyboard.press("Escape");
  await delay(400);
  out.p22Contractors = (await q("contractors:listByPackage", { tradePackageId: p22._id })).length;
} catch (err) {
  out.error = String(err?.stack ?? err);
  console.error(err);
} finally {
  await browser.close();
}
await writeEvidence("fix6-a7-02-discovery-rfq-before.json", out);
console.log(JSON.stringify({ discovery: out.discovery && { before: out.discovery.before, after: out.discovery.after, rows: out.discovery.rows.map((r) => `${r.companyName} <${r.sourceUrl}> ${r.contactEmail}`) }, toasts: out.toasts, dispatchLogs: out.dispatchLogs, modal: out.ingestModalWithContractors }, null, 2));