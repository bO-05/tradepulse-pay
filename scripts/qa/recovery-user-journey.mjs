#!/usr/bin/env node
/**
 * Recovery dev only. Default: fresh-context public/judge UI inspection.
 * --signup: explicitly create one new account in an already-owned AgentMail inbox,
 * receive its real verification email, onboard a synthetic GC and create a project/package.
 * Never resets an existing account, sends to outside recipients, pays, or exports auth state.
 * Codes, passwords, API keys and email bodies remain in memory and out of evidence.
 * --concurrency: create one additional UNFUNDED demo run in a second fresh GC context,
 * verifying the first judge's bookmarked run survives. Never opens PayPal checkout.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = "https://cheery-axolotl-689.convex.site";
const deployment = "cheery-axolotl-689";
const proofRun = "nx74k1sdcnsmqzvkr97kf0ts598hch6p";
const signup = process.argv.includes("--signup");
const concurrency = process.argv.includes("--concurrency");
if (process.argv.slice(2).some((arg) => !["--signup", "--concurrency"].includes(arg))) throw new Error("Unknown flag.");
if (process.env.CONVEX_DEPLOY_KEY ||
    !/^CONVEX_DEPLOYMENT=dev:cheery-axolotl-689(?:\s|$)/m.test(fs.readFileSync(path.join(root, ".env.local"), "utf8"))) {
  throw new Error("Only isolated recovery dev without deployment-key overrides is permitted.");
}
const directory = path.join(root, "evidence", `recovery-user-journey-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(directory, { recursive: true });
const report = { target: site, signup, concurrency, checks: [], errors: [] };
let stage = "launch";
let browser;
let mcp;
let selector;
let concurrencyPage;
const check = (name, passed, detail = {}) => {
  report.checks.push({ name, passed: Boolean(passed), ...detail });
  if (!passed) throw new Error(`Check failed: ${name}`);
};
function unpack(result) {
  if (result.isError) throw new Error("Official Convex MCP failed; raw diagnostics suppressed.");
  return result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === "text").text);
}
async function call(name, args) {
  if (!["envGet", "runOneoffQuery"].includes(name)) throw new Error("MCP operation not allowed.");
  return unpack(await mcp.callTool({ name, arguments: { deploymentSelector: selector, ...args } }));
}
async function readonly(handler) {
  return (await call("runOneoffQuery", { query: `import { query } from "convex:/_system/repl/wrappers.js";
    export default query({ handler: async (ctx) => { ${handler} } });` })).result;
}
async function fresh(hash = "") {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(`${site}/${hash}`, { waitUntil: "domcontentloaded" });
  return { context, page };
}
async function clickText(page, text) {
  const found = await page.evaluate((text) => {
    const button = [...document.querySelectorAll("button,a")].find((el) => el.textContent.trim() === text && el.getClientRects().length);
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, text);
  if (!found) throw new Error(`Missing enabled control: ${text}`);
}
async function fill(page, fields) {
  await page.evaluate((fields) => {
    for (const [id, value] of Object.entries(fields)) {
      const field = document.getElementById(id);
      if (!(field instanceof HTMLInputElement)) throw new Error(`Missing input: ${id}`);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, fields);
}
async function screenshot(page, name) {
  // Screenshots are only taken before signup or after verification; never of code/password forms.
  await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: false });
}
async function enter(page, role) {
  await page.waitForSelector(`[data-testid="demo-enter-${role}"]`);
  await page.click(`[data-testid="demo-enter-${role}"]`);
  await page.waitForSelector('[data-testid="signed-in-identity"]');
}
try {
  const chrome = process.env.QA_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
  browser = await puppeteer.launch({ executablePath: chrome, headless: true,
    defaultViewport: { width: 1440, height: 1000 }, protocolTimeout: 60_000 });
  stage = "public guide";
  const gc = await fresh("#/demo");
  await gc.page.waitForSelector('[data-testid="demo-access-page"]');
  check("public guide has three demo role controls", await gc.page.$$eval('[data-testid^="demo-enter-"]', (els) => els.length === 3));
  await screenshot(gc.page, "judge-guide-desktop");
  await gc.page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  check("guide fits a narrow mobile viewport", await gc.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await clickText(gc.page, "Choose a demo role →");
  await gc.page.waitForFunction(() => {
    const roles = document.getElementById("choose-demo-role");
    return document.activeElement === roles && roles.getBoundingClientRect().top >= 0 &&
      roles.getBoundingClientRect().top < innerHeight;
  });
  check("mobile role jump scrolls and moves keyboard focus to the role controls", true);
  await screenshot(gc.page, "judge-guide-mobile");
  await gc.page.setViewport({ width: 1440, height: 1000 });
  await enter(gc.page, "gc");
  await gc.page.waitForSelector('[data-testid="judge-demo-page"]');
  await gc.page.waitForFunction(() => location.hash.startsWith("#/judge-demo/"));
  check("GC guide entry signs in and pins a run-specific URL", true);
  if (concurrency) {
    stage = "two concurrent judge contexts";
    await gc.page.waitForSelector('[data-testid="judge-demo-agreement"]');
    const pinned = new URL(gc.page.url()).hash;
    const prior = await gc.page.$eval('[data-testid="judge-demo-agreement"]', (el) => el.textContent);
    const other = await fresh("#/demo");
    concurrencyPage = other.page;
    await enter(other.page, "gc");
    await other.page.waitForSelector('[data-testid="judge-demo-start"]');
    await other.page.click('[data-testid="judge-demo-start"]');
    await other.page.waitForFunction((prior) =>
      document.querySelector('[data-testid="judge-demo-agreement"]')?.textContent !== prior &&
      document.querySelector('[data-testid="judge-demo-phase"]')?.textContent.includes("approve the Mobilization funding"), {}, prior);
    const otherHash = new URL(other.page.url()).hash;
    check("second judge creates a distinct run without funding", otherHash.startsWith("#/judge-demo/") && otherHash !== pinned);
    await gc.page.reload({ waitUntil: "domcontentloaded" });
    await gc.page.waitForFunction((prior) => document.querySelector('[data-testid="judge-demo-agreement"]')?.textContent === prior, {}, prior);
    check("first judge keeps the same run after another judge starts and a reload", new URL(gc.page.url()).hash === pinned);
    await other.context.close();
    report.concurrencyNote = "One new demo agreement was executed but remained UNFUNDED; no checkout, capture, payout or invoice was submitted.";
  }
  await gc.page.goto(`${site}/#/judge-demo/${proofRun}`, { waitUntil: "domcontentloaded" });
  await gc.page.waitForFunction(() => document.querySelector('[data-testid="judge-demo-agreement"]')?.textContent.includes("20261101-02"));
  await gc.page.reload({ waitUntil: "domcontentloaded" });
  await gc.page.waitForFunction(() => document.querySelector('[data-testid="judge-demo-agreement"]')?.textContent.includes("20261101-02"));
  check("run bookmark survives a full reload", true);
  await gc.page.waitForFunction(() => document.querySelector('[data-testid="judge-demo-step-owner_pays"]')?.dataset.status === "done");
  check("settled run still shows actual Owner payment", true);
  check("history exposes independently settled run", await gc.page.$eval('select[aria-label="Demo run"]', (el) =>
    [...el.options].some((o) => o.text.includes("20261101-02") && o.text.includes("Pay apps paid") && o.text.includes("Owner paid"))));
  await screenshot(gc.page, "judge-settled-run");
  stage = "invitation recipient correction";
  await gc.page.goto(`${site}/#/people`, { waitUntil: "domcontentloaded" });
  await gc.page.waitForSelector('a[href^="#/people/"]');
  await gc.page.click('a[href^="#/people/"]');
  await gc.page.waitForFunction(() => [...document.querySelectorAll("button")].some((el) => el.textContent.trim() === "Invite subcontractor"));
  await clickText(gc.page, "Invite subcontractor");
  await gc.page.waitForFunction(() => document.querySelector("#invite-vendor")?.options.length >= 4);
  const vendorIds = await gc.page.$eval("#invite-vendor", (select) =>
    [...select.options].filter((o) => o.value && !o.text.startsWith("+")).slice(0, 2).map((o) => o.value));
  await gc.page.select("#invite-vendor", vendorIds[0]);
  await fill(gc.page, { "invite-email": "qa-override@example.invalid" });
  await gc.page.select("#invite-vendor", vendorIds[1]);
  check("correcting selected vendor replaces the prior recipient", await gc.page.$eval("#invite-email", (el) => Boolean(el.value) && el.value !== "qa-override@example.invalid"));
  const newVendor = await gc.page.$eval("#invite-vendor", (select) => [...select.options].find((o) => o.text.startsWith("+")).value);
  await gc.page.select("#invite-vendor", newVendor);
  check("new vendor choice clears the prior vendor recipient", await gc.page.$eval("#invite-email", (el) => el.value === ""));
  // Navigate away without submitting an invitation or sending mail.
  await gc.page.goto(`${site}/#/demo`, { waitUntil: "domcontentloaded" });
  await gc.page.waitForFunction(() => document.body.innerText.includes("Your current account will not be replaced"));
  check("authenticated guide protects current identity", await gc.page.$('[data-testid="demo-enter-owner"]') === null);
  await gc.context.close();
  for (const role of ["sub", "owner"]) {
    stage = `guide ${role} entry`;
    const session = await fresh("#/demo");
    await enter(session.page, role);
    check(`${role} entry reaches its authorized workspace`, await session.page.evaluate((role) =>
      location.hash === (role === "sub" ? "#/portal" : "#/projects"), role));
    await screenshot(session.page, `judge-${role}-entry`);
    await session.context.close();
  }

  if (signup) {
    stage = "owned-inbox signup preflight";
    mcp = new Client({ name: "tradepulse-recovery-user-qa", version: "1.0.0" });
    await mcp.connect(new StdioClientTransport({ command: process.execPath,
      args: [path.join(root, "node_modules/convex/bin/main.js"), "mcp", "start", "--project-dir", root,
        "--deployment", deployment, "--disable-tools", "data,envList,envSet,envRemove,run,logs,tables,insights,functionSpec"],
      stderr: "ignore" }));
    const status = unpack(await mcp.callTool({ name: "status", arguments: { projectDir: root } }));
    const target = status.availableDeployments.find((d) => d.url === `https://${deployment}.convex.cloud`);
    if (!target || target.kind === "prod") throw new Error("Recovery dev target could not be verified.");
    selector = target.deploymentSelector;
    check("server confirms PayPal sandbox", (await call("envGet", { name: "PAYPAL_ENV" })).value === "sandbox");
    const apiKey = (await call("envGet", { name: "AGENTMAIL_API_KEY" })).value;
    if (!apiKey) throw new Error("AgentMail credential is missing.");
    const inbox = "dullstreet57@agentmail.to";
    const exists = await readonly(`return Boolean(await ctx.db.query("users").withIndex("email", q => q.eq("email", ${JSON.stringify(inbox)})).first());`);
    check("signup will not overwrite any existing account", !exists);
    const request = async (pathname) => {
      const response = await fetch(`https://api.agentmail.to/v0${pathname}`, {
        headers: { Authorization: `Bearer ${apiKey}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Owned-inbox API returned HTTP ${response.status}; response suppressed.`);
      return response.json();
    };
    await request(`/inboxes/${encodeURIComponent(inbox)}`);
    const createdAt = new Date().toISOString();
    const marker = `Recovery QA GC ${Date.now()}`;
    const password = `Recovery!${randomBytes(20).toString("hex")}Aa9`;
    const session = await fresh();
    await session.page.waitForSelector('input[type="password"]');
    await clickText(session.page, "Create account");
    await fill(session.page, { "signup-name": "Recovery QA User", "signup-email": inbox, "signup-password": password });
    stage = "normal signup and live verification email";
    await clickText(session.page, "Create account");
    await session.page.waitForSelector("#verify-code");
    check("signup requires email verification", true);
    let code;
    let messageId;
    const deadline = Date.now() + 90_000;
    while (!code && Date.now() < deadline) {
      const query = new URLSearchParams({ after: createdAt, limit: "10", subject: "TradePulse Pay: verify your email", to: inbox });
      const messages = await request(`/inboxes/${encodeURIComponent(inbox)}/messages?${query}`);
      const message = messages.messages?.find((m) => m.subject === "TradePulse Pay: verify your email" &&
        String(m.from).includes("cleverneed464@agentmail.to") && m.to?.some((to) => to.includes(inbox)));
      if (message) {
        const full = await request(`/inboxes/${encodeURIComponent(inbox)}/messages/${encodeURIComponent(message.message_id)}`);
        code = /\b\d{8}\b/.exec(full.extracted_text || full.text || "")?.[0];
        messageId = message.message_id;
      }
      if (!code) await delay(2000);
    }
    check("real AgentMail verification email arrived", Boolean(code));
    await fill(session.page, { "verify-code": code });
    code = undefined;
    await clickText(session.page, "Verify email");
    await session.page.waitForSelector("#company-name");
    check("emailed code verifies and opens company onboarding", true);
    stage = "new real GC company";
    await fill(session.page, { "company-name": marker, "company-line1": "123 Test Street", "company-city": "San Jose",
      "company-zip": "95131", "company-phone": "2025550100" });
    await session.page.select("#company-state", "CA");
    await clickText(session.page, "Create company");
    await session.page.waitForSelector('[data-testid="active-company-name"]');
    check("normal onboarding creates a separate GC company", await session.page.$eval('[data-testid="active-company-name"]', (el, marker) => el.textContent === marker, marker));
    await session.page.goto(`${site}/#/all-projects/new`, { waitUntil: "domcontentloaded" });
    await session.page.waitForSelector("#new-project-title");
    stage = "new project and manual package";
    const date = new Date();
    date.setDate(date.getDate() + 7);
    const start = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    await fill(session.page, { "new-project-title": `${marker} Project`, "new-project-owner": "Sandbox Project Owner",
      "new-project-line1": "123 Test Street", "new-project-city": "San Jose", "new-project-zip": "95131",
      "new-project-contract": "250000.00", "new-project-billing-day": "15", "new-project-start": start });
    await session.page.select("#new-project-state", "CA");
    await clickText(session.page, "Create project and continue");
    await session.page.waitForFunction(() => document.body.innerText.includes("Step 2 of 2"));
    check("fresh GC creates a project through the wizard", true);
    await clickText(session.page, "Add a package manually");
    await session.page.waitForSelector("#pkg-csi");
    const defaultDeadline = await session.page.$eval("#pkg-deadline", (el) => el.value);
    check("manual package defaults to a future deadline", defaultDeadline > start, { defaultDeadline });
    await fill(session.page, { "pkg-csi": "26 00 00", "pkg-trade": "QA Electrical", "pkg-budget": "55000.00" });
    await clickText(session.page, "Add package");
    await session.page.waitForFunction(() => [...document.querySelectorAll("h3,h4,span,p,td")].some((el) => el.textContent === "QA Electrical"));
    check("fresh GC adds a valid manual package", true);
    await screenshot(session.page, "fresh-gc-project");
    stage = "signed webhook delivery evidence";
    let mailProof;
    const proofDeadline = Date.now() + 60_000;
    do {
      mailProof = await readonly(`
        const id = ${JSON.stringify(messageId)};
        const outbound = await ctx.db.query("emailOutbox").withIndex("by_agentmailMessageId", q => q.eq("agentmailMessageId", id)).first();
        const inbound = await ctx.db.query("inboundEmails").withIndex("by_messageId", q => q.eq("messageId", id)).first();
        return { outboundStatus: outbound?.status ?? null, deliveryEvent: outbound?.deliveryEvent ?? null,
          inboundReceived: Boolean(inbound), inboundRouting: inbound?.routing ?? null,
          inboundHasTenant: Boolean(inbound?.companyId || inbound?.projectId) };`);
      if (mailProof.inboundReceived && mailProof.deliveryEvent === "delivered") break;
      await delay(2000);
    } while (Date.now() < proofDeadline);
    report.mailProof = mailProof;
    check("real signed AgentMail inbound webhook ingested the message", mailProof.inboundReceived);
    check("unrouted auth mail acquired no tenant scope", mailProof.inboundRouting === "unrouted" && !mailProof.inboundHasTenant);
    check("delivery webhook confirmed the real send", mailProof.outboundStatus === "sent" && mailProof.deliveryEvent === "delivered");
    await clickText(session.page, "Sign out");
    await session.context.close();
  }
} catch (error) {
  if (concurrencyPage && !concurrencyPage.isClosed()) {
    try {
      report.concurrencyState = await concurrencyPage.evaluate(() => ({
        agreement: document.querySelector('[data-testid="judge-demo-agreement"]')?.textContent,
        phase: document.querySelector('[data-testid="judge-demo-phase"]')?.textContent,
        errorVisible: Boolean(document.querySelector('[data-testid="judge-demo-error"]')?.textContent),
        hash: location.hash,
      }));
      report.concurrencyState = JSON.parse(JSON.stringify(report.concurrencyState), (_key, value) => typeof value === "string"
        ? value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]").replace(/Bearer\s+\S+|\beyJ\S+/g, "[redacted]") : value);
    } catch { /* No browser credentials or response bodies are read for diagnostics. */ }
  }
  // No arbitrary provider/browser payloads, email bodies, codes or credentials in diagnostics.
  report.errors.push({ stage, errorType: error?.constructor?.name, message: error instanceof Error && /^(Check failed:|Missing enabled control:|Only isolated|Unknown flag|Owned-inbox API returned HTTP|Official Convex MCP failed)/.test(error.message)
    ? error.message : "Journey failed; raw error suppressed to protect account and inbox data." });
  process.exitCode = 1;
} finally {
  await browser?.close();
  await mcp?.close();
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${directory}`);
  console.log(JSON.stringify(report, null, 2));
}
