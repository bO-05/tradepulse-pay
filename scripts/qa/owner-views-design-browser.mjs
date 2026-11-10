import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT as root, launchBrowser, attachDiagnostics, delay } from "./lib.mjs";

/**
 * Design acceptance for the owner views (VAL-JUDGE-009 / VAL-JUDGE-012).
 *
 * Signs in through `#/demo` as the demo Owner and proves, at 1440x900 and 390x844, that:
 *  - the owner home leads with the Lopez job: the first job section, the full "Job so far" card,
 *    a money trail and a balance figure at >= 24px, with the other jobs below it as secondary cards
 *    that keep their own commercial badge and wording;
 *  - the owner draw opens on Lopez, leads with the current payment due at >= 24px, shows the money
 *    trail, plain-word statuses and exactly one primary action;
 *  - the change-order invoice uses the page header, cards, Money and StatusPill, shows the amount
 *    at >= 24px, never prints the raw status code and renders the PayPal invoice link as a button;
 *  - none of the three screens has horizontal page overflow and no visible control is under 24px.
 *
 * Read-only: it never approves, requests changes, pays, signs or opens a guided run.
 */
const site = process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1] : "http://localhost:3150";
const outDir = process.argv.includes("--out")
  ? path.resolve(process.argv[process.argv.indexOf("--out") + 1])
  : path.join(root, "docs", "evidence", `owner-views-design-${new Date().toISOString().slice(0, 10)}`);
fs.mkdirSync(outDir, { recursive: true });

const report = { target: site, checks: [], measurements: [], diagnostics: [] };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok, detail: maskEmails(detail) });
  if (!ok) console.log(`FAIL ${name}${detail ? ` :: ${maskEmails(detail)}` : ""}`);
};

/** Never publish a sandbox inbox in evidence. */
function maskEmails(value) {
  return String(value ?? "").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[sandbox email]");
}

async function maskSandboxEmails(page) {
  await page.evaluate(() => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const parent = walk.currentNode.parentElement;
      if (!parent || ["SCRIPT", "STYLE"].includes(parent.tagName)) continue;
      walk.currentNode.textContent = walk.currentNode.textContent.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[masked email]");
    }
  });
}

async function measure(page) {
  return page.evaluate(() => {
    const money = /^\$[\d,]+\.\d{2}$/;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const moneyFigures = [...document.querySelectorAll("dd, p, span, td")]
      .map((el) => {
        const own = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
        const text = (own?.textContent ?? "").trim();
        if (!money.test(text) || !visible(el)) return null;
        const r = el.getBoundingClientRect();
        return {
          text,
          fontSize: parseFloat(getComputedStyle(el).fontSize),
          testid: el.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
          top: Math.round(r.top + window.scrollY),
          right: Math.round(r.right + window.scrollX),
          inClosedDetails: el.closest("details:not([open])") !== null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.fontSize - a.fontSize || a.top - b.top);
    const primary = [...document.querySelectorAll("button, a")]
      .filter((el) => typeof el.className === "string" && el.className.includes("bg-accent") && visible(el))
      .map((el) => ({
        tag: el.tagName,
        text: (el.textContent ?? "").trim(),
        testid: el.getAttribute("data-testid"),
        height: Math.round(el.getBoundingClientRect().height),
      }));
    const controls = [...document.querySelectorAll("a, button, input, select, textarea, [role=button]")]
      .filter(visible)
      .map((el) => ({
        tag: el.tagName,
        text: (el.textContent ?? "").trim().slice(0, 40),
        testid: el.getAttribute("data-testid"),
        height: Math.round(el.getBoundingClientRect().height),
      }));
    const box = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top + window.scrollY),
        right: Math.round(r.right + window.scrollX),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    };
    const statusWords = [...document.querySelectorAll("[data-status]")]
      .filter(visible)
      .map((el) => ({ code: el.getAttribute("data-status"), label: (el.textContent ?? "").trim() }));
    const fundedAmountCells = [...document.querySelectorAll('[data-testid="owner-tranche-row"]')].map((row) => {
      const cell = row.cells[2];
      if (!cell) return null;
      const cellRect = cell.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(cell);
      const textRect = range.getBoundingClientRect();
      const scrollerRect = cell.closest(".table-scroll")?.getBoundingClientRect() ?? null;
      return {
        text: (cell.textContent ?? "").trim(),
        scrollWidth: cell.scrollWidth,
        clientWidth: cell.clientWidth,
        cellLeft: cellRect.left,
        cellRight: cellRect.right,
        textLeft: textRect.left,
        textRight: textRect.right,
        scrollerRight: scrollerRect?.right ?? null,
        viewportWidth: innerWidth,
      };
    }).filter(Boolean);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      h1s: [...document.querySelectorAll("main h1")].map((h) => h.innerText),
      moneyFigures,
      primary,
      controls,
      under24: controls.filter((c) => c.height < 24),
      statusWords,
      fundedAmountCells,
      trail: box('[data-testid="owner-money-trail"]'),
      drawTrail: box('[data-testid="owner-draw-money-trail"]'),
      summary: box('[data-testid="owner-g702"]'),
      balance: box('[data-testid="owner-job-balance"]'),
      paymentDue: box('[data-testid="owner-draw-payment-due"]'),
      amount: box('[data-testid="change-order-amount"]'),
      text: document.body.innerText,
      mainText: document.querySelector("main")?.innerText ?? "",
    };
  });
}

