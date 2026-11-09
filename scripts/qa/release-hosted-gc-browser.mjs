import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT as root, launchBrowser, attachDiagnostics, delay } from "./lib.mjs";

/**
 * Hosted release proof for the judge path's GC leg (VAL-CROSS-001 / VAL-CROSS-003 / VAL-CROSS-004).
 *
 * At 1440x900 and 390x844 it signs in with the demo GC seat and walks the real app by clicking:
 * #/demo -> #/inbox money strip -> the Lopez project page -> the settled Ortiz pay app -> the
 * agreement ledger -> a commercial reference page. It records the strip values, the project
 * identity, the read-only notice and any console/network failure, and it fails on a dead "#" or
 * "#/home" link. Once, at desktop width, it also opens the pinned Rosendin reference run (the
 * "Commercial reference job" badge), then starts a fresh guided run and reports its run id without
 * waiting for the PayPal funding step.
 *
 *   node scripts/qa/release-hosted-gc-browser.mjs --url https://tradepulse-pay.pages.dev
 */
const site = process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1] : "https://tradepulse-pay.pages.dev";
if (!/^(https:\/\/[a-z0-9.-]+(?::\d+)?|http:\/\/localhost(?::\d+)?)$/i.test(site)) throw new Error("--url must be an https origin or http://localhost:<port>.");
const outDir = process.argv.includes("--out")
  ? path.resolve(process.argv[process.argv.indexOf("--out") + 1])
  : path.join(root, "evidence", `release-hosted-gc-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(outDir, { recursive: true });

const seatsSource = fs.readFileSync(path.join(root, "src", "auth", "demoSeats.ts"), "utf8");
const settledPayAppId = /SETTLED_LOPEZ_PAY_APP_ID = "([^"]+)"/.exec(seatsSource)?.[1];
if (!settledPayAppId) throw new Error("SETTLED_LOPEZ_PAY_APP_ID not found in src/auth/demoSeats.ts");
const PINNED_REFERENCE_RUN = "nx74k1sdcnsmqzvkr97kf0ts598hch6p";
const startFreshRun = !process.argv.includes("--no-fresh-run");
const report = { target: site, settledPayAppId, checks: [], measurements: [], diagnostics: [], guidedDemo: null };

const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok, detail: String(detail) });
  if (!ok) console.log(`FAIL ${name} :: ${detail}`);
};

/** Click the app's own link (opening a closed disclosure when the link lives inside one). */
async function clickHref(page, href) {
  const clicked = await page.evaluate((target) => {
    const links = [...document.querySelectorAll(`a[href="${target}"]`)];
    const link = links.find((a) => a.getBoundingClientRect().height > 0) ?? links[0];
    if (!link) return false;
    const details = link.closest("details");
    if (details && !details.open) details.open = true;
    link.click();
    return true;
  }, href);
  if (!clicked) throw new Error(`No link in the app for ${href}`);
  await delay(200);
}

async function clickTextLink(page, text) {
  const clicked = await page.evaluate((needle) => {
    const link = [...document.querySelectorAll("a[href]")].find((a) => (a.textContent ?? "").includes(needle));
    if (!link) return null;
    link.click();
    return link.getAttribute("href");
  }, text);
  if (!clicked) throw new Error(`No link whose text contains ${text}`);
  await delay(200);
  return clicked;
}

/** Wait until the strip's query has resolved (the placeholder is "Loading the money…"). */
async function waitForMoney(page) {
  await page.waitForFunction(
    () => {
      const value = document.querySelector('[data-testid="project-money-collected"]')?.innerText?.trim() ?? "";
      return /^\$[\d,]+\.\d{2}$/.test(value);
    },
    { timeout: 60000 },
  );
}

async function readStrip(page) {
  return await page.evaluate(() => {
    const rootEl = document.querySelector('[data-testid="project-money-strip"]');
    const value = (id) => document.querySelector(`[data-testid="${id}"]`)?.innerText?.trim() ?? null;
    return {
      present: rootEl !== null,
      text: rootEl?.innerText ?? "",
      labels: [...(rootEl?.querySelectorAll("dt") ?? [])].map((dt) => dt.innerText.trim()),
      collected: value("project-money-collected"),
      paidSubs: value("project-money-paid-subs"),
      retainage: value("project-money-retainage"),
      owed: value("project-money-owed"),
      top: rootEl ? Math.round(rootEl.getBoundingClientRect().top) : null,
    };
  });
}

async function readPage(page) {
  return await page.evaluate(() => {
    const main = document.querySelector("main#workspace-main") ?? document.querySelector("main");
    const links = [...document.querySelectorAll("a[href]")].map((a) => ({
      text: (a.textContent ?? "").trim().slice(0, 80),
      href: a.getAttribute("href"),
    }));
    return {
      hash: location.hash,
      text: main?.innerText ?? "",
      links,
      deadLinks: links.filter((l) => l.href === "#" || l.href === "" || l.href === "#/home"),
      notFound: /Not found\./.test(document.body.innerText),
      identity: document.querySelector('[data-testid="signed-in-identity"]')?.textContent?.trim() ?? "",
      strip: document.querySelector('[data-testid="project-money-strip"]') !== null,
      readOnlyNotice: document.querySelector('[data-testid="read-only-reference"]')?.innerText ?? null,
      badge: document.querySelector('[data-testid="commercial-reference-badge"]')?.innerText ?? null,
      newDraw: document.querySelector('[data-testid="owner-pay-app-new"]') !== null,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
}

const widths = [
  [1440, 900],
  [390, 844],
];
for (const [width, height] of widths) {
  const tag = `[${width}]`;
  const { browser } = await launchBrowser(width, height);
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);
  const diagnostics = attachDiagnostics(page);
  try {
    // ---- #/demo -> GC seat ----------------------------------------------------------------
    await page.goto(`${site}/#/demo`, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector('[data-testid="demo-access-page"]');
    const demoLinks = await readPage(page);
    check(`${tag} demo page has no dead hash links`, demoLinks.deadLinks.length === 0, JSON.stringify(demoLinks.deadLinks));
    await page.click('[data-testid="demo-enter-gc"]');
    await page.waitForSelector('[data-testid="signed-in-identity"]', { timeout: 60000 });
    await page.waitForFunction(() => location.hash === "#/inbox", { timeout: 60000 });
    await page.waitForSelector('[data-testid="project-money-strip"]', { timeout: 60000 });
    await page.waitForSelector('[data-testid="inbox-residential-decision"]', { timeout: 60000 });
    await waitForMoney(page);
    await delay(300);
    const inbox = await readPage(page);
    const inboxStrip = await readStrip(page);
    report.measurements.push({ screen: "inbox", width, hash: inbox.hash, identity: inbox.identity, strip: inboxStrip });
    check(`${tag} GC seat lands on #/inbox`, inbox.hash === "#/inbox", inbox.hash);
    check(`${tag} GC identity chrome names Bayview Remodeling`, /bayview remodeling/i.test(inbox.identity), inbox.identity);
    check(`${tag} inbox strip shows four money cells`, inboxStrip.labels.length === 4, JSON.stringify(inboxStrip.labels));
    check(`${tag} inbox strip uses the neutral portfolio label`, inboxStrip.labels[0] === "Collected from owners", JSON.stringify(inboxStrip.labels));
    check(`${tag} inbox strip renders four dollar values`, [inboxStrip.collected, inboxStrip.paidSubs, inboxStrip.retainage, inboxStrip.owed].every((v) => /^\$[\d,]+\.\d{2}$/.test(v ?? "")), JSON.stringify(inboxStrip));
    check(`${tag} GC home shows the residential decision`, /residential draw · settled on the sandbox/i.test(inbox.text) && /ortiz plumbing/i.test(inbox.text), inbox.text.slice(0, 300));
    await page.screenshot({ path: path.join(outDir, `hosted-inbox-${width}.png`), fullPage: false });

    // ---- GC home -> Projects -> Lopez project page ---------------------------------------
    await clickHref(page, "#/all-projects");
    await page.waitForFunction(() => location.hash === "#/all-projects", { timeout: 60000 });
    await page.waitForSelector("main", { timeout: 30000 });
    await page.waitForFunction(
      () => [...document.querySelectorAll("a[href]")].some((a) => (a.textContent ?? "").includes("Lopez Kitchen Remodel")),
      { timeout: 60000 },
    );
    await clickTextLink(page, "Lopez Kitchen Remodel");
    await page.waitForFunction(() => /^#\/all-projects\/[a-z0-9]+$/.test(location.hash), { timeout: 60000 });
    await page.waitForSelector('[data-testid="project-money-strip"]', { timeout: 60000 });
    await waitForMoney(page);
    await delay(300);
    const project = await readPage(page);
    const projectStrip = await readStrip(page);
    const lopezProjectHash = project.hash;
    report.measurements.push({ screen: "lopez-project", width, hash: project.hash, strip: projectStrip, identity: project.identity });
    check(`${tag} Lopez project page is a job route`, /^#\/all-projects\/[a-z0-9]+$/.test(project.hash), project.hash);
    check(`${tag} Lopez page names Bayview Remodeling`, project.text.includes("Bayview Remodeling"), project.text.slice(0, 400));
    check(`${tag} Lopez page names Dana Lopez`, project.text.includes("Dana Lopez"), project.text.slice(0, 400));
    check(`${tag} Lopez page shows $86,500.00`, project.text.includes("$86,500.00"), project.text.slice(0, 600));
    check(`${tag} Lopez page shows the money strip`, projectStrip.present);
    check(`${tag} Lopez strip uses the homeowner label`, projectStrip.labels[0] === "Collected from homeowner", JSON.stringify(projectStrip.labels));
    check(`${tag} Lopez strip paid to subs is $3,800.00`, projectStrip.paidSubs === "$3,800.00", String(projectStrip.paidSubs));
    check(`${tag} Lopez strip retainage held is $200.00`, projectStrip.retainage === "$200.00", String(projectStrip.retainage));
    check(`${tag} Lopez strip collected from the homeowner is $3,600.00`, projectStrip.collected === "$3,600.00", String(projectStrip.collected));
    if (width === 1440) check(`${tag} Lopez money strip sits above the fold`, (projectStrip.top ?? 9999) < project.innerHeight, `${projectStrip.top} vs ${project.innerHeight}`);
    check(`${tag} Lopez page shows the read-only reference notice`, /read-only/i.test(project.readOnlyNotice ?? ""), String(project.readOnlyNotice));
    check(`${tag} Lopez page offers no new-draw control`, project.newDraw === false);
    check(`${tag} Lopez page has no dead hash links`, project.deadLinks.length === 0, JSON.stringify(project.deadLinks));
    await page.screenshot({ path: path.join(outDir, `hosted-lopez-${width}.png`), fullPage: false });

    // ---- Lopez -> GC home -> settled Ortiz pay app ---------------------------------------
    await clickHref(page, "#/inbox");
    await page.waitForFunction(() => location.hash === "#/inbox", { timeout: 60000 });
    await page.waitForSelector('[data-testid="inbox-residential-decision-action"]', { timeout: 60000 });
    await page.click('[data-testid="inbox-residential-decision-action"]');
    await page.waitForFunction((want) => location.hash === want, { timeout: 60000 }, `#/pay-apps/${settledPayAppId}`);
    await page.waitForSelector('[data-testid="payapp-money-trail"]', { timeout: 60000 });
    await page.waitForSelector('[data-testid="payment-panel"]', { timeout: 60000 });
    await page.waitForFunction(() => (document.querySelector('[data-testid="payapp-money-trail"]')?.innerText ?? "").includes("$5,400.00"), { timeout: 60000 });
    await delay(300);
    const payApp = await page.evaluate(() => ({
      hash: location.hash,
      trail: document.querySelector('[data-testid="payapp-money-trail"]')?.innerText ?? "",
      payment: document.querySelector('[data-testid="payment-panel"]')?.innerText ?? "",
      text: document.querySelector("main")?.innerText ?? "",
      readOnlyNotice: document.querySelector('[data-testid="read-only-reference"]')?.innerText ?? null,
      links: [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")),
    }));
    report.measurements.push({ screen: "ortiz-pay-app", width, hash: payApp.hash, trail: payApp.trail.slice(0, 600) });
    check(`${tag} GC reaches the settled Ortiz pay app`, payApp.hash === `#/pay-apps/${settledPayAppId}`, payApp.hash);
    for (const amount of ["$5,400.00", "$4,000.00", "$200.00", "$3,800.00"]) {
      check(`${tag} Ortiz money trail shows ${amount}`, `${payApp.trail}\n${payApp.text}`.includes(amount), payApp.trail.slice(0, 300));
    }
    check(`${tag} Ortiz payout receipt shows the PayPal batch`, payApp.payment.includes("PayPal payout batch") && payApp.payment.includes("D5V7XEN5YZH4C"), payApp.payment.slice(0, 300));
    check(`${tag} Ortiz pay app shows the read-only notice`, /read-only/i.test(payApp.readOnlyNotice ?? ""), String(payApp.readOnlyNotice));
    check(`${tag} Ortiz pay app has no dead hash links`, !payApp.links.some((href) => href === "#" || href === "#/home"), JSON.stringify(payApp.links.filter((href) => href === "#" || href === "#/home")));
    await page.screenshot({ path: path.join(outDir, `hosted-ortiz-pay-app-${width}.png`), fullPage: false });

    // ---- pay app -> agreement ledger (the sub path's agreement link resolves) ------------
    await page.click('[data-testid="payapp-view-payments"]');
    await page.waitForFunction(() => location.hash.startsWith("#/payments/"), { timeout: 60000 });
    await page.waitForFunction(() => document.body.innerText.includes("Ortiz Plumbing"), { timeout: 60000 }).catch(() => {});
    await delay(300);
    const ledger = await readPage(page);
    report.measurements.push({ screen: "agreement-ledger", width, hash: ledger.hash });
    check(`${tag} the agreement link resolves to a ledger`, ledger.hash.startsWith("#/payments/") && !ledger.notFound, ledger.hash);
    check(`${tag} the ledger names Ortiz Plumbing`, ledger.text.includes("Ortiz Plumbing"), ledger.text.slice(0, 400));
    check(`${tag} the ledger shows the $9,000.00 contract`, ledger.text.includes("$9,000.00"), ledger.text.slice(0, 600));
    check(`${tag} the ledger has no dead hash links`, ledger.deadLinks.length === 0, JSON.stringify(ledger.deadLinks));
    await page.screenshot({ path: path.join(outDir, `hosted-agreement-ledger-${width}.png`), fullPage: false });

    // ---- a commercial reference page keeps its AIA words and the badge ------------------
    await clickHref(page, "#/all-projects");
    await page.waitForFunction(() => location.hash === "#/all-projects", { timeout: 60000 });
    await page.waitForSelector("main", { timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll('a[href^="#/all-projects/"]').length > 2, { timeout: 60000 });
    const commercialHref = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('a[href^="#/all-projects/"]')].filter((a) => !a.getAttribute("href").endsWith("/all-projects/new"));
      const picked = rows.find((a) => /Sandbox run 20261101-02/i.test(a.textContent ?? "")) ?? rows.find((a) => /Domain Tower B/i.test(a.textContent ?? ""));
      if (picked) picked.click();
      return picked?.getAttribute("href") ?? null;
    });
    check(`${tag} a commercial project is reachable from the GC project list`, typeof commercialHref === "string", String(commercialHref));
    await page.waitForFunction(() => /^#\/all-projects\/[a-z0-9]+$/.test(location.hash) && location.hash !== "#/all-projects/new", { timeout: 60000 });
    await page.waitForSelector('[data-testid="commercial-reference-badge"]', { timeout: 60000 });
    await delay(500);
    const commercial = await readPage(page);
    report.measurements.push({ screen: "commercial-project", width, hash: commercial.hash, badge: commercial.badge });
    check(`${tag} commercial project page shows the Commercial reference job badge`, /commercial reference job/i.test(commercial.badge ?? ""), String(commercial.badge));
    check(`${tag} commercial project keeps commercial wording`, /Collected from owner/.test(commercial.text) && !/Collected from homeowner/.test(commercial.text), commercial.text.slice(0, 600));
    await page.screenshot({ path: path.join(outDir, `hosted-commercial-${width}.png`), fullPage: false });
  } catch (error) {
    report.failure = { width, phase: "gc path", message: error instanceof Error ? error.message : String(error) };
    check(`${tag} GC path completes`, false, report.failure.message);
    await page.screenshot({ path: path.join(outDir, `failure-${width}.png`), fullPage: true }).catch(() => {});
  }

  const ignored = diagnostics.failedRequests.filter((line) => line.includes("/api/sign-in-options") && line.includes("net::ERR_ABORTED"));
  const failed = diagnostics.failedRequests.filter((line) => !ignored.includes(line));
  report.diagnostics.push({
    width,
    consoleErrors: diagnostics.consoleLogs.filter((line) => line.type === "error"),
    pageErrors: diagnostics.pageErrors,
    failedRequests: failed,
    ignoredAborts: ignored,
  });
  check(`${tag} zero page errors`, diagnostics.pageErrors.length === 0, JSON.stringify(diagnostics.pageErrors));
  check(`${tag} zero console errors`, diagnostics.consoleLogs.filter((line) => line.type === "error").length === 0, JSON.stringify(diagnostics.consoleLogs.filter((line) => line.type === "error").slice(0, 3)));
  check(`${tag} zero failed requests`, failed.length === 0, JSON.stringify(failed.slice(0, 3)));
  await browser.close();
}

// ---- guided demo: the pinned reference is labeled, and a fresh run still starts -----------
{
  const { browser } = await launchBrowser(1440, 900);
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  const diagnostics = attachDiagnostics(page);
  const result = { pinnedReferenceBadge: null, freshRunId: null, freshAgreementHref: null };
  try {
    await page.goto(`${site}/#/demo`, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector('[data-testid="demo-enter-gc"]');
    await page.click('[data-testid="demo-enter-gc"]');
    await page.waitForSelector('[data-testid="signed-in-identity"]', { timeout: 60000 });
    await page.waitForFunction(() => location.hash === "#/inbox", { timeout: 60000 });
    await clickHref(page, "#/judge-demo");
    await page.waitForFunction(() => location.hash === "#/judge-demo", { timeout: 60000 });
    await page.waitForSelector('[data-testid="judge-demo-page"]', { timeout: 60000 });

    // Open the pinned Rosendin reference run from the run picker.
    await page.waitForSelector('select[aria-label="Demo run"]', { timeout: 60000 });
    await page.select('select[aria-label="Demo run"]', PINNED_REFERENCE_RUN);
    await page.waitForFunction((want) => location.hash === `#/judge-demo/${want}`, { timeout: 60000 }, PINNED_REFERENCE_RUN);
    await page.waitForSelector('[data-testid="read-only-reference"]', { timeout: 60000 });
    await delay(500);
    result.pinnedReferenceBadge = await page.evaluate(
      () => document.querySelector('[data-testid="commercial-reference-badge"]')?.innerText ?? null,
    );
    check("pinned Rosendin reference run shows the Commercial reference job badge", /commercial reference job/i.test(result.pinnedReferenceBadge ?? ""), String(result.pinnedReferenceBadge));
    await page.screenshot({ path: path.join(outDir, "hosted-guided-demo-reference.png"), fullPage: false });

    // Start a fresh run; it must be a new run, not the frozen reference.
    if (startFreshRun) {
      const beforeHash = await page.evaluate(() => location.hash);
      await page.click('[data-testid="judge-demo-start"]');
      await page.waitForSelector('[role="alertdialog"]', { timeout: 15000 });
      await page.evaluate(() => {
        const button = [...document.querySelectorAll('[role="alertdialog"] button')].find((el) => el.textContent.trim() === "Create sandbox run");
        if (!button) throw new Error("Create sandbox run button not found");
        button.click();
      });
      await page.waitForFunction(
        (previous) => /^#\/judge-demo\/[a-z0-9]+$/.test(location.hash) && location.hash !== previous,
        { timeout: 120000 },
        beforeHash,
      );
      await page.waitForSelector('[data-testid="judge-demo-run"]', { timeout: 90000 });
      result.freshRunId = await page.evaluate(() => location.hash.replace(/^#\/judge-demo\//, ""));
      result.freshAgreementHref = await page.evaluate(() => document.querySelector('[data-testid="judge-demo-agreement"]')?.getAttribute("href") ?? null);
      check("a fresh guided run starts with its own run id", /^[a-z0-9]+$/.test(result.freshRunId) && result.freshRunId !== PINNED_REFERENCE_RUN, String(result.freshRunId));
      check("the fresh guided run has its own agreement link", typeof result.freshAgreementHref === "string" && result.freshAgreementHref.startsWith("#/payments/"), String(result.freshAgreementHref));
      await page.screenshot({ path: path.join(outDir, "hosted-guided-demo-fresh-run.png"), fullPage: false });
    } else {
      result.freshRunSkipped = true;
    }
  } catch (error) {
    report.failure = { phase: "guided demo", message: error instanceof Error ? error.message : String(error) };
    check("guided demo reference and fresh run complete", false, report.failure.message);
    await page.screenshot({ path: path.join(outDir, "failure-guided-demo.png"), fullPage: true }).catch(() => {});
  }
  report.guidedDemo = result;
  const ignored = diagnostics.failedRequests.filter((line) => line.includes("/api/sign-in-options") && line.includes("net::ERR_ABORTED"));
  const failed = diagnostics.failedRequests.filter((line) => !ignored.includes(line));
  check("guided demo has zero page errors", diagnostics.pageErrors.length === 0, JSON.stringify(diagnostics.pageErrors));
  check("guided demo has zero console errors", diagnostics.consoleLogs.filter((line) => line.type === "error").length === 0, JSON.stringify(diagnostics.consoleLogs.filter((line) => line.type === "error").slice(0, 3)));
  check("guided demo has zero failed requests", failed.length === 0, JSON.stringify(failed.slice(0, 3)));
  report.diagnostics.push({
    width: "guided-demo",
    consoleErrors: diagnostics.consoleLogs.filter((line) => line.type === "error"),
    pageErrors: diagnostics.pageErrors,
    failedRequests: failed,
    ignoredAborts: ignored,
  });
  await browser.close();
}

const failures = report.checks.filter((c) => !c.ok);
report.checksRun = report.checks.length;
report.failures = failures.length;
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outDir, checksRun: report.checksRun, failures: failures.map((f) => f.name), guidedDemo: report.guidedDemo }, null, 2));
if (failures.length > 0 || report.failure) process.exitCode = 1;
