// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
/**
 * AUDIT7 remediation harness — shared helpers for the Pass-3 (audit-6 remediation)
 * live verification. Fixtures are AUDIT7-* and are deleted before finishing.
 * Read-only backend queries via ConvexHttpClient; UI driving via puppeteer-core.
 */
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { launchBrowser, waitForAppReady } from "../qa/lib.mjs";

export { delay };
export const URL = "https://brainy-skunk-440.convex.cloud";
export const BASE = "https://brainy-skunk-440.convex.site";
export const PREFIX = "AUDIT7-";
export const DAILY = new Date().toISOString().slice(0, 10);
export const http = new ConvexHttpClient(URL);

export async function q(path, args, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await http.query(path, args);
    } catch (e) {
      lastErr = e;
      await delay(1200 + i * 800);
    }
  }
  throw lastErr;
}

export async function call(path, args, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await http.mutation(path, args);
    } catch (e) {
      lastErr = e;
      await delay(1200 + i * 800);
    }
  }
  throw lastErr;
}

export async function action(path, args, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await http.action(path, args);
    } catch (e) {
      lastErr = e;
      await delay(1500 + i * 1000);
    }
  }
  throw lastErr;
}

export async function openApp(width = 1440, height = 900) {
  const { browser } = await launchBrowser(width, height);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem("tradepulse.tourDismissed", "1");
    } catch {}
  });
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await waitForAppReady(page, 60000);
  await delay(1000);
  await closeTour(page);
  return { browser, page };
}

export async function closeTour(page) {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find(
      (x) => (x.getAttribute("title") || "").includes("Close Demo Tour") || (x.textContent || "").trim() === "Dismiss"
    );
    b?.click();
  });
  await delay(250);
}

export async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

export async function waitForBody(page, text, timeout = 15000, interval = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate((t) => document.body.innerText.includes(t), text)) return true;
    await delay(interval);
  }
  return false;
}

export async function clickText(page, text, opts = {}) {
  const t0 = Date.now();
  const timeout = opts.timeout ?? 12000;
  while (Date.now() - t0 < timeout) {
    const box = await page.evaluate(
      (needle, exact) => {
        const buttons = [...document.querySelectorAll("button")];
        const match = buttons.find((b) => {
          const t = (b.textContent || "").trim().replace(/\s+/g, " ");
          return exact ? t === needle : t.includes(needle);
        });
        if (!match) return null;
        match.scrollIntoView({ block: "center" });
        const r = match.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (match.textContent || "").trim().replace(/\s+/g, " ") };
      },
      text,
      !!opts.exact
    );
    if (box) {
      await page.mouse.click(box.x, box.y);
      return { ok: true, ...box };
    }
    await delay(300);
  }
  return { ok: false, reason: "button not found", text };
}

export async function clickTab(page, prefix) {
  const ok = await page.evaluate((p) => {
    const b = [...document.querySelectorAll("button")].find((x) => {
      const t = x.getAttribute("title") || "";
      const txt = (x.textContent || "").trim();
      return t.startsWith(p) || t.includes(p) || txt.includes(p);
    });
    b?.click();
    return Boolean(b);
  }, prefix);
  await delay(1200);
  return ok;
}

export async function selectProject(page, projectId) {
  await page.evaluate((pid) => {
    const s = document.querySelector('select[aria-label="Select Commercial Construction Project"]');
    if (!s) return false;
    s.value = pid;
    s.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, projectId);
  await delay(1800);
}

export async function selectRibbonPackage(page, tradeName) {
  const ok = await page.evaluate((needle) => {
    const b = [...document.querySelectorAll("button")].find(
      (x) => (x.textContent || "").includes(needle) && x.getAttribute("aria-pressed") !== null
    );
    if (!b) return false;
    b.click();
    return true;
  }, tradeName);
  await delay(1200);
  return ok;
}

export async function selectPackageCard(page, tradeName) {
  const ok = await page.evaluate((name) => {
    const h = [...document.querySelectorAll("h3")].find((x) => (x.textContent || "").trim() === name);
    if (!h) return false;
    h.click();
    return true;
  }, tradeName);
  await delay(1200);
  return ok;
}

export async function setVal(page, selector, value) {
  return page.evaluate(
    (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error("input not found: " + sel);
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value;
    },
    selector,
    value
  );
}

export async function typeInto(page, selector, value, delayMs = 4) {
  await page.click(selector, { clickCount: 3 });
  await delay(80);
  await page.type(selector, value, { delay: delayMs });
}

export async function confirmDialog(page, confirmLabel, { cancel = false } = {}) {
  const t0 = Date.now();
  let box = null;
  while (Date.now() - t0 < 7000) {
    box = await page.evaluate((lbl) => {
      const dialogs = [...document.querySelectorAll('[role="alertdialog"],[role="dialog"]')].filter(
        (d) => d.getBoundingClientRect().width > 1
      );
      const d = dialogs[dialogs.length - 1];
      if (!d) return null;
      const btns = [...d.querySelectorAll("button")];
      const target = btns.find((b) => (b.textContent || "").trim() === lbl || (b.textContent || "").includes(lbl));
      if (!target) return null;
      const r = target.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, title: d.querySelector("h2,h3")?.textContent?.trim() };
    }, cancel ? "Cancel" : confirmLabel);
    if (box) break;
    await delay(250);
  }
  if (!box) return { ok: false, reason: "confirm dialog not found", confirmLabel };
  await page.mouse.click(box.x, box.y);
  return { ok: true, dialogTitle: box.title };
}

