#!/usr/bin/env node
/**
 * Recovery dev only: scrape one fixed public company page using the app's real Firecrawl integration.
 * --discover additionally performs one bounded search and stores deduplicated, unverified public
 * contractor records in the known demo project's package. Never dispatches RFQs or emails anyone.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = "https://cheery-axolotl-689.convex.site";
const discover = process.argv.includes("--discover");
if (process.argv.slice(2).some((arg) => arg !== "--discover")) throw new Error("Unknown flag.");
if (process.env.CONVEX_DEPLOY_KEY ||
    !/^CONVEX_DEPLOYMENT=dev:cheery-axolotl-689(?:\s|$)/m.test(fs.readFileSync(path.join(root, ".env.local"), "utf8"))) {
  throw new Error("Only recovery dev without deployment-key overrides is allowed.");
}
const client = new ConvexHttpClient("https://cheery-axolotl-689.convex.cloud");
const report = { target: site, discover, checks: {}, errors: [] };
let authenticated = false;
let stage = "temporary demo sign-in";
try {
  const login = await client.action(api.auth.signIn, {
    provider: "password", params: { flow: "signIn", email: "gc@demo.tradepulse", password: "TradePulseDemo!2026" },
  });
  if (!login.tokens?.token) throw new Error("No temporary demo session.");
  client.setAuth(login.tokens.token);
  authenticated = true;
  stage = "real website scrape";
  const result = await client.action(api.contractorDiscovery.scrapeContractorWebsite, { url: "https://www.rosendin.com/" });
  report.checks.scrape = { source: result.source, success: result.success, markdownCharacters: result.markdown.length,
    isLive: result.success && result.source === "FirecrawlClient Website Scraping" && result.markdown.trim().length > 100 };
  if (!report.checks.scrape.isLive) report.errors.push("No substantive live scrape was returned; this is not certified as live.");
  if (discover) {
    stage = "bounded demo-package discovery";
    const run = await client.query(api.judgeDemo.runs.getRun, { runId: "nx74k1sdcnsmqzvkr97kf0ts598hch6p" });
    if (!run || run.agreementNumber !== "A401-DEMO-PAY-20261101-02") throw new Error("Known demo fixture not found.");
    const packages = await client.query(api.tradePackages.listByProject, { projectId: run.projectId });
    if (packages.length !== 1) throw new Error("Expected one known demo package.");
    const discovery = await client.action(api.contractorDiscovery.discoverSubcontractors, { tradePackageId: packages[0]._id });
    report.checks.discovery = discovery;
    if (!discovery.success || discovery.discoveredCount <= 0) report.errors.push("Discovery returned no usable real contractor records.");
  }
} catch {
  report.errors.push(`Recovery Firecrawl check failed at ${stage}; provider diagnostics suppressed.`);
} finally {
  if (authenticated) {
    try { await client.action(api.auth.signOut, {}); } catch { report.errors.push("Temporary session revocation failed."); }
  }
  const directory = path.join(root, "evidence", `recovery-firecrawl-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${directory}`);
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 1;
}
