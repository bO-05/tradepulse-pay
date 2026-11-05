#!/usr/bin/env node
/**
 * Runs the 24-case pay-app review eval on the recovery dev deployment and writes a
 * precision/recall scorecard. The deployment is pinned: this script refuses to run
 * against production or any deployment other than cheery-axolotl-689.
 *
 * Usage:
 *   node scripts/qa/pay-app-review-scorecard.mjs
 *   node scripts/qa/pay-app-review-scorecard.mjs --strict
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const deployment = "cheery-axolotl-689";
const resultsDir = path.join(repoRoot, "evals", "results");
const strict = process.argv.includes("--strict");
const expectedCases = 24;

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

const envPath = path.join(repoRoot, ".env.local");
if (!fs.existsSync(envPath)) fail(".env.local is missing; cannot verify the pinned dev target.");
const envText = fs.readFileSync(envPath, "utf8");
const deploymentLine = envText.split(/\r?\n/).find((line) => line.trim().startsWith("CONVEX_DEPLOYMENT="));
if (!deploymentLine || deploymentLine.trim() !== `CONVEX_DEPLOYMENT=dev:${deployment}`) {
  fail(`.env.local must pin CONVEX_DEPLOYMENT=dev:${deployment}; no scorecard was run.`);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const args = [
  "convex",
  "run",
  "payApps/reviewEvals:runPayAppReviewEvalSuite",
  "{}",
  "--deployment",
  deployment,
  "--typecheck",
  "disable",
  "--codegen",
  "disable",
];
console.log(`Running the ${expectedCases}-case pay-app review eval on ${deployment}...`);
const run = spawnSync(npx, args, {
  cwd: repoRoot,
  encoding: "utf8",
  timeout: 300_000,
  shell: false,
});
if (run.error) fail(`Could not start Convex CLI: ${run.error.message}`);
if (run.status !== 0) {
  fail(`Convex run failed with exit code ${run.status}.\n${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim());
}

const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
let result;
try {
  result = JSON.parse(output);
} catch {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) fail(`Could not find JSON in Convex output.\n${output}`);
  try {
    result = JSON.parse(output.slice(start, end + 1));
  } catch (err) {
    fail(`Could not parse Convex output as JSON: ${err.message}\n${output}`);
  }
}

if (!Array.isArray(result.fixtureScores) || result.fixtureScores.length !== expectedCases) {
  fail(`Expected ${expectedCases} fixture scores, got ${result.fixtureScores?.length ?? "none"}.`);
}
if (!result.reviewMetrics || !Array.isArray(result.reviewMetrics.perVerdict)) {
  fail("The run did not return reviewMetrics; deploy the current reviewEvals code first.");
}

const pct = (value) => `${Math.round(value * 1000) / 10}%`;
const model = !result.model || result.model === "none" ? result.provider : `${result.provider} (${result.model})`;
const failedCases = result.fixtureScores.filter((f) => !f.passed);
const timestamp = new Date().toISOString();

const summaryRows = [
  ["Cases passed", `${result.passedCases} / ${result.totalCases}`, pct(result.reviewMetrics.casePassRate), "Every fixture's verdicts, zero holds and flags match"],
  ["Line accuracy", pct(result.reviewMetrics.lineAccuracy), `${result.reviewMetrics.totalLines} lines`, "Exact verdict per submitted line"],
  ["Issue precision", pct(result.reviewMetrics.issuePrecision), `${result.reviewMetrics.totalIssues} issue lines`, "Flagged lines that were truly issues"],
  ["Issue recall", pct(result.reviewMetrics.issueRecall), `${result.reviewMetrics.totalIssues} issue lines`, "Truly flagged issue lines that were caught"],
  ["Issue F1", pct(result.reviewMetrics.issueF1), "precision + recall", "Harmonic mean of issue detection"],
  ["Macro F1", pct(result.reviewMetrics.macroF1), "5 verdict classes", "Macro one-vs-rest F1 across verdicts"],
];

const verdictRows = result.reviewMetrics.perVerdict.map(
  (m) => `| \`${m.verdict}\` | ${m.support} | ${m.tp} | ${m.fp} | ${m.fn} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} |`,
);

const caseRows = result.fixtureScores.map(
  (f) => `| \`${f.fixtureId}\` | ${pct(f.score)} | **${f.passed ? "PASS" : "FAIL"}** | ${f.provider}${f.model && f.model !== "none" ? ` (${f.model})` : ""} |`,
);

const failureDetails = failedCases.length
  ? `\n## Failed case details\n\n${failedCases
      .map((f) => `### \`${f.fixtureId}\`\n\n\`\`\`\n${f.checks.join("\n")}\n\`\`\`\n`)
      .join("\n")}`
  : "";

const markdown = `# Pay-App Review Eval Scorecard

**Run ID**: \`${result.runId}\`  
**Timestamp**: \`${timestamp}\`  
**Deployment**: \`${deployment}\`  
**Reviewed by**: ${model}  
**Cases**: ${result.totalCases}  

## Summary

| Metric | Result | Population | Meaning |
| :--- | ---: | ---: | :--- |
${summaryRows.map((row) => `| **${row[0]}** | **${row[1]}** | ${row[2]} | ${row[3]} |`).join("\n")}

${failedCases.length === 0 ? "All cases matched their expected verdicts, zero holds and flags." : `${failedCases.length} case(s) did not match exactly:\n\n${failedCases.map((f) => `- \`${f.fixtureId}\``).join("\n")}`}

## Per-verdict precision and recall

| Verdict | Support | TP | FP | FN | Precision | Recall | F1 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${verdictRows.join("\n")}

A "positive" in the issue metrics is any line whose expected verdict is not \`ok\`. The per-verdict
metrics are one-vs-rest: for each class, true positives are lines with that expected verdict and
that verdict predicted, false positives are other lines predicted as that class, and false negatives
are lines with that expected verdict predicted as something else.

## Case-by-case results

| Fixture | Verdict match | Result | Reviewed by |
| :--- | ---: | :--- | :--- |
${caseRows.join("\n")}
${failureDetails}
## Reproduce

\`\`\`powershell
npm.cmd run eval:payapps
\`\`\`

The script pins \`--deployment ${deployment}\` and refuses to run unless \`.env.local\` points at
\`dev:${deployment}\`. It never targets production.
`;

fs.mkdirSync(resultsDir, { recursive: true });
const stamp = timestamp.replace(/[:.]/g, "-");
const jsonPath = path.join(resultsDir, `pay-app-review-scorecard-${stamp}.json`);
const mdPath = path.join(resultsDir, "pay-app-review-scorecard.md");
fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: timestamp, deployment, ...result }, null, 2), "utf8");
fs.writeFileSync(mdPath, markdown, "utf8");

console.log(`Run: ${result.runId}`);
console.log(`Cases: ${result.passedCases}/${result.totalCases} (${pct(result.reviewMetrics.casePassRate)} exact)`);
console.log(`Line accuracy: ${pct(result.reviewMetrics.lineAccuracy)} across ${result.reviewMetrics.totalLines} lines`);
console.log(`Issue precision/recall/F1: ${pct(result.reviewMetrics.issuePrecision)} / ${pct(result.reviewMetrics.issueRecall)} / ${pct(result.reviewMetrics.issueF1)}`);
console.log(`Macro F1: ${pct(result.reviewMetrics.macroF1)}`);
console.log(`Markdown scorecard: ${mdPath}`);
console.log(`JSON result: ${jsonPath}`);

if (strict && (failedCases.length > 0 || result.reviewMetrics.issueRecall < 0.9 || result.reviewMetrics.issuePrecision < 0.9)) {
  fail("Strict mode failed: every case must pass and issue precision/recall must be at least 90%.");
}
