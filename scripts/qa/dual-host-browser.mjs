/**
 * Dual-host acceptance for the recovery build. Read-only except ordinary demo sign-ins.
 *
 *   node scripts/qa/dual-host-browser.mjs
 *   node scripts/qa/dual-host-browser.mjs --url https://cheery-axolotl-689.convex.site --url https://tradepulse-pay.pages.dev
 *
 * The canonical custom domain can be included with another --url once DNS resolves.
 * It never starts a guided run, opens PayPal, submits a form or changes business data.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const urls = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--url") {
    if (!args[i + 1]) throw new Error("--url requires an origin");
    urls.push(args[++i].replace(/\/+$/, ""));
  } else throw new Error(`Unknown option: ${args[i]}`);
}
if (urls.length === 0) {
  urls.push("https://cheery-axolotl-689.convex.site", "https://tradepulse-pay.pages.dev");
}

const DEMO_RUN = "nx74k1sdcnsmqzvkr97kf0ts598hch6p";
const REFERENCE_AGREEMENT = "A401-DEMO-PAY-20261101-02";
const CANONICAL = "https://tradepulse-pay.asynchronope.tech";
const MIRROR = "https://cheery-axolotl-689.convex.site";
const directory = path.join(root, "evidence", `dual-host-browser-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(directory, { recursive: true });

const report = { mode: "Read-only dual-host acceptance; demo authentication only", checks: [], errors: [], hosts: urls };
const check = (name, passed, detail = {}) => {
  report.checks.push({ name, passed: Boolean(passed), ...detail });
  if (!passed) throw new Error(`Check failed: ${name}${detail.detail ? ` (${detail.detail})` : ""}`);
};
const bodyText = (page) => page.evaluate(() => document.body.innerText);

const chrome = [
  process.env.QA_CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean).find((candidate) => fs.existsSync(candidate));
if (!chrome) throw new Error("Chrome not found; set QA_CHROME_PATH");

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  defaultViewport: { width: 1440, height: 1000 },
  protocolTimeout: 60000,
});

function diagnosticsFor(label) {
  const errors = [];
  return {
    errors,
    attach(page) {
      page.on("pageerror", (error) => errors.push({ label, kind: "pageerror", text: String(error.message).slice(0, 300) }));
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const text = message.text();
        if (/Access-Control-Allow-Origin|CORS policy|blocked by CORS/i.test(text)) {
          errors.push({ label, kind: "cors", text: text.slice(0, 300) });
        } else {
          errors.push({ label, kind: "console", text: text.slice(0, 300) });
        }
      });
      page.on("requestfailed", (request) => {
        const failure = request.failure()?.errorText || "";
        if (/ERR_FAILED|CORS/i.test(failure)) {
          errors.push({ label, kind: "requestfailed", text: `${request.url().slice(0, 180)} ${failure}`.slice(0, 300) });
        }
      });
    },
  };
}

async function open(page, site, hash) {
  await page.goto(`${site}/${hash}`, { waitUntil: "domcontentloaded" });
}

async function signIn(site, role) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const diagnostics = diagnosticsFor(`${site} ${role}`);
  diagnostics.attach(page);
  await open(page, site, "#/demo");
  await page.waitForSelector(`[data-testid="demo-enter-${role}"]`, { timeout: 45000 });
  await page.click(`[data-testid="demo-enter-${role}"]`);
  await page.waitForSelector('[data-testid="signed-in-identity"]', { timeout: 45000 });
  await page.waitForFunction(() => document.querySelector("#workspace-main") !== null, { timeout: 45000 });
  return { context, page, diagnostics };
}

async function versionAt(site) {
  const res = await fetch(`${site}/version.json?ts=${Date.now()}`, { headers: { "Cache-Control": "no-cache" } });
  if (!res.ok) return null;
  return await res.json();
}

async function preflight(site, origin, pathName, method = "GET", headers = "Authorization") {
  const res = await fetch(`${site}${pathName}`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": method,
      "Access-Control-Request-Headers": headers,
    },
  });
  return { status: res.status, allowOrigin: res.headers.get("access-control-allow-origin") };
}

try {
  // One reference commit shared by every reachable host.
  const versions = [];
  for (const site of urls) {
    const version = await versionAt(site);
    check(`${site} serves version.json`, version && typeof version.commit === "string", { site, version });
    versions.push(version.commit);
  }
  check("all reachable hosts serve the same commit", new Set(versions).size === 1, { versions });

  // Both origins are already allowed by the backend, even before the custom DNS resolves.
  for (const origin of [CANONICAL, MIRROR]) {
    const files = await preflight(MIRROR, origin, "/api/project-files/preflight-test");
    check(`project-file CORS preflight allows ${origin}`, files.status === 204 && files.allowOrigin === origin, files);
    const studio = await preflight(MIRROR, origin, "/ai/studio", "POST", "Authorization, Content-Type");
    check(`Studio CORS preflight allows ${origin}`, studio.status === 204 && studio.allowOrigin === origin, studio);
  }

  for (const site of urls) {
    const hostLabel = new URL(site).host;

    // Public demo guide on this host.
    const publicContext = await browser.createBrowserContext();
    const publicPage = await publicContext.newPage();
    const publicDiagnostics = diagnosticsFor(`${site} public`);
    publicDiagnostics.attach(publicPage);
    await open(publicPage, site, "#/demo");
    await publicPage.waitForSelector('[data-testid="demo-access-page"]', { timeout: 45000 });
    const demoText = await bodyText(publicPage);
    check(`${hostLabel} opens #/demo`, demoText.includes("Choose your seat") && demoText.includes("gc@demo.tradepulse"));
    const stamp = await publicPage.$eval('[data-testid="build-stamp"]', (el) => el.textContent || "");
    check(`${hostLabel} footer shows the build commit`, stamp.includes(versions[0].slice(0, 12)), { stamp });
    check(`${hostLabel} public page has no console or CORS errors`, publicDiagnostics.errors.length === 0, {
      errors: publicDiagnostics.errors,
    });
    await publicContext.close();

    // GC: reference run, reports, ledger and a stored archive download through the backend origin.
    const gc = await signIn(site, "gc");
    await open(gc.page, site, `#/judge-demo/${DEMO_RUN}`);
    await gc.page.waitForSelector('[data-testid="read-only-reference"]', { timeout: 45000 });
    const judgeText = await bodyText(gc.page);
    check(`${hostLabel} opens the pinned read-only run`, judgeText.includes(REFERENCE_AGREEMENT) && judgeText.includes("Preserved demo fixture"));
    check(`${hostLabel} does not offer a new run on the reference`, !judgeText.includes("Start guided demo"));

    const archiveResponses = [];
    gc.page.on("response", (response) => {
      const url = response.url();
      if (/\/specs\/|\/drawings\/|\/quotes\/|\/insurance\//.test(url)) {
        archiveResponses.push({
          status: response.status(),
          allowOrigin: response.headers()["access-control-allow-origin"] || null,
          path: new URL(url).pathname,
        });
      }
    });
    await open(gc.page, site, "#/procurement");
    await gc.page.waitForFunction(() => document.body.innerText.includes("Convex File Storage"), { timeout: 45000 });
    const archiveButtons = await gc.page.$$('button[title="Download document archive"]');
    check(`${hostLabel} lists seeded archive files`, archiveButtons.length > 0, { count: archiveButtons.length });
    for (const button of archiveButtons.slice(0, 3)) {
      await button.click();
      await delay(1200);
    }
    check(`${hostLabel} stored archive download reaches the Convex site`, archiveResponses.some((r) => r.status === 200), {
      responses: archiveResponses,
    });
    check(`${hostLabel} stored archive response is CORS-open`, archiveResponses.every((r) => r.allowOrigin === "*"), {
      responses: archiveResponses,
    });

    await open(gc.page, site, "#/dashboard");
    await gc.page.waitForSelector('[data-testid="dashboard-basic-view"]', { timeout: 45000 });
    check(`${hostLabel} reports load without a Studio license`, (await bodyText(gc.page)).includes("No AG Studio license is needed"));

    await open(gc.page, site, "#/payments/jn78x0j5xeh7q9gb55p26r7pdh8hdmjx");
    await gc.page.waitForFunction(() => /Agreement|Ledger|Contract/i.test(document.body.innerText), { timeout: 45000 });
    check(`${hostLabel} agreement ledger loads`, (await bodyText(gc.page)).includes("$55,000"));
    check(`${hostLabel} GC pages have no console or CORS errors`, gc.diagnostics.errors.length === 0, {
      errors: gc.diagnostics.errors,
    });
    await gc.context.close();

    // Sub and Owner in independent contexts.
    const sub = await signIn(site, "sub");
    await open(sub.page, site, "#/portal");
    await sub.page.waitForFunction(() => /Rosendin|agreement|pay application/i.test(document.body.innerText), { timeout: 45000 });
    check(`${hostLabel} subcontractor signs in and sees its portal`, (await bodyText(sub.page)).includes("Rosendin"));
    check(`${hostLabel} subcontractor has no console or CORS errors`, sub.diagnostics.errors.length === 0, {
      errors: sub.diagnostics.errors,
    });
    await sub.context.close();

    const owner = await signIn(site, "owner");
    await open(owner.page, site, "#/projects");
    await owner.page.waitForFunction(() => /Project|Owner|Change order/i.test(document.body.innerText), { timeout: 45000 });
    check(`${hostLabel} owner signs in and sees projects`, (await bodyText(owner.page)).length > 40);
    check(`${hostLabel} owner has no console or CORS errors`, owner.diagnostics.errors.length === 0, {
      errors: owner.diagnostics.errors,
    });
    await owner.context.close();
  }

  // The custom domain is an additional host, not a replacement. Record its state without failing the run.
  try {
    const canonicalVersion = await versionAt(CANONICAL);
    report.canonical = canonicalVersion ? { commit: canonicalVersion.commit } : { pendingDns: true };
  } catch {
    report.canonical = { pendingDns: true };
  }
} catch (error) {
  report.failure = String(error?.message ?? error);
} finally {
  report.passed = report.checks.filter((c) => c.passed).length;
  report.total = report.checks.length;
  report.errors = report.checks.flatMap((c) => c.errors ?? []);
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      directory,
      passed: report.passed,
      total: report.total,
      failure: report.failure ?? null,
      canonical: report.canonical,
    }),
  );
  await browser.close();
}
if (report.failure) process.exitCode = 1;
