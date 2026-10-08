import fs from "node:fs";
import path from "node:path";

/**
 * Role-guard audit of the Convex function surface.
 *
 * Lists every exported public query, mutation, action and httpAction under convex/ (plus the
 * inline routes in convex/http.ts) with the guard call that runs first and its tenancy guard.
 * Fails when a public function has no guard, reads/writes data (ctx.db, ctx.run*, ctx.storage)
 * before the guard, or has no company-tenancy guard (convex/lib/tenancy.ts, lib/projectScope.ts)
 * without being listed as touching no project data.
 *
 * Usage: node scripts/tools/guard-audit.mjs [--write docs/guard-audit.md]
 */

const ROOT = "convex";
const TENANCY_GUARDS = [
  "requireProjectScope",
  "requireDocScope",
  "findDocScope",
  "scopedAgreements",
  "requireProjectScopeInAction",
  "requireDemoCompany",
  "requireDemoCompanyInAction",
  "callerProjects",
  "subContractorScope",
  "requireProjectAccess",
  "requireDocInProject",
  "requireCompanyMember",
  "accessibleProjectIds",
];
const TENANCY = new RegExp(`\\b(${TENANCY_GUARDS.join("|")})\\(`);
const GUARD = new RegExp(
  `\\b(requireRole|requireRoleInAction|requireAgreementAccess|getViewer|requireVerifiedUser|${TENANCY_GUARDS.join("|")})\\(|\\b(ctx\\.runQuery\\(internal\\.profiles\\.requireRoleForAction)\\b`,
);
// Public functions that read no project or company data, so a role check is the whole guard.
const NO_PROJECT_DATA = new Map([
  ["crons:getCronStatus", "static cron schedule"],
  ["llmRouter:getProviderAvailability", "which model keys are configured (booleans)"],
  ["llmRouter:runModelDiagnostic", "fixed sample prompts, no project data"],
  ["contractorDiscovery:scrapeContractorWebsite", "scrapes a public URL, no project data"],
  ["profiles:me", "caller's own profile"],
  ["onboarding:createCompany", "creates the caller's own GC company and membership; no client-chosen company or project"],
  ["payments/webhook:paypalWebhook", "PayPal-signed delivery; no caller session"],
  ["agentmailWebhook:agentmailWebhook", "AgentMail-signed delivery; no caller session. Routing by stored thread or ref; unmatched mail carries no tenant ids"],
  ["dashboard/studioProxy:studioPreflight", "CORS preflight"],
  ["projectFileDownload:projectFilePreflight", "CORS preflight"],
]);
// The app-shell identity query: it reads only the caller's own users row (by getAuthUserId) and
// returns role null for accounts without a profile, so it cannot expose other users' data.
const SELF_ONLY = new Map([["profiles:me", /\bgetAuthUserId\(ctx\)/]]);
const DATA_ACCESS = /\bctx\.(db|runQuery|runMutation|runAction|storage)\b/;
const EXPORT = /^export const (\w+) = (query|mutation|action|httpAction|internalQuery|internalMutation|internalAction)\(/gm;

// Inline routes in convex/http.ts. None of them reads or writes app data.
const INLINE_ROUTES = [
  ["GET /agentmail/webhook", "Public status probe; reports only whether a secret is configured"],
  ["GET /llms.txt", "Public by design; static manifest, no data access"],
  ["GET /api/health", "Public by design; static status, no data access"],
  ["GET /api/project-files/*", "projectFileDownload: Convex Auth bearer token + project access; 401 without a session, 404 \"Not found.\" otherwise"],
  ["GET /specs/*, /drawings/*, /quotes/*, /insurance/*, /files/*, /api/files/*", "Public demo PDFs bundled in code; no data access"],
  ["GET/POST /api/*, /agentmail/* (unknown paths)", "JSON 404, no data access"],
  ["/api/auth/* (auth.addHttpRoutes)", "Convex Auth routes; exempt"],
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "_generated") walk(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

const rows = [];
const problems = [];
const noTenancy = [];
let internalCount = 0;

for (const file of walk(ROOT).sort()) {
  const src = fs.readFileSync(file, "utf8");
  const hits = [...src.matchAll(EXPORT)];
  hits.forEach((h, i) => {
    const [, name, kind] = h;
    if (kind.startsWith("internal")) {
      internalCount++;
      return;
    }
    const end = i + 1 < hits.length ? hits[i + 1].index : src.length;
    const body = src.slice(h.index, end);
    const rel = file.split(path.sep).join("/");
    const fnName = `${rel.replace(/^convex\//, "").replace(/\.ts$/, "")}:${name}`;
    const where = `${rel}:${lineOf(src, h.index)}`;
    const guard = body.match(GUARD);
    const access = body.match(DATA_ACCESS);
    let guardText;
    if (fnName === "projectFileDownload:projectFileDownload") {
      const identityAt = body.search(/getUserIdentity/);
      const authorizeAt = body.search(/runQuery\(internal\.projectFileDownload\.authorizeDownload/);
      const storageAt = body.search(/ctx\.storage/);
      guardText = "Bearer token, then authorizeDownload (requireDocScope) before ctx.storage";
      if (identityAt === -1 || authorizeAt < identityAt || storageAt < authorizeAt) {
        problems.push(`${fnName}: storage read is not behind the session and project check`);
      }
    } else if (fnName === "projectFileDownload:projectFilePreflight") {
      guardText = "CORS preflight only, no data access";
      if (access || /\bfetch\(/.test(body)) problems.push(`${fnName}: preflight touches data`);
    } else if (fnName === "payments/webhook:paypalWebhook") {
      const verifyAt = body.search(/verif/i);
      const writeAt = body.search(/runMutation|runAction/);
      guardText = "PayPal signature verification before any write";
      if (verifyAt === -1 || (writeAt !== -1 && writeAt < verifyAt)) problems.push(`${fnName}: no signature verification before writes`);
    } else if (fnName === "agentmailWebhook:agentmailWebhook") {
      const verifyAt = body.search(/verifyAgentMailWebhook\(/);
      const writeAt = body.search(/runMutation|runAction/);
      guardText = "AgentMail Svix signature verification before any write; 503 when no secret is set";
      if (verifyAt === -1 || (writeAt !== -1 && writeAt < verifyAt)) problems.push(`${fnName}: no signature verification before writes`);
    } else if (fnName === "dashboard/studioProxy:studioPreflight") {
      guardText = "CORS preflight only, no data access";
      if (access || /\bfetch\(/.test(body)) problems.push(`${fnName}: preflight touches data`);
    } else if (fnName === "dashboard/studioProxy:studioProxy") {
      const identityAt = body.search(/getUserIdentity/);
      const authorizeAt = body.search(/runQuery\(internal\.dashboard\.studioAccess\.authorizeStudioCaller/);
      const fetchAt = body.search(/\bfetch\(/);
      guardText = "Bearer token, then authorizeStudioCaller (requireRole + requireCompanyMember) before fetch";
      if (identityAt === -1 || authorizeAt < identityAt || fetchAt < authorizeAt || /runMutation|runAction/.test(body)) {
        problems.push(`${fnName}: model call is not behind the session and company check`);
      }
    } else if (SELF_ONLY.has(fnName)) {
      const self = body.match(SELF_ONLY.get(fnName));
      guardText = "getAuthUserId(): caller's own users row only, then getViewer()";
      if (!self || (access && access.index < self.index)) problems.push(`${fnName} (${where}): reads data before getAuthUserId()`);
    } else if (!guard) {
      guardText = "MISSING";
      problems.push(`${fnName} (${where}): no guard call`);
    } else {
      const label = guard[1] ? `${guard[1]}()` : "requireRoleForAction (internal query)";
      guardText = `${label} at line ${lineOf(src, h.index + guard.index)}`;
      if (access && access.index < guard.index) problems.push(`${fnName} (${where}): data access before ${label}`);
    }
    const tenancy = body.match(TENANCY);
    let tenancyText;
    if (fnName === "projectFileDownload:projectFileDownload") tenancyText = "requireDocScope() via authorizeDownload";
    else if (fnName === "dashboard/studioProxy:studioProxy") {
      tenancyText = "requireCompanyMember() via authorizeStudioCaller; reads no app data itself";
    }
    else if (tenancy) tenancyText = `${tenancy[1]}()`;
    else if (NO_PROJECT_DATA.has(fnName)) tenancyText = `none needed: ${NO_PROJECT_DATA.get(fnName)}`;
    else {
      tenancyText = "MISSING";
      noTenancy.push(fnName);
      problems.push(`${fnName} (${where}): no tenancy guard`);
    }
    rows.push({ fnName, kind, where, guardText, tenancyText });
  });
}

const lines = [
  "# Role-guard audit",
  "",
  "Generated by `node scripts/tools/guard-audit.mjs --write docs/guard-audit.md`. Every exported public Convex",
  "function calls a role guard before it reads or writes data, and a company-tenancy guard",
  "(`convex/lib/tenancy.ts`, `convex/lib/projectScope.ts`) unless it reads no project data.",
  `Internal functions (${internalCount} \`internal*\` exports) are not callable from clients and are not listed.`,
  "",
  `Public functions: ${rows.length}. Problems: ${problems.length}. Without a tenancy guard: ${noTenancy.length}.`,
  "",
  "| Function | Kind | Location | Guard | Tenancy |",
  "|---|---|---|---|---|",
  ...rows.map((r) => `| \`${r.fnName}\` | ${r.kind} | \`${r.where}\` | ${r.guardText} | ${r.tenancyText} |`),
  "",
  "## Inline HTTP routes in `convex/http.ts`",
  "",
  "| Route | Guard |",
  "|---|---|",
  ...INLINE_ROUTES.map(([route, guard]) => `| \`${route}\` | ${guard} |`),
  "",
];

const out = lines.join("\n");
const writeAt = process.argv.indexOf("--write");
if (writeAt !== -1) {
  fs.writeFileSync(process.argv[writeAt + 1], out);
  console.log(`wrote ${process.argv[writeAt + 1]}`);
}
console.log(
  `guard-audit: ${rows.length} public functions, ${internalCount} internal, ${problems.length} problems, ${noTenancy.length} without a tenancy guard`,
);
for (const p of problems) console.error(`  - ${p}`);
process.exit(problems.length ? 1 : 0);