/** The pages are read-only; a network abort from the sign-in probe is not a failure. */
function realFailures(diagnostics) {
  return {
    consoleErrors: diagnostics.consoleLogs.filter((l) => l.type === "error"),
    pageErrors: diagnostics.pageErrors,
    failedRequests: diagnostics.failedRequests.filter(
      (line) => !(line.includes("/api/sign-in-options") && line.includes("net::ERR_ABORTED")),
    ),
  };
}

for (const [width, height] of [[1440, 900], [390, 844]]) {
  const { browser } = await launchBrowser(width, height);
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const diagnostics = attachDiagnostics(page);
  page.setDefaultTimeout(60000);
  const tag = `[${width}]`;

  await page.goto(`${site}/#/demo`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.click('[data-testid="demo-enter-owner"]');
  await page.waitForFunction(() => location.hash === "#/projects", { timeout: 60000 });
  await page.waitForSelector('[data-testid="owner-job-so-far"]', { timeout: 60000 });
  await delay(600);

  // ---- Owner home -------------------------------------------------------------------------------
  const home = await measure(page);
  const homeStructure = await page.evaluate(() => {
    const jobSections = [...document.querySelectorAll("main section[data-project-kind]")];
    const residential = jobSections.find((s) => s.getAttribute("data-project-kind") === "residential") ?? null;
    const secondary = [...document.querySelectorAll('[data-testid="owner-project-secondary"]')];
    const other = [...document.querySelectorAll("main section")].find((s) => (s.querySelector("h2")?.innerText ?? "") === "Other projects") ?? null;
    return {
      firstJobKind: jobSections[0]?.getAttribute("data-project-kind") ?? null,
      firstJobTitle: jobSections[0]?.querySelector("h2")?.innerText ?? null,
      residentialTitle: residential?.querySelector("h2")?.innerText ?? null,
      residentialHasJobCard: residential?.querySelector('[data-testid="owner-job-so-far"]') !== null,
      secondaryCount: secondary.length,
      secondaryFirstTitle: secondary[0]?.querySelector("h3")?.innerText ?? null,
      secondaryBadges: secondary.filter((s) => s.querySelector('[data-testid="commercial-reference-badge"]')).length,
      otherTop: other ? Math.round(other.getBoundingClientRect().top + window.scrollY) : null,
      residentialTop: residential ? Math.round(residential.getBoundingClientRect().top + window.scrollY) : null,
      jobStatus: residential?.querySelector('[data-testid="owner-job-status"]')?.textContent?.trim() ?? null,
      trailText: document.querySelector('[data-testid="owner-money-trail"]')?.innerText ?? "",
    };
  });
  report.measurements.push({
    screen: "owner-home",
    width,
    ...home,
    text: maskEmails(home.text),
    mainText: maskEmails(home.mainText),
    homeStructure,
  });
  check(`${tag} owner home has exactly one h1`, home.h1s.length === 1, JSON.stringify(home.h1s));
  check(`${tag} the first job section is the Lopez residential job`, homeStructure.firstJobKind === "residential" && /Lopez Kitchen Remodel/.test(homeStructure.residentialTitle ?? ""), JSON.stringify(homeStructure));
  check(`${tag} the lead job carries the full Job so far card`, homeStructure.residentialHasJobCard === true);
  check(`${tag} the other jobs sit below the lead as secondary cards`, homeStructure.otherTop !== null && homeStructure.residentialTop !== null && homeStructure.otherTop > homeStructure.residentialTop && homeStructure.secondaryCount > 0, JSON.stringify(homeStructure));
  check(`${tag} secondary jobs keep the commercial badge`, homeStructure.secondaryBadges > 0, String(homeStructure.secondaryBadges));
  check(`${tag} the money trail is visible under the percent`, (home.trail?.height ?? 0) > 0);
  for (const label of ["Contract to date", "Work completed", "Retainage held", "Paid to date", "Balance to finish"]) {
    check(`${tag} owner trail names ${label}`, homeStructure.trailText.toLowerCase().includes(label.toLowerCase()), homeStructure.trailText.slice(0, 400));
  }
  check(`${tag} the paid figure is the hero money figure at text-3xl`, home.moneyFigures[0]?.testid === "owner-job-paid" && (home.moneyFigures[0]?.fontSize ?? 0) >= 24, JSON.stringify(home.moneyFigures.slice(0, 3)));
  check(`${tag} the job status line is not empty`, (homeStructure.jobStatus ?? "").trim().length > 0, String(homeStructure.jobStatus));
  check(`${tag} owner home has no horizontal page overflow`, home.scrollWidth <= home.clientWidth, `${home.scrollWidth} vs ${home.clientWidth}`);
  check(
    `${tag} every funded-milestone Amount cell is fully inside its visible cell and the viewport`,
    home.fundedAmountCells.length > 0 && home.fundedAmountCells.every((cell) =>
      cell.scrollWidth <= cell.clientWidth &&
      cell.textLeft >= cell.cellLeft - 1 &&
      cell.textRight <= cell.cellRight + 1 &&
      cell.textRight <= cell.viewportWidth + 1 &&
      cell.cellRight <= cell.viewportWidth + 1 &&
      (cell.scrollerRight === null || cell.cellRight <= cell.scrollerRight + 1)
    ),
    JSON.stringify(home.fundedAmountCells),
  );
  check(`${tag} owner home has no visible control under 24px`, home.under24.length === 0, JSON.stringify(home.under24));
  await maskSandboxEmails(page);
  await page.screenshot({ path: path.join(outDir, `owner-home-${width}.png`), fullPage: true });
  await page.evaluate(() => scrollTo(0, 0));
  await delay(150);
  await page.screenshot({ path: path.join(outDir, `owner-home-first-viewport-${width}.png`) });

  // ---- Owner draw, reached through the owner home's Draws link ---------------------------------
  await page.evaluate(() => document.querySelector('a[href="#/owner-pay-apps"]')?.click());
  await page.waitForFunction(() => location.hash === "#/owner-pay-apps", { timeout: 60000 });
  await page.waitForSelector('[data-testid="owner-draw-money-trail"]', { timeout: 60000 });
  await delay(600);
  const draw = await measure(page);
  const drawStructure = await page.evaluate(() => {
    const selected = document.querySelector('[data-testid="owner-billing-project"]');
    return {
      pickedProject: selected ? selected.options[selected.selectedIndex]?.textContent ?? "" : document.querySelector("main")?.innerText.split("\n").slice(0, 12).join(" | ") ?? "",
      headerText: document.querySelector('[data-testid="owner-pay-app"]')?.querySelector("h3")?.innerText ?? null,
      trailText: document.querySelector('[data-testid="owner-draw-money-trail"]')?.innerText ?? "",
      invoiceText: document.querySelector('[data-testid="owner-invoice-panel"]')?.innerText ?? "",
      noticeTop: (() => {
        const el = document.querySelector('[data-testid="read-only-reference"]');
        return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null;
      })(),
      drawerOpen: document.querySelector('[data-testid="owner-draw-breakdown"]')?.open ?? null,
    };
  });
  report.measurements.push({ screen: "owner-draw", width, ...draw, text: maskEmails(draw.text), mainText: maskEmails(draw.mainText), drawStructure });
  check(`${tag} owner draw opens on the Lopez draw`, /Lopez Kitchen Remodel/.test(drawStructure.pickedProject) && /Draw #1/.test(drawStructure.headerText ?? ""), JSON.stringify(drawStructure));
  check(`${tag} draw page heading is Draws`, draw.h1s.length === 1 && draw.h1s[0] === "Draws", JSON.stringify(draw.h1s));
  check(`${tag} draw money trail is visible`, (draw.drawTrail?.height ?? 0) > 0);
  for (const label of ["Paid this draw", "Contract to date", "Work completed", "Retainage held", "Previous draws"]) {
    check(`${tag} draw trail names ${label}`, drawStructure.trailText.toLowerCase().includes(label.toLowerCase()), drawStructure.trailText.slice(0, 400));
  }
  check(`${tag} paid this draw is the hero money figure at text-3xl`, draw.moneyFigures[0]?.testid === "owner-draw-payment-due" && (draw.moneyFigures[0]?.fontSize ?? 0) >= 24, JSON.stringify(draw.moneyFigures.slice(0, 3)));
  check(`${tag} the money trail sits above the numbered summary`, (draw.drawTrail?.top ?? 0) < (draw.summary?.top ?? 0), `${draw.drawTrail?.top} vs ${draw.summary?.top}`);
  check(`${tag} exactly one primary action on the draw`, draw.primary.length === 1, JSON.stringify(draw.primary));
  check(`${tag} the draw primary is the named PayPal receipt action and meets 44px`, /PayPal receipt/i.test(draw.primary[0]?.text ?? "") && (draw.primary[0]?.height ?? 0) >= 44, JSON.stringify(draw.primary));
  check(`${tag} the draw status words are plain`, draw.statusWords.some((s) => s.code === "paid" && s.label === "Paid"), JSON.stringify(draw.statusWords));
  check(`${tag} a paid draw never says Current payment due`, !/current payment due/i.test(draw.mainText), draw.mainText.slice(0, 400));
  check(`${tag} a paid draw names Paid by PayPal with its date`, /Paid by PayPal\s*·\s*Nov 8, 2026/.test(drawStructure.trailText), drawStructure.trailText.slice(0, 200));
  check(`${tag} the read-only notice sits below the money trail`, (drawStructure.noticeTop ?? 0) > (draw.drawTrail?.top ?? 0), `${drawStructure.noticeTop} vs ${draw.drawTrail?.top}`);
  check(`${tag} the invoice status is never the raw code`, /PayPal status\s+Paid/.test(drawStructure.invoiceText) && !/PAID/.test(drawStructure.invoiceText), drawStructure.invoiceText.slice(0, 200));
  check(`${tag} the breakdown starts collapsed`, drawStructure.drawerOpen === false, String(drawStructure.drawerOpen));
  check(`${tag} owner draw has no horizontal page overflow`, draw.scrollWidth <= draw.clientWidth, `${draw.scrollWidth} vs ${draw.clientWidth}`);
  check(`${tag} owner draw has no visible control under 24px`, draw.under24.length === 0, JSON.stringify(draw.under24));
  await maskSandboxEmails(page);
  await page.screenshot({ path: path.join(outDir, `owner-draw-${width}.png`), fullPage: true });
  await page.evaluate(() => scrollTo(0, 0));
  await delay(150);
  await page.screenshot({ path: path.join(outDir, `owner-draw-first-viewport-${width}.png`) });

  // ---- Change-order invoice, reached from the Lopez section on the owner home -------------------
  await page.evaluate(() => {
    const nav = [...document.querySelectorAll("a")].find((a) => a.getAttribute("href") === "#/projects");
    if (nav) nav.click();
    else history.back();
  });
  await page.waitForFunction(() => location.hash === "#/projects", { timeout: 5000 }).catch(async () => {
    await page.goto(`${site}/#/projects`, { waitUntil: "domcontentloaded" });
  });
  await page.waitForFunction(() => location.hash === "#/projects", { timeout: 60000 });
  await page.waitForSelector('[data-testid="owner-job-so-far"]', { timeout: 60000 });
  const coHref = await page.evaluate(() => {
    const residential = [...document.querySelectorAll("main section[data-project-kind]")].find((s) => s.getAttribute("data-project-kind") === "residential");
    return residential?.querySelector('a[data-testid="change-order-label"]')?.getAttribute("href") ?? null;
  });
  check(`${tag} the Lopez change order is reachable from the owner home`, typeof coHref === "string" && coHref.startsWith("#/change-orders/"), String(coHref));
  await page.evaluate((href) => {
    const link = document.querySelector(`a[href="${href}"]`);
    if (link) link.click();
    else location.hash = href;
  }, coHref);
  await page.waitForFunction(() => location.hash.startsWith("#/change-orders/"), { timeout: 60000 });
  await page.waitForSelector('[data-testid="change-order-amount"]', { timeout: 60000 });
  await delay(600);
  const co = await measure(page);
  const coStructure = await page.evaluate(() => ({
    title: document.querySelector("main h1")?.innerText ?? null,
    amountText: document.querySelector('[data-testid="change-order-amount"]')?.innerText ?? null,
    amountCardText: document.querySelector('[data-testid="change-order-amount"]')?.closest("section")?.innerText ?? null,
    invoiceLink: (() => {
      const el = document.querySelector('[data-testid="change-order-invoice-link"]');
      if (!el) return null;
      return {
        tag: el.tagName,
        text: (el.textContent ?? "").trim(),
        href: el.getAttribute("href"),
        className: el.className,
        height: Math.round(el.getBoundingClientRect().height),
      };
    })(),
    invoicePanelText: [...document.querySelectorAll("main section")].find((s) => (s.querySelector("h2")?.innerText ?? "") === "PayPal invoice")?.innerText ?? null,
  }));
  report.measurements.push({ screen: "change-order-invoice", width, ...co, text: maskEmails(co.text), mainText: maskEmails(co.mainText), coStructure });
  check(`${tag} CO page has exactly one h1 naming the change order`, co.h1s.length === 1 && /Add under-cabinet lighting/.test(co.h1s[0]), JSON.stringify(co.h1s));
  check(`${tag} CO amount is large and tabular`, (co.moneyFigures[0]?.fontSize ?? 0) >= 24 && co.moneyFigures[0]?.testid === "change-order-amount", JSON.stringify(co.moneyFigures.slice(0, 3)));
  check(`${tag} CO amount is $1,200.00`, /\$1,200\.00/.test(coStructure.amountText ?? ""), String(coStructure.amountText));
  check(`${tag} a paid CO shows the word Paid and its date beside the amount`, /Paid\s+Nov 8, 2026/.test(coStructure.amountCardText ?? ""), (coStructure.amountCardText ?? "").slice(0, 200));
  check(`${tag} a paid CO action opens the PayPal receipt`, /PayPal receipt/i.test(coStructure.invoiceLink?.text ?? ""), String(coStructure.invoiceLink?.text));
  check(`${tag} CO status is a plain word`, co.statusWords.some((s) => s.code === "paid" && s.label === "Paid"), JSON.stringify(co.statusWords));
  check(`${tag} CO page never prints the raw status code`, !/PAID/.test(co.mainText) && !/\bpaid\b/.test(co.mainText.replace(/Previously paid/g, "").replace(/paid invoice/g, "")), co.mainText.slice(0, 600));
  check(`${tag} PayPal invoice link is a real link styled as a button`, coStructure.invoiceLink?.tag === "A" && /sandbox\.paypal\.com/.test(coStructure.invoiceLink?.href ?? "") && coStructure.invoiceLink.className.includes("bg-accent") && (coStructure.invoiceLink.height ?? 0) >= 44, JSON.stringify(coStructure.invoiceLink));
  check(`${tag} exactly one primary action on the CO invoice`, co.primary.length === 1, JSON.stringify(co.primary));
  check(`${tag} CO invoice status is a plain word`, /Inv\w*\s*status\s+Paid/i.test(coStructure.invoicePanelText ?? ""), (coStructure.invoicePanelText ?? "").slice(0, 200));
  check(`${tag} CO invoice has no horizontal page overflow`, co.scrollWidth <= co.clientWidth, `${co.scrollWidth} vs ${co.clientWidth}`);
  check(`${tag} CO invoice has no visible control under 24px`, co.under24.length === 0, JSON.stringify(co.under24));
  await maskSandboxEmails(page);
  await page.screenshot({ path: path.join(outDir, `change-order-invoice-${width}.png`), fullPage: true });
  await page.evaluate(() => scrollTo(0, 0));
  await delay(150);
  await page.screenshot({ path: path.join(outDir, `change-order-invoice-first-viewport-${width}.png`) });

  // ---- Owner Projects detail: the legacy commercial change order is display-mapped only --------
  const legacyProjectId = "q9751tqcjsbd11myp8x25c08hs8hdj94";
  const legacyProjectHash = `#/my-projects/${legacyProjectId}`;
  await page.evaluate(() => document.querySelector('a[href="#/my-projects"]')?.click());
  await page.waitForFunction(() => location.hash === "#/my-projects", { timeout: 60000 });
  await page.waitForSelector('[data-testid="project-switcher"]', { timeout: 60000 });
  await page.evaluate((href) => document.querySelector(`a[href="${href}"]`)?.click(), legacyProjectHash);
  await page.waitForFunction((hash) => location.hash === hash, { timeout: 60000 }, legacyProjectHash);
  await page.waitForFunction(() => {
    const sections = [...document.querySelectorAll("main section")];
    return sections.some((section) => section.querySelector("h2")?.textContent?.trim() === "Change orders");
  }, { timeout: 60000 });
  await page.evaluate(() => document.querySelectorAll("main details").forEach((details) => { details.open = true; }));
  await delay(300);
  const projectDetail = await page.evaluate(() => {
    const main = document.querySelector("main");
    const changeOrders = [...(main?.querySelectorAll("section") ?? [])]
      .find((section) => section.querySelector("h2")?.textContent?.trim() === "Change orders");
    const perceivableAttributes = [...(main?.querySelectorAll("*") ?? [])].flatMap((el) =>
      ["title", "aria-label", "aria-description", "placeholder", "alt"]
        .map((name) => el.getAttribute(name))
        .filter(Boolean),
    );
    return {
      hash: location.hash,
      text: main?.innerText ?? "",
      changeOrdersText: changeOrders?.innerText ?? "",
      perceivableAttributes,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
  report.measurements.push({
    screen: "owner-project-detail",
    width,
    ...projectDetail,
    text: maskEmails(projectDetail.text),
    changeOrdersText: maskEmails(projectDetail.changeOrdersText),
    perceivableAttributes: projectDetail.perceivableAttributes.map(maskEmails),
  });
  check(`${tag} owner Projects detail route resolves`, projectDetail.hash === legacyProjectHash, projectDetail.hash);
  check(
    `${tag} owner Projects detail strips only the stored legacy prefix`,
    /add two EV charger circuits in the garage/i.test(projectDetail.changeOrdersText),
    projectDetail.changeOrdersText.slice(0, 600),
  );
  check(
    `${tag} owner Projects detail has no Judge demo text or perceivable attribute`,
    !/Judge demo/i.test([projectDetail.text, ...projectDetail.perceivableAttributes].join("\n")),
    projectDetail.changeOrdersText.slice(0, 600),
  );
  check(`${tag} owner Projects detail has no horizontal overflow`, projectDetail.scrollWidth <= projectDetail.clientWidth, `${projectDetail.scrollWidth} vs ${projectDetail.clientWidth}`);
  await maskSandboxEmails(page);
  await page.screenshot({ path: path.join(outDir, `owner-project-detail-${width}.png`), fullPage: true });
  await page.evaluate(() => scrollTo(0, 0));
  await delay(150);
  await page.screenshot({ path: path.join(outDir, `owner-project-detail-first-viewport-${width}.png`) });

  const failures = realFailures(diagnostics);
  report.diagnostics.push({ width, ...failures });
  check(`${tag} zero page errors`, failures.pageErrors.length === 0, JSON.stringify(failures.pageErrors));
  check(`${tag} zero console errors`, failures.consoleErrors.length === 0, JSON.stringify(failures.consoleErrors.slice(0, 3)));
  check(`${tag} zero failed requests`, failures.failedRequests.length === 0, JSON.stringify(failures.failedRequests.slice(0, 3)));

  await browser.close();
}

fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
fs.writeFileSync(
  path.join(outDir, "console-and-network.txt"),
  report.diagnostics
    .flatMap((d) => [
      `--- ${d.width}px ---`,
      `pageErrors: ${JSON.stringify(d.pageErrors)}`,
      `consoleErrors: ${JSON.stringify(d.consoleErrors)}`,
      `failedRequests: ${JSON.stringify(d.failedRequests)}`,
    ])
    .join("\n") + "\n",
);
const failures = report.checks.filter((c) => !c.ok);
console.log(JSON.stringify({ outDir, checksRun: report.checks.length, failures }, null, 2));
if (failures.length > 0) process.exitCode = 1;