export async function poll(fn, pred, timeoutMs, stepMs) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await fn();
      if (pred(last)) return last;
    } catch (e) {
      last = { error: String(e?.message ?? e) };
    }
    await delay(stepMs);
  }
  return last;
}

export function writeEvidence(name, obj) {
  const dir = process.env.AUDIT7_EVIDENCE_DIR || path.join(process.cwd(), "evidence");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
  console.log(`[evidence] ${file}`);
  return file;
}

export async function deleteProject(projectId) {
  try {
    const agreements = (await q("agreements:listAgreements", { projectId })) || [];
    for (const a of agreements.filter((x) => x.status === "executed")) {
      try {
        await call("agreements:voidExecutedAgreement", {
          agreementId: a._id,
          reason: "AUDIT7 harness cleanup of fixture executed record.",
        });
      } catch {}
    }
    await call("projects:deleteProject", { projectId });
    return true;
  } catch (e) {
    console.error("deleteProject failed:", e?.message ?? e);
    return false;
  }
}

export async function demoSnapshot() {
  const projects = (await q("projects:listProjects", {})) || [];
  const demo = projects.find((p) => /The Domain Tower B/.test(p.title));
  if (!demo) return { demo: null, projects: projects.map((p) => p.title) };
  const [packages, contractors, bids, agreements, clash, logs] = await Promise.all([
    q("tradePackages:listByProject", { projectId: demo._id }),
    q("contractors:listByProject", { projectId: demo._id }),
    q("bids:listAllProjectBids", { projectId: demo._id }),
    q("agreements:listAgreements", { projectId: demo._id }),
    q("coordination:detectCrossTradeClashes", { projectId: demo._id }).catch(() => null),
    q("auditLogs:listRecentLogs", { projectId: demo._id, limit: 500 }),
  ]);
  const conversationLists = await Promise.all(
    (packages || []).map((p) => q("rfq:listConversations", { tradePackageId: p._id }).catch(() => []))
  );
  const conversations = conversationLists.flat();
  const effective = (pkgBids) => {
    const awarded = pkgBids.find((b) => b.isAwarded);
    if (awarded) return awarded;
    return [...pkgBids].sort((a, b) => a.leveledTotalCost - b.leveledTotalCost)[0];
  };
  let leveledBuyout = 0;
  for (const pkg of packages || []) {
    const pkgBids = (bids || []).filter((b) => b.tradePackageId === pkg._id);
    if (pkgBids.length === 0) leveledBuyout += pkg.budgetEstimate || 0;
    else leveledBuyout += effective(pkgBids)?.leveledTotalCost || 0;
  }
  return {
    projectId: demo._id,
    title: demo.title,
    estBudget: demo.estBudget,
    packageCount: (packages || []).length,
    contractorCount: (contractors || []).length,
    bidCount: (bids || []).length,
    agreementCount: (agreements || []).length,
    conversationCount: conversations.length,
    clashCount: ((clash?.doubleBuys || []).length + (clash?.scopeVoids || []).length),
    awardedPackages: (packages || []).filter((p) => p.status === "awarded").length,
    logCount: (logs || []).length,
    computedLeveledBuyout: leveledBuyout,
  };
}

export async function readPkgBids(projectId) {
  return (await q("bids:listAllProjectBids", { projectId })) || [];
}

export async function levelingCardText(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main") || document.body;
    const t = main.innerText;
    const idx = t.indexOf("Equipment Lead Time");
    if (idx === -1) return null;
    return t.slice(Math.max(0, idx - 200), idx + 400).replace(/\n+/g, " | ");
  });
}

