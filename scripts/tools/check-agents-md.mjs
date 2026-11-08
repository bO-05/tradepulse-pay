import fs from "node:fs";

/**
 * Root-purpose tool: the commands and paths an agent is told to use must still exist.
 * Scans AGENTS.md (and CLAUDE.md, which mirrors it) for `npm run <script>` references and
 * for repository paths written in backticks, then checks each against package.json and the
 * filesystem. A stale instruction fails here instead of misleading an agent later.
 *
 * Usage: node scripts/tools/check-agents-md.mjs [file...]   (default: AGENTS.md CLAUDE.md)
 */

const files = process.argv.slice(2).length ? process.argv.slice(2) : ["AGENTS.md", "CLAUDE.md"];
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const scripts = new Set(Object.keys(pkg.scripts ?? {}));

// Only paths this repository owns are treated as verifiable facts; URLs, /tmp and the like are not.
const REPO_PATH = /^(?:convex|src|scripts|tests|docs|public)\/\S*$/;
const GLOB_CHARS = ["*", "?", "{", "}", "[", "]", "<", ">"];

const problems = [];
let scriptRefs = 0;
let pathRefs = 0;

for (const file of files) {
  if (!fs.existsSync(file)) {
    problems.push(`${file}: file is missing`);
    continue;
  }
  const text = fs.readFileSync(file, "utf8");
  if (text.trim().length <= 100) problems.push(`${file}: shorter than 100 characters`);

  for (const [, name] of text.matchAll(/npm run ([a-z0-9:_-]+)/gi)) {
    scriptRefs += 1;
    if (!scripts.has(name)) problems.push(`${file}: package.json has no script named "${name}"`);
  }

  for (const [, token] of text.matchAll(/`([^`\n]+)`/g)) {
    const clean = token.trim().replace(/[.,;:]+$/, "");
    if (!REPO_PATH.test(clean)) continue;
    if (GLOB_CHARS.some((char) => clean.includes(char))) continue;
    pathRefs += 1;
    if (!fs.existsSync(clean)) problems.push(`${file}: referenced path does not exist: ${clean}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`check-agents-md: ${problem}`);
  process.exit(1);
}

console.log(
  `check-agents-md: OK (${scriptRefs} npm script references, ${pathRefs} repository paths across ${files.length} files)`,
);
