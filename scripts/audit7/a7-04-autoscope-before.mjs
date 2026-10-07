// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
/**
 * A7-04: BEFORE-fix live probe for A6-42 (Auto-Scope writes packages with no parse echo/confirm).
 * Submits an ambiguous plumbing spec through the real modal and records what was written,
 * whether any confirmation step existed, and whether the modal echoed detected divisions.
 */
import { delay, openApp, q, clickTab, selectProject, clickText, writeEvidence, DAILY, PREFIX } from "./lib.mjs";

const TITLE = `${PREFIX}LEAD-${DAILY}`;
const out = { startedAt: new Date().toISOString() };
const proj = ((await q("projects:listProjects", {})) || []).find((p) => p.title === TITLE);
if (!proj) throw new Error("fixture missing");

const AMBIGUOUS = `SECTION 22 00 00 - PLUMBING SYSTEMS
Domestic water piping, sanitary waste, and vent systems. Structural steel pipe racks and supports for
exposed piping in the mechanical yard. Black steel and galvanized pipe fabrication. Some 05 12 00
structural steel angle framing may be required for the equipment pads per the structural drawings.
Provide hangers, supports, and seismic restraints. Concrete housekeeping pads by others.`;

const { browser, page } = await openApp(1440, 900);
try {
  await selectProject(page, proj._id);
  await clickTab(page, "01:");
  await delay(1200);
  const before = (await q("tradePackages:listByProject", { projectId: proj._id })) || [];
  out.before = before.map((p) => `${p.csiDivision} ${p.tradeName}`);
  await clickText(page, "AI Spec Breakdown");
  await delay(900);
  const setSpec = await page.evaluate((txt) => {
    const ta = document.querySelector('textarea[aria-label="Architectural and engineering specifications text"]');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, txt);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, AMBIGUOUS);
  out.setSpec = setSpec;
  const confirmStepDom = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getBoundingClientRect().width > 1);
    const t = dialog ? dialog.innerText : "";
    return {
      hasConfirmStep: /Confirm|Review|detected|parsed|will create/i.test(t),
      buttons: dialog ? [...dialog.querySelectorAll("button")].map((b) => (b.textContent || "").trim()) : [],
    };
  });
  out.beforeSubmitDom = confirmStepDom;
  await clickText(page, "Auto-Generate Trade Packages");
  await delay(2500);
  out.progressText = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getBoundingClientRect().width > 1);
    return dialog ? dialog.innerText.replace(/\n+/g, " | ").slice(0, 800) : null;
  });
  let after = before;
  for (let i = 0; i < 40; i++) {
    await delay(3000);
    after = (await q("tradePackages:listByProject", { projectId: proj._id })) || [];
    if (after.length > before.length) break;
    const t = await page.evaluate(() => document.body.innerText);
    if (/breakdown failed|failed:/i.test(t)) break;
  }
  out.after = after.map((p) => ({ csi: p.csiDivision, name: p.tradeName, budget: p.budgetEstimate, scope: String(p.scopeSummary).slice(0, 140) }));
  out.created = after.filter((p) => !before.some((b) => b._id === p._id)).map((p) => ({ csi: p.csiDivision, name: p.tradeName, budget: p.budgetEstimate }));
  out.echoBeforeWrite = false; // observed: single-click write, no preview step
  out.afterText = await page.evaluate(() => (document.querySelector("main") || document.body).innerText.replace(/\n+/g, " | ").slice(0, 1200));
} catch (err) {
  out.error = String(err?.stack ?? err);
  console.error(err);
} finally {
  await browser.close();
}
await writeEvidence("fix6-a7-04-autoscope-before.json", out);
console.log(JSON.stringify({ before: out.before, created: out.created, beforeSubmitDom: out.beforeSubmitDom, progressText: out.progressText }, null, 2));