export async function makeFixtureProject(page, { title, gc, budget = 3000000, weeks = 52, spec }) {
  await clickText(page, "New Project");
  await delay(800);
  const fills = {
    title: await setVal(page, 'input[aria-label="Project title"]', title),
    location: await setVal(page, 'input[aria-label="Project location"]', "Portland, OR"),
    type: await setVal(page, 'input[aria-label="Project type"]', "Industrial / Water Treatment"),
    gc: await setVal(page, 'input[aria-label="General contractor or contracting entity"]', gc),
    budget: await setVal(page, 'input[aria-label="Estimated budget in dollars"]', String(budget)),
    weeks: await setVal(page, 'input[aria-label="Target completion duration in weeks"]', String(weeks)),
    spec: await setVal(page, 'textarea[placeholder*="Outline high-level trade scopes"]', spec),
  };
  const go = await page.evaluate(() => {
    const ds = [...document.querySelectorAll('[role="dialog"]')].filter((x) => x.getBoundingClientRect().width > 1);
    const d = ds[ds.length - 1];
    const b = d && [...d.querySelectorAll("button")].find((x) => /Create Commercial Project/.test(x.innerText || ""));
    if (!b) return { ok: false };
    b.click();
    return { ok: true, disabled: b.disabled };
  });
  const proj = await poll(
    () => q("projects:listProjects", {}).then((ps) => ps.find((p) => p.title === title)),
    (p) => Boolean(p),
    90000,
    2000
  );
  return { fills, go, proj };
}

export async function makePackage(page, csi, name, budget, scope) {
  await clickTab(page, "CSI Scoping");
  await delay(1000);
  await clickText(page, "Create Trade Package");
  await delay(800);
  const d = new Date(Date.now() + 14 * 86400000);
  const localD = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const fills = {
    csi: await setVal(page, 'input[aria-label="CSI division number"]', csi),
    name: await setVal(page, 'input[aria-label="Trade package name"]', name),
    budget: await setVal(page, 'input[aria-label="Budget estimate in dollars"]', String(budget)),
    scope: await setVal(page, 'textarea[aria-label="Scope summary"]', scope),
    inclusions: await setVal(page, 'textarea[aria-label="Mandatory inclusions, one per line"]', "All labor and materials per plans and specifications"),
    deadline: await setVal(page, 'input[aria-label="Bid deadline"]', localD),
  };
  const go = await clickText(page, "Create Package");
  await delay(1800);
  return { fills, go };
}

export async function addContractor(page, pkgName, company, email, lic) {
  await clickTab(page, "Discovery");
  await delay(1200);
  await selectRibbonPackage(page, pkgName);
  await delay(600);
  await clickText(page, "Add Contractor Manually");
  await delay(800);
  await typeInto(page, 'input[placeholder*="Rosendin"]', company);
  await typeInto(page, 'input[placeholder*="estimating@rosendin"]', email);
  await typeInto(page, 'input[placeholder*="TECL"]', lic);
  const go = await clickText(page, "Add to Directory");
  await delay(1800);
  return go;
}

/** Ingest a quote through the real UI modal on the Bid Leveling tab. */
export async function ingestQuote(page, contractorId, quoteText) {
  await clickTab(page, "04:");
  await delay(1200);
  const open = await clickText(page, "Ingest Quote / PDF");
  if (!open.ok) return { ok: false, step: "open-modal", open };
  await delay(800);
  const s = await page.evaluate((cid) => {
    const sel = document.querySelector('select[aria-label="Subcontractor or bidder for this proposal"]');
    if (!sel) return { ok: false };
    sel.value = cid;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value: sel.value };
  }, contractorId);
  const taBox = await page.evaluate(() => {
    const ta = document.querySelector('textarea[aria-label="Proposal OCR text or pasted quote"]');
    if (!ta) return null;
    ta.scrollIntoView({ block: "center" });
    const r = ta.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!taBox) return { ok: false, step: "textarea-missing", s };
  await page.mouse.click(taBox.x, taBox.y);
  await page.keyboard.type(quoteText, { delay: 0.3 });
  await delay(300);
  const submit = await clickText(page, "Extract & Level Bid");
  return { ok: open.ok && s.ok && submit.ok, s, submit };
}

export async function scanBidLevelingText(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main") || document.body;
    return main.innerText.replace(/\n+/g, " | ");
  });
}

export async function closeAndWrite(browser, name, data) {
  await browser.close();
  await writeEvidence(name, data);
}