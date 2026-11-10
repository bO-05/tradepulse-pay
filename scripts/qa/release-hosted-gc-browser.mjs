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
 * "#/home" link. At desktop width it also opens the pinned Rosendin reference run (the
 * "Commercial reference job" badge). Starting a fresh guided run is opt-in by omitting the flag:
 * follow-up and release validation are read-only and MUST pass --no-fresh-run.
 *
 * Every persisted measurement and screenshot masks email-shaped text, so the tracked report never
 * carries a sandbox payee, owner or shared-seat address.
 *
 *   node scripts/qa/release-hosted-gc-browser.mjs --url https://tradepulse-pay.pages.dev --no-fresh-run
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

/** Never publish a sandbox, owner or shared-seat address in evidence. */
const maskEmails = (value) => String(value ?? "").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[masked email]");

/** Mask rendered addresses in the DOM before a screenshot. */
async function maskSandboxEmails(page) {
  await page.evaluate(() => {
    const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const parent = walk.currentNode.parentElement;
      if (!parent || ["SCRIPT", "STYLE"].includes(parent.tagName)) continue;
      walk.currentNode.textContent = walk.currentNode.textContent.replace(email, "[masked email]");
    }
  });
}

const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok, detail: maskEmails(detail) });
  if (!ok) console.log(`FAIL ${name} :: ${maskEmails(detail)}`);
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

async function clickLeadingStripCell(page, testId) {
  const href = await page.evaluate((id) => {
    const root = document.querySelectorAll('[data-testid="project-money-strip"]')[0];
    const link = root?.querySelector(`[data-testid="${id}"] a`);
    if (!link) return null;
    link.click();
    return link.getAttribute("href");
  }, testId);
  if (!href) throw new Error(`The leading Lopez strip has no link for ${testId}`);
  await delay(200);
  return href;
}

async function returnToInbox(page) {
  await clickHref(page, "#/inbox");
  await page.waitForFunction(() => location.hash === "#/inbox", { timeout: 60000 });
  await waitForMoney(page);
}

/** Wait until every expected strip's independent query has resolved. */
async function waitForMoney(page, expectedStrips = 1) {
  await page.waitForFunction(
    (expected) => {
      const roots = [...document.querySelectorAll('[data-testid="project-money-strip"]')];
      if (roots.length < expected) return false;
      return roots.slice(0, expected).every((root) => {
        const value = root.querySelector('[data-testid="project-money-collected"]')?.innerText?.trim() ?? "";
        return /^\$[\d,]+\.\d{2}$/.test(value);
      });
    },
    { timeout: 60000 },
    expectedStrips,
  );
}

