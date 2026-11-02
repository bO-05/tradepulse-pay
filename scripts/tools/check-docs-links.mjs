import fs from "node:fs";
import path from "node:path";

/**
 * Root-purpose tool: every file we ship for judges must resolve offline.
 * Scans Markdown and HTML under the given roots for relative src/href links
 * (and markdown links) and fails if a target is missing. External http(s),
 * data:, #fragment and mailto: links are ignored.
 *
 * Usage: node scripts/tools/check-docs-links.mjs [root...]   (default: docs)
 */

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["docs"];
const problems = [];
let checked = 0;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // Private reviewer material is local evidence, not a judge-facing deliverable.
    if (entry.isDirectory() && path.resolve(full) === path.resolve("docs/external-audit")) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(html?|md)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function stripAnchors(link) {
  return link.split("#")[0].split("?")[0];
}

function isExternal(link) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(link);
}

function resolveTarget(file, link) {
  const clean = decodeURIComponent(stripAnchors(link.trim()));
  if (!clean) return null;
  if (clean.startsWith("/")) return path.join(process.cwd(), clean.slice(1));
  return path.resolve(path.dirname(file), clean);
}

for (const root of roots) {
  if (!fs.existsSync(root)) {
    problems.push(`${root}: root does not exist`);
    continue;
  }
  const files = fs.statSync(root).isDirectory() ? walk(root) : [root];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const links = [];
    for (const m of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) links.push(m[1]);
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) links.push(m[1]);
    for (const link of links) {
      if (isExternal(link) || link.startsWith("data:")) continue;
      const target = resolveTarget(file, link);
      if (!target) continue;
      checked++;
      if (!fs.existsSync(target)) problems.push(`${file} -> ${link} (missing: ${path.relative(process.cwd(), target)})`);
    }
  }
}

if (problems.length) {
  console.error(`FAIL: ${problems.length} broken link(s), ${checked} checked`);
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log(`OK: ${checked} relative links checked, all resolve`);