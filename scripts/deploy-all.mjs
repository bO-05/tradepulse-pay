#!/usr/bin/env node
/**
 * One build, two static hosts, one backend.
 *
 * This is deliberately NOT `npx convex deploy`: with CONVEX_DEPLOYMENT set, that command
 * targets the project's production deployment. The recovery app must stay on
 * dev:cheery-axolotl-689, so the backend is pushed with `convex dev --once` and every
 * target is checked before anything is written.
 *
 * Usage: npm run deploy:all
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const EXPECTED_DEPLOYMENT = "dev:cheery-axolotl-689";
const EXPECTED_CLOUD = "https://cheery-axolotl-689.convex.cloud";
const EXPECTED_SITE = "https://cheery-axolotl-689.convex.site";
const CANONICAL = "https://tradepulse-pay.asynchronope.tech";
const PAGES_PROJECT = "tradepulse-pay";
const PAGES_BRANCH = "main";
const BRANCH = "recovery/stabilize-2026-11-01";

function fail(message) {
  console.error(`\nREFUSED: ${message}`);
  process.exit(1);
}

function parseEnvFile(file) {
  const values = {};
  if (!existsSync(file)) return values;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]] = value;
  }
  return values;
}

function run(command, args, env = process.env) {
  const quoted = [command, ...args]
    .map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part))
    .join(" ");
  console.log(`\n> ${quoted}`);
  execSync(quoted, { cwd: ROOT, env, stdio: "inherit" });
}

function capture(command) {
  return execSync(command, { cwd: ROOT, encoding: "utf8" }).trim();
}

async function versionAt(url) {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/version.json?ts=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.commit === "string" ? body.commit : null;
  } catch {
    return null;
  }
}

async function waitForCommit(url, commit, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await versionAt(url)) === commit) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
  }
  return false;
}

const fileEnv = parseEnvFile(resolve(ROOT, ".env.local"));
const env = { ...fileEnv, ...process.env };
const deployment = (env.CONVEX_DEPLOYMENT ?? "").replace(/\s+#.*$/, "").trim();
const cloud = (env.VITE_CONVEX_URL ?? "").trim().replace(/\/$/, "");
const site = (env.VITE_CONVEX_SITE_URL ?? "").trim().replace(/\/$/, "");

if (process.env.CONVEX_DEPLOY_KEY) fail("CONVEX_DEPLOY_KEY is set; remove it so this script cannot target another deployment.");
if (deployment !== EXPECTED_DEPLOYMENT) fail(`CONVEX_DEPLOYMENT is ${deployment || "unset"}, expected ${EXPECTED_DEPLOYMENT}.`);
if (cloud !== EXPECTED_CLOUD) fail(`VITE_CONVEX_URL is ${cloud || "unset"}, expected ${EXPECTED_CLOUD}.`);
if (site !== EXPECTED_SITE) fail(`VITE_CONVEX_SITE_URL is ${site || "unset"}, expected ${EXPECTED_SITE}.`);

const branch = capture("git rev-parse --abbrev-ref HEAD");
if (branch !== BRANCH) fail(`current branch is ${branch}, expected ${BRANCH}.`);
const dirty = capture("git status --porcelain");
if (dirty !== "") fail(`working tree is not clean:\n${dirty}`);

const commit = capture("git rev-parse HEAD");
const subject = capture("git log -1 --pretty=%s");
const remoteSiteUrl = capture(`npx convex env get SITE_URL`).split(/\r?\n/).pop()?.trim();
if (remoteSiteUrl !== CANONICAL) {
  fail(`Convex SITE_URL is ${remoteSiteUrl || "unset"}, expected ${CANONICAL}. Run: npx convex env set SITE_URL ${CANONICAL}`);
}

console.log("Target verified:");
console.log(`  backend     ${deployment} (${cloud})`);
console.log(`  mirror      ${site}`);
console.log(`  canonical   ${CANONICAL}`);
console.log(`  commit      ${commit}`);

const buildEnv = {
  ...process.env,
  CONVEX_DEPLOYMENT: deployment,
  VITE_CONVEX_URL: cloud,
  VITE_CONVEX_SITE_URL: site,
  VITE_BUILD_COMMIT: commit,
};

// 1. Backend on recovery dev only.
run("npx", ["convex", "dev", "--once", "--typecheck", "enable"], buildEnv);

// 2. One frontend build, used by both static hosts.
run("npm", ["run", "build"], buildEnv);

const versionFile = JSON.parse(readFileSync(resolve(ROOT, "dist", "version.json"), "utf8"));
if (versionFile.commit !== commit) fail(`dist/version.json says ${versionFile.commit}, expected ${commit}.`);

// 3. The existing .convex.site host must keep serving the same build.
run("npm", ["run", "deploy:site"], buildEnv);

// 4. Cloudflare Pages production deployment (direct upload, no Git integration).
run(
  "npx",
  [
    "wrangler",
    "pages",
    "deploy",
    "dist",
    `--project-name=${PAGES_PROJECT}`,
    `--branch=${PAGES_BRANCH}`,
    `--commit-hash=${commit}`,
    `--commit-message=${subject}`,
  ],
  buildEnv,
);

// 5. Prove both hosts really serve the commit that was just built.
const mirrorUrl = `${site}/`;
const pagesUrl = `https://${PAGES_PROJECT}.pages.dev/`;
const mirrorOk = await waitForCommit(mirrorUrl, commit);
const pagesOk = await waitForCommit(pagesUrl, commit);
if (!mirrorOk) fail(`mirror did not serve ${commit} at ${mirrorUrl}version.json`);
if (!pagesOk) fail(`Cloudflare Pages did not serve ${commit} at ${pagesUrl}version.json`);

console.log("\nBoth static hosts serve the same commit:");
console.log(`  ${mirrorUrl}version.json -> ${commit}`);
console.log(`  ${pagesUrl}version.json -> ${commit}`);

const canonicalOk = await waitForCommit(`${CANONICAL}/`, commit, 10_000);
if (canonicalOk) {
  console.log(`  ${CANONICAL}/version.json -> ${commit}`);
} else {
  console.log(`\nCanonical DNS is not resolving to this build yet. The owner still needs:`);
  console.log(`  Type: CNAME   Name: tradepulse-pay   Target: ${PAGES_PROJECT}.pages.dev   Proxy: on`);
}
