/**
 * Isolated recovery DEV only. Default inspect-only; --submit authorizes one
 * fixture-scoped SUB1 draft + submission. Reruns inspect the existing pay app
 * and verify its GC review/agent provenance without submitting again.
 * node scripts/qa/recovery-ai-smoke.mjs [--submit]
 * Never approves/rejects, funds, captures, pays, resets, seeds, or sends email.
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const TARGET = "https://cheery-axolotl-689.convex.site/";
const FIXTURE = "A401-DEMO-PAYREVIEW-MISTRAL1";
const NOTE = "Mistral recovery smoke: 10% branch conduit and wire feeder rough-in installation; mobilization complete and rough-in in progress. No equipment or closeout work billed.";
if (process.argv.slice(2).some(arg => arg !== "--submit")) throw new Error("Only --submit is supported; target is recovery DEV only.");
const submitEnabled = process.argv.includes("--submit");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = path.join(root, "evidence", `recovery-ai-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(dir, { recursive: true });
const report = { target: TARGET, fixture: FIXTURE, submitEnabled, steps: [], responseMetadata: [], diagnostics: [], errors: [] };
const sanitize = text => String(text)
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
  .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
  .replace(/\beyJ[A-Za-z0-9_.-]+/g, "[token]")
  .replace(/TradePulseDemo!2026/g, "[demo-password]")
  .slice(0, 18000);
const browser = await puppeteer.launch({
  executablePath: process.env.QA_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, defaultViewport: { width: 1500, height: 1100 }, protocolTimeout: 45000,
});
async function session(role) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  // Passive query-response provenance only. Never inspect outgoing auth frames,
  // cookies, storage, action responses, or save raw WebSocket frames.
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketFrameReceived", ({ response }) => {
    try {
      const message = JSON.parse(response.payloadData);
      if (message.type !== "Transition") return;
      for (const modification of message.modifications ?? []) {
        if (modification.type !== "QueryUpdated") continue;
        const value = modification.value;
        const candidates = [value, value?.review];
        for (const item of candidates) {
          if (!item || typeof item !== "object" || typeof item.provider !== "string" || typeof item.model !== "string") continue;
          const metadata = {
            role, source: "browser query response", provider: sanitize(item.provider), model: sanitize(item.model),
            ...(item.runId ? { runId: sanitize(item.runId) } : {}),
            ...(typeof item.inputTokens === "number" ? { inputTokens: item.inputTokens } : {}),
            ...(typeof item.outputTokens === "number" ? { outputTokens: item.outputTokens } : {}),
            ...(item.parsedOutput?.kind ? { kind: sanitize(item.parsedOutput.kind) } : {}),
            ...(item.parsedOutput?.toolCalls ? { tools: item.parsedOutput.toolCalls.map(call => sanitize(call.tool)) } : {}),
          };
          if (!report.responseMetadata.some(existing => JSON.stringify(existing) === JSON.stringify(metadata))) report.responseMetadata.push(metadata);
        }
      }
    } catch { /* Ignore non-query/protocol frames without recording them. */ }
  });
  page.on("pageerror", error => report.diagnostics.push({ role, type: "pageerror", text: sanitize(error.message) }));
  page.on("console", msg => {
    if (msg.type() === "error") report.diagnostics.push({ role, type: "console", text: sanitize(msg.text()) });
  });
  await page.goto(TARGET, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="password"]');
  await page.evaluate(({ role }) => {
    const set = (selector, value) => {
      const el = document.querySelector(selector);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    set('input[type="email"]', `${role}@demo.tradepulse`);
    set('input[type="password"]', "TradePulseDemo!2026");
  }, { role });
  await page.evaluate(() => document.querySelector('input[type="password"]').closest("form").requestSubmit());
  await page.waitForFunction(() => !document.querySelector('input[type="password"]'));
  await delay(1000);
  report.steps.push({ role, action: "public demo sign-in", result: "success" });
  return { page, context };
}
async function navigate(page, hash) {
  await page.evaluate(hash => { location.hash = hash; }, hash);
  await delay(1600);
}
async function shot(page, name, selector) {
  // Mask rendered email text (including sandbox payees) in screenshots only.
  const masks = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const overlays = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(node.textContent)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        const mask = document.createElement("div");
        mask.dataset.qaEmailMask = "true";
        Object.assign(mask.style, { position: "absolute", left: `${rect.left + scrollX}px`, top: `${rect.top + scrollY}px`,
          width: `${rect.width}px`, height: `${rect.height}px`, background: "#334155", zIndex: "2147483647" });
        document.body.append(mask);
        overlays.push(mask);
      }
    }
    return overlays.length;
  });
  const file = `${name}.png`;
  const element = selector ? await page.$(selector) : null;
  if (element) await element.screenshot({ path: path.join(dir, file) });
  else await page.screenshot({ path: path.join(dir, file), fullPage: true });
  await page.evaluate(() => document.querySelectorAll("[data-qa-email-mask]").forEach(el => el.remove()));
  report.steps.push({ action: "screenshot", file, emailMasks: masks });
}
async function fixtureCard(page) {
  return page.evaluate(fixture => {
    const heading = [...document.querySelectorAll("h1,h2,h3")].find(el => el.textContent.includes(fixture));
    if (!heading) return null;
    let card = heading;
    while (card && !card.querySelector('[data-testid="new-pay-app"],a[href^="#/pay-apps/"]')) card = card.parentElement;
    if (!card) return null;
    card.dataset.qaFixture = "true";
    return { text: card.innerText, buttons: [...card.querySelectorAll("button")].map(el => ({ text: el.textContent.trim(), disabled: el.disabled })),
      links: [...card.querySelectorAll('a[href^="#/pay-apps/"]')].map(el => ({ text: el.textContent.trim(), hash: el.getAttribute("href") })) };
  }, FIXTURE);
}
try {
  const sub = await session("sub1");
  await navigate(sub.page, "#/pay-apps");
  await sub.page.waitForFunction(fixture => document.body.innerText.includes(fixture), { timeout: 30000 }, FIXTURE);
  const card = await fixtureCard(sub.page);
  report.fixtureCard = card ? { ...card, text: sanitize(card.text) } : null;
  if (!card) throw new Error("Fixture agreement not found in SUB1 Pay apps.");
  await shot(sub.page, "sub-fixture", '[data-qa-fixture="true"]');
  let payAppHash = card.links[0]?.hash;
  if (!payAppHash && submitEnabled) {
    await sub.page.evaluate(() => {
      const button = document.querySelector('[data-qa-fixture="true"] [data-testid="new-pay-app"]');
      if (!button || button.disabled) throw new Error("Fixture New pay app is unavailable/blocked.");
      button.click();
    });
    await sub.page.waitForFunction(() => location.hash.startsWith("#/pay-apps/"));
    payAppHash = new URL(sub.page.url()).hash;
    report.steps.push({ role: "sub1", action: "create fixture draft", path: payAppHash });
  }
  if (payAppHash) {
    report.payAppHash = payAppHash;
    await navigate(sub.page, payAppHash);
    await sub.page.waitForSelector('[data-testid="g703-line"]');
    report.draftLines = await sub.page.$$eval('[data-testid="g703-line"]', rows => rows.map(row => ({
      lineNo: row.dataset.lineNo, description: row.cells[1].innerText,
      scheduled: row.cells[2].innerText, previous: row.cells[3].innerText,
      inputs: [...row.querySelectorAll("input")].map(el => ({ type: el.type, value: el.value, label: el.getAttribute("aria-label") })),
    })));
    report.draftLines = JSON.parse(sanitize(JSON.stringify(report.draftLines)));
    const editable = await sub.page.$('[data-testid="payapp-submit"]');
    if (submitEnabled && editable) {
      // Actual fixture SOV: bill only 10% branch conduit/wire (rough-in).
      // Equipment, grounding, closeout, stored materials, excluded work remain zero.
      report.claims = await sub.page.evaluate(note => {
        const rows = [...document.querySelectorAll('[data-testid="g703-line"]')];
        const money = text => Number(text.replace(/[$,\s]/g, ""));
        const claims = [];
        for (const row of rows) {
          const desc = row.cells[1].innerText;
          if (/excluded|seismic/i.test(desc)) continue;
          if (!/Branch conduit & wire feeder runs/i.test(desc)) continue;
          const scheduled = money(row.cells[2].innerText);
          const previous = money(row.cells[3].innerText);
          if (!(scheduled > 0) || previous !== 0) throw new Error("Expected fresh positive fixture line.");
          const amount = Math.floor(scheduled * 0.10 * 100) / 100;
          const input = row.cells[4].querySelector("input");
          if (!input) throw new Error("Expected editable G703 work field.");
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, amount.toFixed(2));
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          claims.push({ lineNo: row.dataset.lineNo, description: desc, dollars: amount });
        }
        if (claims.length !== 1) throw new Error("Expected exactly one branch conduit/wire fixture line; not submitting.");
        return claims;
      }, NOTE);
      await delay(300);
      await sub.page.evaluate(note => {
        for (const row of document.querySelectorAll('[data-testid="g703-line"]')) {
          const input = row.cells[1].querySelector("input");
          if (!input) continue;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, note);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, NOTE);
      await sub.page.waitForFunction(() => document.querySelector('[data-testid="payapp-save-state"]')?.textContent.startsWith("Saved"));
      await shot(sub.page, "sub-saved-draft", '[data-testid="g703-sheet"]');
      await sub.page.evaluate(() => {
        const button = document.querySelector('[data-testid="payapp-submit"]');
        if (button.disabled) throw new Error("Pay app submit disabled.");
        button.click();
      });
      await sub.page.waitForSelector('[role="alertdialog"]');
      await sub.page.evaluate(() => {
        const button = [...document.querySelectorAll('[role="alertdialog"] button')].find(el => el.textContent.trim() === "Submit pay app");
        if (!button || button.disabled) throw new Error("Submit confirmation unavailable.");
        button.click();
      });
      await sub.page.waitForFunction(() => !document.querySelector('[data-testid="payapp-submit"]'), { timeout: 30000 });
      report.steps.push({ role: "sub1", action: "submit fixture pay app", result: "success", note: NOTE });
      await shot(sub.page, "sub-submitted");
    }
    if (payAppHash) {
      const gc = await session("gc");
      await navigate(gc.page, payAppHash);
      try { await gc.page.waitForSelector('[data-testid="review-engine"]', { timeout: 90000 }); }
      catch { report.errors.push("GC review did not appear within 90 seconds."); }
      report.gcReview = await gc.page.evaluate(() => ({
        engine: document.querySelector('[data-testid="review-engine"]')?.textContent,
        lines: [...document.querySelectorAll('[data-testid="review-line"]')].map(row => ({
          lineNo: row.dataset.lineNo, text: row.innerText,
        })),
        paymentBlockers: [...document.querySelectorAll('[data-testid="payment-blocker"]')].map(el => ({ code: el.dataset.code, text: el.textContent })),
        payButtonDisabled: document.querySelector('[data-testid="pay-sub-button"]')?.disabled,
      }));
      report.gcReview = JSON.parse(sanitize(JSON.stringify(report.gcReview)));
      await shot(gc.page, "gc-review", '[data-testid="gc-review-panel"]');
      await navigate(gc.page, "#/inbox");
      try {
        await gc.page.waitForFunction(id => !!document.querySelector(`[data-payapp-id="${id}"] [data-testid="proposal-card"]`),
          { timeout: 90000 }, payAppHash.split("/").pop());
      } catch { report.errors.push("Fixture agent proposals did not appear within 90 seconds."); }
      const id = payAppHash.split("/").pop();
      const selector = `[data-payapp-id="${id}"]`;
      await gc.page.evaluate(selector => {
        document.querySelector(`${selector} [data-testid="toggle-agent-trace"]`)?.click();
      }, selector);
      try {
        await gc.page.waitForSelector(`${selector} [data-testid="agent-trace-source"]`, { timeout: 90000 });
      } catch { report.errors.push("Pay-agent trace did not appear within 90 seconds after opening it."); }
      report.inbox = await gc.page.$eval(selector, entry => ({
        status: entry.querySelector('[data-testid="inbox-payapp-status"]')?.textContent,
        reviewSource: entry.querySelector('[data-testid="payapp-review-source"]')?.textContent,
        proposals: [...entry.querySelectorAll('[data-testid="proposal-card"]')].map(el => ({
          kind: el.dataset.kind,
          status: el.querySelector('[data-testid="proposal-status"]')?.textContent,
          text: el.innerText,
          flags: [...el.querySelectorAll('[data-testid="proposal-flag"]')].map(flag => flag.dataset.flag),
        })),
        traceSource: entry.querySelector('[data-testid="agent-trace-source"]')?.textContent,
        tools: [...entry.querySelectorAll('[data-testid="agent-trace-call"]')].map(el => ({ tool: el.dataset.tool, text: el.innerText })),
        traceText: entry.querySelector('[data-testid="agent-trace"]')?.innerText,
        kernel: [...entry.querySelectorAll("section,div")].find(el =>
          el.textContent.includes("California contractor license (CSLB)") &&
          el.textContent.includes("KERNEL") && el.innerText.length < 1800)?.innerText,
      }));
      report.inbox = JSON.parse(JSON.stringify(report.inbox), (_key, value) => typeof value === "string" ? sanitize(value) : value);
      for (const [surface, label] of [
        ["GC decision", report.gcReview.engine],
        ["inbox review", report.inbox.reviewSource],
        ["agent trace", report.inbox.traceSource],
      ]) {
        if (!label?.includes("Mistral") || /no AI model ran|Offline rules engine/i.test(label)) {
          report.errors.push(`${surface} did not display the real Mistral provenance.`);
        }
      }
      if (!report.inbox.proposals.length || report.inbox.proposals.some(proposal => proposal.status?.trim().toLowerCase() !== "pending")) {
        report.errors.push("Expected the fixture proposals to remain pending, without approval or execution.");
      }
      await shot(gc.page, "gc-inbox-trace", selector);
    }
  } else {
    report.steps.push({ action: "inspect-only", result: "Fixture available. Rerun --submit for authorized draft/submission." });
  }
} catch (error) { report.errors.push(sanitize(error.message)); }
finally {
  await browser.close();
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${dir}`);
  console.log(JSON.stringify(report, null, 2));
}
if (report.errors.length) process.exitCode = 1;
