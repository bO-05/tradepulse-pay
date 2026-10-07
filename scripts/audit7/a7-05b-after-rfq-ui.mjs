// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
/**
 * A7-05b: AFTER-fix live verification for A6-29 (RFQ toast truth + package notice)
 * and the rendered lead-time arithmetic. Uses the AUDIT7-AFTER fixture.
 */
import { delay, openApp, q, clickTab, selectProject, selectRibbonPackage, clickText, addContractor, poll, writeEvidence, PREFIX, DAILY } from "./lib.mjs";
import fs from "node:fs";
import path from "node:path";

const TITLE = `${PREFIX}AFTER-${DAILY}`;
const out = { startedAt: new Date().toISOString(), toasts: [], dispatchLogs: [] };
function toastText(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="status"],[aria-live="polite"],[aria-live="assertive"]')]
      .map((e) => (e.innerText || "").trim())
      .filter(Boolean)
      .join(" | ")
  );
}

const proj = ((await q("projects:listProjects", {})) || []).find((p) => p.title === TITLE);
if (!proj) throw new Error("after fixture missing");
const pkgs = (await q("tradePackages:listByProject", { projectId: proj._id })) || [];
const p22 = pkgs.find((p) => p.csiDivision.startsWith("22"));

const { browser, page } = await openApp(1440, 900);
try {
  await selectProject(page, proj._id);
  // Rendered arithmetic on the lead-time row
  await clickTab(page, "04:");
  await delay(1000);
  await selectRibbonPackage(page, p22.tradeName);
  await delay(1500);
  out.levelingText = await page.evaluate(() => {
    const t = (document.querySelector("main") || document.body).innerText.replace(/\n+/g, " | ");
    const idx = t.indexOf("Equipment Lead Time");
    return idx === -1 ? t.slice(0, 2500) : t.slice(Math.max(0, idx - 250), idx + 500);
  });
  const evidenceDir = path.join(process.cwd(), "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, "fix6-a7-05b-lead-arithmetic.png") });

  // A6-29: add a fresh contractor (no bid) and dispatch a single RFQ
  const stamp = Date.now().toString().slice(-5);
  const targetName = `AUDIT7 After NoBid ${stamp}`;
  await addContractor(page, p22.tradeName, targetName, `estimating@audit7-nobid-${stamp}.invalid`, `OR-AUDIT7-NB${stamp}`);
  await delay(1000);
  const ctrs = await q("contractors:listByPackage", { tradePackageId: p22._id });
  const target = (ctrs || []).find((c) => c.companyName === targetName);
  out.target = target ? { _id: target._id, rfqStatus: target.rfqStatus } : null;
  await clickTab(page, "Discovery");
  await delay(1200);
  await selectRibbonPackage(page, p22.tradeName);
  await delay(800);
  out.inviteClicked = await page.evaluate((name) => {
    const row = [...document.querySelectorAll("h4")].find((h) => h.textContent.trim() === name);
    const scope = row ? row.closest("div.p-4") : null;
    const b = scope ? [...scope.querySelectorAll("button")].find((x) => x.textContent.includes("Invite to Bid")) : null;
    b?.click();
    return Boolean(b);
  }, targetName);
  const seen = new Set();
  for (let i = 0; i < 10; i++) {
    await delay(1500);
    const t = await toastText(page);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.toasts.push({ at: i, text: t });
    }
  }
  const logs = (await q("auditLogs:listRecentLogs", { projectId: proj._id, limit: 100 })) || [];
  out.dispatchLogs = logs.filter((l) => /AgentMail Delivery|RFQ Invitation/i.test(l.title)).slice(0, 4).map((l) => ({ title: l.title, description: l.description }));
  await page.screenshot({ path: path.join(evidenceDir, "fix6-a7-05b-rfq-toast.png") });
  await clickTab(page, "01:");
  await delay(1500);
  out.packageNotice = await page.evaluate(() => {
    const t = (document.querySelector("main") || document.body).innerText;
    const idx = t.indexOf("Email delivery unavailable");
    return idx === -1 ? null : t.slice(Math.max(0, idx - 160), idx + 140).replace(/\n+/g, " | ");
  });
  await page.screenshot({ path: path.join(evidenceDir, "fix6-a7-05b-package-notice.png") });
} catch (err) {
  out.error = String(err?.stack ?? err);
  console.error(err);
} finally {
  await browser.close();
}
await writeEvidence("fix6-a7-05b-after.json", out);
console.log(JSON.stringify({ levelingText: out.levelingText, inviteClicked: out.inviteClicked, toasts: out.toasts, dispatchLogs: out.dispatchLogs, packageNotice: out.packageNotice }, null, 2));