async function readStrip(page, index = 0) {
  return await page.evaluate((stripIndex) => {
    const roots = [...document.querySelectorAll('[data-testid="project-money-strip"]')];
    const rootEl = roots[stripIndex];
    const value = (id) => rootEl?.querySelector(`[data-testid="${id}"]`)?.innerText?.trim() ?? null;
    const href = (id) => rootEl?.querySelector(`[data-testid="${id}"] a`)?.getAttribute("href") ?? null;
    return {
      present: rootEl !== undefined,
      stripCount: roots.length,
      scope: rootEl?.getAttribute("data-money-scope") ?? null,
      title: rootEl?.querySelector("h2")?.innerText?.trim() ?? null,
      text: rootEl?.innerText ?? "",
      labels: [...(rootEl?.querySelectorAll("dt") ?? [])].map((dt) => dt.innerText.trim()),
      collected: value("project-money-collected"),
      paidSubs: value("project-money-paid-subs"),
      retainage: value("project-money-retainage"),
      ownerRetainage: value("project-money-retainage-held-from-you"),
      owed: value("project-money-owed"),
      ownerCaption: rootEl?.querySelector('[data-testid="project-money-owner-retainage"]')?.innerText?.trim() ?? null,
      ownerCaptionInsideSubCell: (() => {
        const subCell = rootEl?.querySelector('[data-testid="project-money-retainage"]')?.closest("div.rounded-lg") ?? null;
        const caption = rootEl?.querySelector('[data-testid="project-money-owner-retainage"]') ?? null;
        return subCell !== null && caption !== null && subCell.contains(caption);
      })(),
      hrefs: {
        collected: href("project-money-collected"),
        paidSubs: href("project-money-paid-subs"),
        retainage: href("project-money-retainage"),
        ownerRetainage: href("project-money-retainage-held-from-you"),
        owed: href("project-money-owed"),
      },
      top: rootEl ? Math.round(rootEl.getBoundingClientRect().top) : null,
    };
  }, index);
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
    const landingPriority = await page.evaluate(() => {
      const visible = (el) => !el.closest("details:not([open])") && (typeof el.checkVisibility === "function" ? el.checkVisibility({ checkVisibilityCSS: true }) : el.getClientRects().length > 0);
      const commercial = document.querySelector('[data-testid="inbox-commercial"]');
      const strips = [...document.querySelectorAll('[data-testid="project-money-strip"]')];
      const records = [...document.querySelectorAll('[data-testid="inbox-residential-decision"], [data-testid="inbox-entry"]')].map((el) => ({
        projectKind: el.getAttribute("data-project-kind"),
        status: el.querySelector('[data-testid="inbox-payapp-status"]')?.getAttribute("data-status") ?? null,
        insideCommercial: el.closest('[data-testid="inbox-commercial"]') !== null,
      }));
      const firstCommercial = records.findIndex((record) => record.projectKind === "commercial");
      const action = document.querySelector('[data-testid="inbox-residential-decision-action"]');
      return {
        actionText: action?.textContent.trim() ?? null,
        actionHref: action?.getAttribute("href") ?? null,
        commercialOpen: commercial?.open === true,
        commercialTitle: commercial?.querySelector("summary > span")?.textContent.trim() ?? null,
        commercialRecords: commercial?.querySelectorAll('[data-testid="inbox-entry"]').length ?? 0,
        commercialVisible: [...(commercial?.querySelectorAll('[data-testid="inbox-entry"]') ?? [])].filter(visible).length,
        residentialLeads: firstCommercial === -1 || records.slice(firstCommercial).every((record) => record.projectKind !== "residential"),
        allCommercialInside: records.filter((record) => record.projectKind === "commercial").every((record) => record.insideCommercial),
        activeCommercial: records.filter((record) => record.projectKind === "commercial" && ["submitted", "under_review", "reviewed"].includes(record.status ?? "")).length,
        paidApproveCount: [...document.querySelectorAll("a, button")].filter((el) => /^Approve .* and pay /.test(el.textContent.trim())).length,
        primaryCount: [...document.querySelectorAll("a, button")].filter((el) => visible(el) && /\bbg-accent\b/.test(el.className) && /\btext-accent-fg\b/.test(el.className)).length,
        stripCount: strips.length,
        stripScopes: strips.map((el) => el.getAttribute("data-money-scope")),
        stripTitles: strips.map((el) => el.querySelector("h2")?.innerText.trim() ?? null),
        portfolioWords: /Money across your jobs|Collected from owners/.test(document.body.innerText),
        counts: document.querySelector('[data-testid="inbox-counts"]')?.textContent.trim() ?? "",
        bellBadge: document.querySelector('[data-testid="notification-badge"]')?.textContent?.trim() ?? null,
        pageHeight: document.documentElement.scrollHeight,
      };
    });
    report.measurements.push({ screen: "inbox", width, hash: inbox.hash, identity: inbox.identity, strip: inboxStrip, landingPriority });
    check(`${tag} GC seat lands on #/inbox`, inbox.hash === "#/inbox", inbox.hash);
    check(`${tag} GC identity chrome names Bayview Remodeling`, /bayview remodeling/i.test(inbox.identity), inbox.identity);
    check(
      `${tag} Lopez leads the inbox with five directed money cells`,
      inboxStrip.scope === "project" && JSON.stringify(inboxStrip.labels) === JSON.stringify(["Collected from homeowner", "Paid to subs", "Retainage you hold", "Retainage held from you", "Owed this week"]),
      JSON.stringify(inboxStrip),
    );
    check(`${tag} inbox Lopez strip is titled for the residential job`, /Money on this job · Lopez Kitchen Remodel/.test(inboxStrip.title ?? ""), String(inboxStrip.title));
    check(
      `${tag} inbox Lopez strip matches the stored five figures`,
      inboxStrip.collected === "$4,800.00" && inboxStrip.paidSubs === "$3,800.00" && inboxStrip.retainage === "$200.00" && inboxStrip.ownerRetainage === "$400.00" && inboxStrip.owed === "$0.00",
      JSON.stringify(inboxStrip),
    );
    check(
      `${tag} every Lopez cell links to its receipt surface`,
      inboxStrip.hrefs.collected === "#/owner-pay-apps" && inboxStrip.hrefs.paidSubs?.startsWith("#/payments/") && inboxStrip.hrefs.retainage === "#/billing/retainage" && inboxStrip.hrefs.ownerRetainage === "#/billing/owner-billing" && inboxStrip.hrefs.owed === "#/billing",
      JSON.stringify(inboxStrip.hrefs),
    );
    check(
      `${tag} Lopez owner retainage appears only as the directed separate cell`,
      inboxStrip.ownerCaption?.includes("$400.00") === true && inboxStrip.ownerCaptionInsideSubCell === false,
      JSON.stringify({ ownerCaption: inboxStrip.ownerCaption, insideSubCell: inboxStrip.ownerCaptionInsideSubCell }),
    );
    check(
      `${tag} the GC landing renders exactly one money strip, scoped to Lopez`,
      landingPriority.stripCount === 1 && landingPriority.stripScopes[0] === "project" && /Money on this job · Lopez Kitchen Remodel/.test(landingPriority.stripTitles[0] ?? ""),
      JSON.stringify({ count: landingPriority.stripCount, scopes: landingPriority.stripScopes, titles: landingPriority.stripTitles }),
    );
    check(
      `${tag} no portfolio strip, title or commercial sandbox figures remain`,
      !landingPriority.stripScopes.includes("portfolio") && !landingPriority.portfolioWords && !inbox.text.includes("Money across your jobs") && !inbox.text.includes("Collected from owners") && !inbox.text.includes("$17,070.40"),
      JSON.stringify({ scopes: landingPriority.stripScopes, portfolioWords: landingPriority.portfolioWords }),
    );
    const headerMatch = landingPriority.counts.match(/^(\d+) open in commercial reference$/);
    check(
      `${tag} the workload header counts only the commercial active partition`,
      headerMatch !== null && Number(headerMatch[1]) === landingPriority.activeCommercial,
      JSON.stringify({ counts: landingPriority.counts, activeCommercial: landingPriority.activeCommercial }),
    );
    check(`${tag} the workload header reads 5 open in commercial reference`, landingPriority.counts === "5 open in commercial reference", landingPriority.counts);
    check(`${tag} Needs your attention stays at 0`, /Needs your attention\s+0/.test(inbox.text), inbox.text.slice(0, 400));
    check(`${tag} the notification bell still reads 34 unread`, landingPriority.bellBadge === "34", String(landingPriority.bellBadge));
    check(`${tag} inbox has no horizontal overflow`, inbox.scrollWidth === inbox.clientWidth, `${inbox.scrollWidth} vs ${inbox.clientWidth}`);
    check(`${tag} GC home shows the residential decision`, /residential draw · settled on the sandbox/i.test(inbox.text) && /ortiz plumbing/i.test(inbox.text), inbox.text.slice(0, 300));
    check(`${tag} paid residential action is View paid receipt`, landingPriority.actionText === "View paid receipt" && landingPriority.actionHref === `#/pay-apps/${settledPayAppId}`, JSON.stringify(landingPriority));
    check(`${tag} no paid representation offers approve-and-pay`, landingPriority.paidApproveCount === 0, String(landingPriority.paidApproveCount));
    check(`${tag} residential records lead every commercial record`, landingPriority.residentialLeads && landingPriority.allCommercialInside, JSON.stringify(landingPriority));
    check(`${tag} commercial records share one counted collapsed section`, !landingPriority.commercialOpen && landingPriority.commercialVisible === 0 && landingPriority.commercialTitle === `Commercial reference job (${landingPriority.commercialRecords})`, JSON.stringify(landingPriority));
    check(`${tag} GC landing keeps exactly one primary action`, landingPriority.primaryCount === 1, String(landingPriority.primaryCount));
    await maskSandboxEmails(page);
    await page.screenshot({ path: path.join(outDir, `hosted-inbox-${width}.png`), fullPage: false });

    // Every leading-strip figure resolves to its existing receipt surface. The paid change-order
    // row gets one extra direct-link check because it joins the paid draw in the collected figure.
    if (width === 1440) {
      const cells = [
        ["project-money-collected", "#/owner-pay-apps"],
        ["project-money-paid-subs", inboxStrip.hrefs.paidSubs],
        ["project-money-retainage", "#/billing/retainage"],
        ["project-money-retainage-held-from-you", "#/billing/owner-billing"],
        ["project-money-owed", "#/billing"],
      ];
      for (const [testId, expectedHash] of cells) {
        const clickedHash = await clickLeadingStripCell(page, testId);
        await page.waitForFunction((want) => location.hash === want, { timeout: 60000 }, expectedHash);
        await page.waitForSelector("main", { timeout: 30000 });
        await delay(300);
        const receiptPage = await readPage(page);
        check(`${tag} ${testId} resolves to its receipt surface`, clickedHash === expectedHash && receiptPage.hash === expectedHash && !receiptPage.notFound, JSON.stringify({ clickedHash, hash: receiptPage.hash, notFound: receiptPage.notFound }));
        await returnToInbox(page);
      }
      await page.waitForFunction(() => {
        const root = document.querySelectorAll('[data-testid="project-money-strip"]')[0];
        return (root?.querySelectorAll('[data-testid="project-money-receipts"] a[href^="#/change-orders/"]').length ?? 0) > 0;
      }, { timeout: 15000 }).catch(() => {});
      const changeOrderReceipt = await page.evaluate(() => {
        const root = document.querySelectorAll('[data-testid="project-money-strip"]')[0];
        const details = root?.querySelector('[data-testid="project-money-receipts"]');
        if (details) details.open = true;
        const link = [...(details?.querySelectorAll('a[href^="#/change-orders/"]') ?? [])][0];
        return link ? { href: link.getAttribute("href"), text: link.textContent.trim() } : null;
      });
      check(`${tag} collected receipts include the paid change order`, changeOrderReceipt?.href?.startsWith("#/change-orders/") && /Add under-cabinet lighting/.test(changeOrderReceipt.text), JSON.stringify(changeOrderReceipt));
      if (changeOrderReceipt) {
        await clickHref(page, changeOrderReceipt.href);
        await page.waitForFunction((want) => location.hash === want, { timeout: 60000 }, changeOrderReceipt.href);
        await page.waitForSelector("main", { timeout: 30000 });
        await delay(300);
        const changeOrder = await readPage(page);
        check(`${tag} paid change-order receipt opens the stored $1,200 record`, !changeOrder.notFound && /Add under-cabinet lighting/.test(changeOrder.text) && /\$1,200\.00/.test(changeOrder.text) && /Paid/.test(changeOrder.text), changeOrder.text.slice(0, 600));
        await maskSandboxEmails(page);
        await page.screenshot({ path: path.join(outDir, "hosted-lopez-change-order-receipt-1440.png"), fullPage: false });
        await returnToInbox(page);
      }
    }

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
    check(
      `${tag} Lopez project strip has the same five directed labels`,
      JSON.stringify(projectStrip.labels) === JSON.stringify(["Collected from homeowner", "Paid to subs", "Retainage you hold", "Retainage held from you", "Owed this week"]),
      JSON.stringify(projectStrip.labels),
    );
    check(
      `${tag} Lopez project strip matches all five stored figures`,
      projectStrip.collected === "$4,800.00" && projectStrip.paidSubs === "$3,800.00" && projectStrip.retainage === "$200.00" && projectStrip.ownerRetainage === "$400.00" && projectStrip.owed === "$0.00",
      JSON.stringify(projectStrip),
    );
    check(`${tag} Lopez project page has no horizontal overflow`, project.scrollWidth === project.clientWidth, `${project.scrollWidth} vs ${project.clientWidth}`);
    if (width === 1440) check(`${tag} Lopez money strip sits above the fold`, (projectStrip.top ?? 9999) < project.innerHeight, `${projectStrip.top} vs ${project.innerHeight}`);
    check(`${tag} Lopez page shows the settled-record read-only notice`, project.readOnlyNotice === "Settled sandbox record · read-only.", String(project.readOnlyNotice));
    check(`${tag} Lopez page offers no new-draw control`, project.newDraw === false);
    check(`${tag} Lopez page has no dead hash links`, project.deadLinks.length === 0, JSON.stringify(project.deadLinks));
    await maskSandboxEmails(page);
    await page.screenshot({ path: path.join(outDir, `hosted-lopez-${width}.png`), fullPage: false });

    // ---- Lopez -> GC home -> settled Ortiz pay app ---------------------------------------
    await clickHref(page, "#/inbox");
    await page.waitForFunction(() => location.hash === "#/inbox", { timeout: 60000 });
    await page.waitForSelector('[data-testid="inbox-residential-decision-action"]', { timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="inbox-residential-decision-action"]')?.textContent.trim() === "View paid receipt", { timeout: 60000 });
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
    check(`${tag} Ortiz pay app shows the settled-record read-only notice`, payApp.readOnlyNotice === "Settled sandbox record · read-only.", String(payApp.readOnlyNotice));
    check(`${tag} Ortiz pay app has no dead hash links`, !payApp.links.some((href) => href === "#" || href === "#/home"), JSON.stringify(payApp.links.filter((href) => href === "#" || href === "#/home")));
    await maskSandboxEmails(page);
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
    await maskSandboxEmails(page);
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
    check(`${tag} commercial project keeps the reference-job read-only copy`, commercial.readOnlyNotice === null || commercial.readOnlyNotice === "Preserved reference job · read-only.", String(commercial.readOnlyNotice));
    check(`${tag} commercial project keeps commercial wording`, /Collected from owner/.test(commercial.text) && /Retainage held/.test(commercial.text) && !/Collected from homeowner/.test(commercial.text) && !/Retainage you hold/.test(commercial.text), commercial.text.slice(0, 600));
    await maskSandboxEmails(page);
    await page.screenshot({ path: path.join(outDir, `hosted-commercial-${width}.png`), fullPage: false });
  } catch (error) {
    report.failure = { width, phase: "gc path", message: error instanceof Error ? error.message : String(error) };
    check(`${tag} GC path completes`, false, report.failure.message);
    await maskSandboxEmails(page).catch(() => {});
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
    result.pinnedReferenceNotice = await page.evaluate(
      () => document.querySelector('[data-testid="read-only-reference"]')?.innerText?.trim() ?? null,
    );
    check("pinned Rosendin reference run shows the Commercial reference job badge", /commercial reference job/i.test(result.pinnedReferenceBadge ?? ""), String(result.pinnedReferenceBadge));
    check("pinned Rosendin reference run keeps the commercial read-only copy", result.pinnedReferenceNotice === "Preserved reference job · read-only.", String(result.pinnedReferenceNotice));
    await maskSandboxEmails(page);
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
      await maskSandboxEmails(page);
      await page.screenshot({ path: path.join(outDir, "hosted-guided-demo-fresh-run.png"), fullPage: false });
    } else {
      result.freshRunSkipped = true;
    }
  } catch (error) {
    report.failure = { phase: "guided demo", message: error instanceof Error ? error.message : String(error) };
    check("guided demo reference and fresh run complete", false, report.failure.message);
    await maskSandboxEmails(page).catch(() => {});
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
// Mask every persisted string as a second line of defence, including text copied from the DOM.
const maskReportJson = (value) =>
  JSON.stringify(value, (_key, entry) => (typeof entry === "string" ? maskEmails(entry) : entry), 2);
fs.writeFileSync(path.join(outDir, "report.json"), maskReportJson(report));
console.log(maskReportJson({ outDir, checksRun: report.checksRun, failures: failures.map((f) => f.name), guidedDemo: report.guidedDemo }));
if (failures.length > 0 || report.failure) process.exitCode = 1;
