/**
 * Recovery-dev only, fresh isolated contexts. Read-only inspection: the only remote writes are the
 * ordinary demo sign-ins and cancelling the guided-run confirmation (which creates nothing).
 * Screenshots mask non-demo addresses. No workflow, provider, payment or draft write is performed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = "https://cheery-axolotl-689.convex.site";
if (
  process.env.CONVEX_DEPLOY_KEY ||
  !/^CONVEX_DEPLOYMENT=dev:cheery-axolotl-689(?:\s|$)/m.test(fs.readFileSync(path.join(root, ".env.local"), "utf8"))
) {
  throw new Error("Recovery dev only.");
}
const directory = path.join(root, "evidence", `audit-v2-browser-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(directory, { recursive: true });
const report = { target: site, mode: "Read-only V2 audit retest; demo authentication and a cancelled consent dialog only", checks: [], errors: [] };
const check = (name, passed, detail = {}) => {
  report.checks.push({ name, passed: Boolean(passed), ...detail });
  if (!passed) throw new Error(`Check failed: ${name}`);
};

const agreement = "jn78x0j5xeh7q9gb55p26r7pdh8hdmjx";
const widths = [320, 360, 390, 768, 1440];
const expectedTotals = {
  contractSumCents: "$55,000.00",
  billedCents: "$2,288.00",
  paidCents: "$2,288.00",
  retainageHeldCents: "$0.00",
  balanceCents: "$52,712.00",
  fundedCents: "$3,212.00",
  capturedCents: "$2,288.00",
  capturedNotPaidCents: "$0.00",
  retainageReleasedCents: "$228.80",
  changeOrdersInvoicedCents: "$0.00",
  changeOrdersPaidCents: "$1,850.00",
};

const browser = await puppeteer.launch({
  executablePath: process.env.QA_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  defaultViewport: { width: 1440, height: 1000 },
  protocolTimeout: 60000,
});

async function errorOf(promise) {
  try {
    await promise;
  } catch (error) {
    return { code: (error?.data ?? {}).code ?? null, message: String(error?.message ?? error) };
  }
  return null;
}

async function open(page, hash, selector) {
  await page.goto(`${site}/${hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(selector, { timeout: 45000 });
}

async function signIn(role) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", () => report.errors.push({ role, kind: "pageerror" }));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    report.errors.push({
      role,
      kind: "console-error",
      text: message.text().replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]").slice(0, 200),
    });
  });
  await open(page, "#/demo", `[data-testid="demo-enter-${role}"]`);
  await page.click(`[data-testid="demo-enter-${role}"]`);
  await page.waitForSelector('[data-testid="signed-in-identity"]', { timeout: 45000 });
  return { context, page };
}

async function shot(page, name) {
  await page.evaluate(() => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      if (["SCRIPT", "STYLE"].includes(walk.currentNode.parentElement?.tagName)) continue;
      walk.currentNode.textContent = walk.currentNode.textContent.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) =>
        email.endsWith("@demo.tradepulse") || email.endsWith("@example.com") ? email : "[sandbox email]",
      );
    }
  });
  await page.screenshot({ path: path.join(directory, name), fullPage: false });
}

async function layout(page, role, hash, selector) {
  await open(page, hash, selector);
  check(`${role} ${hash} has one main heading`, await page.$$eval("main h1", (rows) => rows.length === 1));
  for (const width of widths) {
    await page.setViewport({ width, height: 900 });
    await page.waitForFunction(() => document.fonts.status === "loaded");
    const dimensions = await page.evaluate(() => ({
      width: innerWidth,
      document: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll("body *")]
        .filter(
          (el) =>
            el.getBoundingClientRect().right > innerWidth + 1 &&
            (!el.closest(".table-scroll,.overflow-x-auto") ||
              el.closest(".table-scroll,.overflow-x-auto").getBoundingClientRect().right > innerWidth + 1),
        )
        .slice(0, 12)
        .map((el) => ({ tag: el.tagName, class: String(el.className).slice(0, 120), width: Math.round(el.getBoundingClientRect().width) })),
    }));
    check(`${role} ${hash} fits ${width}px`, dimensions.document <= dimensions.width + 1, dimensions);
  }
  await page.setViewport({ width: 1440, height: 1000 });
}

const bodyText = (page) => page.evaluate(() => document.body.innerText);

try {
  const gc = await signIn("gc");
  const owner = await signIn("owner");
  const sub = await signIn("sub");

  // Billing agents: no add form, no revoke, masked shared inboxes, table scrolls on a phone.
  await open(gc.page, "#/billing-agents", '[data-testid="agent-links"]');
  await gc.page.waitForFunction(() => document.querySelectorAll('[data-testid="agent-links"] tbody tr').length >= 1, { timeout: 45000 });
  const agentText = await bodyText(gc.page);
  check("billing agents table is populated", true);
  check("demo hides the add-agent form", (await errorOf(gc.page.waitForSelector('form button[type="submit"]', { timeout: 1500 }))) !== null || !agentText.includes("Add agent"));
  check("demo hides every revoke control", (await gc.page.$$eval("button", (rows) => rows.filter((b) => /^Revoke/.test(b.textContent.trim())).length)) === 0);
  check("active demo links are labeled read-only, not revoked", agentText.includes("Active · read-only") && !agentText.includes("Revoked"));
  check("shared agent inboxes are masked", !agentText.includes("boldlevel182") && agentText.includes("[demo inbox]@"));
  check("demo explains how to try writes", agentText.includes("read-only") && agentText.includes("Fresh guided runs reuse the configured demo link"));
  await layout(gc.page, "GC", "#/billing-agents", '[data-testid="agent-links"]');
  await gc.page.setViewport({ width: 360, height: 900 });
  await shot(gc.page, "gc-billing-agents-360.png");
  await gc.page.setViewport({ width: 1440, height: 1000 });

  // Vendors: the directory stays readable, actions are replaced by a read-only note.
  await open(gc.page, "#/vendors", "main h1");
  await gc.page.waitForFunction(() => document.body.innerText.includes("Shared demo · read-only"), { timeout: 45000 });
  const vendorText = await bodyText(gc.page);
  check("vendors are readable but not writable in the shared demo", !vendorText.includes("Add vendor") && !vendorText.includes("Import CSV"));
  await layout(gc.page, "GC", "#/vendors", "main h1");

  // Company settings and people keep their read-only note.
  await open(gc.page, "#/company", "main h1");
  check("company settings declares the shared demo read-only", (await bodyText(gc.page)).includes("read-only"));
  await open(gc.page, "#/people", "main h1");
  const enabledWrites = await gc.page.$$eval("button", (rows) =>
    rows.filter((b) => !b.disabled && /^(Invite|Remove)/i.test(b.textContent.trim())).map((b) => b.textContent.trim()),
  );
  check("people page hides invites and removals", enabledWrites.length === 0, { enabledWrites });

  // Procurement still fits a 320 px phone.
  await layout(gc.page, "GC", "#/procurement", "main h1");

  // Guided run: a detailed consent dialog, cancelled without creating anything.
  await open(gc.page, "#/judge-demo", '[data-testid="judge-demo-agreement"]');
  await gc.page.waitForFunction(
    () => document.querySelector('[data-testid="judge-demo-agreement"]')?.textContent === "A401-DEMO-PAY-20261101-02",
    { timeout: 45000 },
  );
  check("guided demo still defaults to the preserved reference", true);
  check("the reference hides Continue", (await gc.page.$('[data-testid="judge-demo-continue"]')) === null);
  const runsBefore = await gc.page.$$eval('[data-testid="judge-demo-run"]', (rows) => rows.length);
  await gc.page.click('[data-testid="judge-demo-start"]');
  await gc.page.waitForSelector('[role="alertdialog"]', { timeout: 15000 });
  const dialog = await gc.page.$eval('[role="alertdialog"]', (el) => el.innerText);
  check("consent names the new synthetic subcontract", dialog.includes("Start a new sandbox demo run?") && dialog.includes("$55,000.00"));
  check("consent names the sandbox authorization", dialog.includes("$5,500"));
  check("consent names the Owner invoice", dialog.includes("$1,850"));
  check("consent names provider credits", dialog.includes("Mistral") && dialog.includes("KERNEL") && dialog.includes("PayPal sandbox"));
  check("consent states the per-account limit", dialog.includes("3 new guided runs per hour"));
  check("consent states Cancel creates nothing", dialog.includes("Cancel creates nothing"));
  await gc.page.evaluate(() => [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.trim() === "Cancel").click());
  await gc.page.waitForFunction(() => !document.querySelector('[role="alertdialog"]'), { timeout: 15000 });
  check("cancelling creates nothing", (await gc.page.$$eval('[data-testid="judge-demo-run"]', (rows) => rows.length)) === runsBefore);
  await layout(gc.page, "GC", "#/judge-demo", '[data-testid="judge-demo-agreement"]');

  // Inbox: provenance and a copyable payout batch.
  await open(gc.page, "#/inbox", '[data-testid="inbox-entry"]');
  await gc.page.evaluate(() => {
    for (const selector of ['[data-testid="inbox-history"]', '[data-testid="inbox-commercial"]']) {
      const disclosure = document.querySelector(selector);
      if (disclosure && !disclosure.open) disclosure.querySelector("summary")?.click();
    }
  });
  await gc.page.waitForFunction(() => document.body.innerText.includes("PayPal payout batch"), { timeout: 45000 });
  const inboxText = await bodyText(gc.page);
  check("inbox payment names its recorded provenance", inboxText.includes("not a live PayPal query"));
  check("inbox exposes a copy control for the batch", (await gc.page.$$eval('[data-testid="inbox-entry"] button', (rows) => rows.filter((b) => /^Copy /.test(b.getAttribute("aria-label") ?? "")).length)) >= 1);
  await layout(gc.page, "GC", "#/inbox", '[data-testid="inbox-entry"]');

  // Ledger: the preserved financial truth, reconciled and labeled.
  await open(gc.page, `#/payments/${agreement}`, '[data-testid="ledger-totals"]');
  check("preserved reference totals are unchanged", await gc.page.evaluate((expected) =>
    Object.entries(expected).every(([key, value]) => document.querySelector(`[data-testid="ledger-${key}"]`)?.textContent.trim() === value), expectedTotals));
  await gc.page.waitForSelector('[data-testid="ledger-reconciliation"]', { timeout: 45000 });
  const ledgerText = await bodyText(gc.page);
  check("ledger labels prime change-order income as separate", ledgerText.includes("Owner prime change-order income belongs to the project, not this subcontract's scope or balance."));
  check("ledger states when statuses were recorded", ledgerText.includes("recorded from PayPal webhooks/API responses at the time shown"));
  check("retainage release does not claim closeout", ledgerText.includes("A demo release does not certify project closeout."));
  await gc.page.waitForSelector('[data-testid="funding-tranches"]', { timeout: 45000 });
  const receiptIds = ["0WV193651L210315U", "94G95136J6812154U", "4HL52442UH4760109", "8P8CUQQA4RBV8", "ZFJ6GVLK6C44U", "HQ6GL4NYM9D32"];
  const missingIds = await gc.page.evaluate((ids) => ids.filter((id) => !document.body.innerText.includes(id)), receiptIds);
  check("ledger exposes provider receipt IDs", missingIds.length === 0, { missingIds });
  check("ledger offers copy controls", (await gc.page.$$eval("button", (rows) => rows.filter((b) => /^Copy /.test(b.getAttribute("aria-label") ?? "")).length)) >= 5);
  await layout(gc.page, "GC", `#/payments/${agreement}`, '[data-testid="ledger-totals"]');
  await gc.page.setViewport({ width: 360, height: 900 });
  await shot(gc.page, "gc-reference-ledger-360.png");
  await gc.page.setViewport({ width: 1440, height: 1000 });

  // Owner reports: no false subcontract zeros, and change orders open on the active project.
  await open(owner.page, "#/dashboard", "main h1");
  await owner.page.waitForFunction(() => document.body.innerText.includes("Owner change orders paid"), { timeout: 45000 });
  const ownerText = await bodyText(owner.page);
  check("Owner heading is Reports", (await owner.page.$eval("main h1", (el) => el.textContent)) === "Reports");
  check("Owner header omits subcontract measures", !ownerText.includes("subcontract payouts"));
  check("Owner header explains the omission", ownerText.includes("Subcontract measures are not shared with the Owner."));
  check("Owner change-order income is the stored Lopez sum", ownerText.includes("$1,200.00") && !ownerText.includes("$1,850.00"));
  await open(owner.page, "#/change-orders", '[data-testid="prime-change-orders"]');
  await owner.page.waitForFunction(() => document.body.innerText.includes("PCO #"), { timeout: 45000 });
  const picker = await owner.page.$eval('[data-testid="change-orders-project"]', (el) => ({
    selected: el.selectedOptions[0]?.textContent ?? "",
    options: el.options.length,
    groups: [...el.querySelectorAll("optgroup")].map((group) => ({ label: group.label, count: group.children.length })),
  }));
  check("Owner change orders default to the residential Lopez job", /Lopez Kitchen Remodel/.test(picker.selected), picker);
  check(
    "Owner change orders keep every commercial run under one native optgroup",
    picker.groups.length === 1 && picker.groups[0].label === "Commercial reference job" && picker.groups[0].count === picker.options - 1,
    picker,
  );
  check("prime change orders are labeled PCO", (await bodyText(owner.page)).includes("PCO #"));
  await layout(owner.page, "OWNER", "#/change-orders", '[data-testid="prime-change-orders"]');
  await open(owner.page, `#/payments/${agreement}`, "main");
  await owner.page.waitForFunction(() => !document.body.innerText.includes("Loading"), { timeout: 45000 });
  const ownerLedgerText = await bodyText(owner.page);
  check("Owner ledger read stays quiet", !ownerLedgerText.includes("ConvexError") && !ownerLedgerText.includes("Not authenticated"));

  // Sub portal: drafts say created, not submitted.
  await open(sub.page, "#/portal", '[data-testid="sub-payapp-row"]');
  await sub.page.waitForFunction(() => document.querySelectorAll('[data-testid="sub-payapp-row"]').length >= 1, { timeout: 45000 });
  const subText = await bodyText(sub.page);
  check("draft rows distinguish created from submitted", subText.includes("not submitted") || subText.includes("Unsubmitted draft"));
  await layout(sub.page, "SUB", "#/portal", '[data-testid="sub-payapp-row"]');
  await sub.page.setViewport({ width: 360, height: 900 });
  await shot(sub.page, "sub-portal-360.png");
  await sub.page.setViewport({ width: 1440, height: 1000 });

  check("no unexpected console or page errors", report.errors.length === 0, { errors: report.errors });
} catch (error) {
  report.failure = String(error?.message ?? error);
} finally {
  report.passed = report.checks.filter((c) => c.passed).length;
  report.total = report.checks.length;
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, passed: report.passed, total: report.total, failure: report.failure ?? null, errors: report.errors.length }));
  await browser.close();
}
if (report.failure) process.exitCode = 1;
