import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The docs verifier skips exactly one preserved historical snapshot and nothing else. Each test
 * runs the real scripts/tools/check-docs-links.mjs against an isolated fixture shaped like the
 * repository: a docs/ tree plus a root README.md.
 */
const CHECKER = fileURLToPath(new URL("./check-docs-links.mjs", import.meta.url));
const SNAPSHOT = "docs/evidence/release-2-2026-11-10/github-readme/README.github.md";

function write(root, relative, contents) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

/** The preserved snapshot mirrors the real one: repo-root-relative links stored one level down. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-docs-links-"));
  write(root, "README.md", "# Demo project\n\nRead the [judge guide](./docs/judge-guide.md).\n");
  write(root, "docs/judge-guide.md", "# Judge guide\n\nBack to [recovery](./recovery-progress.md).\n");
  write(root, "docs/recovery-progress.md", "# Recovery progress\n\nNo relative links here.\n");
  write(root, "docs/evidence/settlement/README.md", "# Settlement\n\nOpen the [report](./report.json).\n");
  write(root, "docs/evidence/settlement/report.json", '{"ok":true}\n');
  write(
    root,
    SNAPSHOT,
    [
      "# Preserved public README",
      "",
      "[judge guide](./docs/judge-guide.md)",
      "[environment](./.env.example)",
      "[license](./LICENSE)",
      "",
    ].join("\n"),
  );
  return root;
}

function run(root, roots = ["docs", "README.md"]) {
  return spawnSync(process.execPath, [CHECKER, ...roots], { cwd: root, encoding: "utf8" });
}

function usingFixture(body) {
  const root = fixture();
  try {
    return body(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const slashes = (value) => String(value ?? "").replace(/\\/g, "/");

test("skips the exact preserved snapshot and passes valid project evidence", () => {
  usingFixture((root) => {
    const snapshot = path.join(root, SNAPSHOT);
    const before = sha256(snapshot);
    const result = run(root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /OK: 3 relative links checked, all resolve/);
    // The snapshot's own links are broken from its preserved location and must not be reported.
    assert.doesNotMatch(slashes(result.stdout + result.stderr), /github-readme/);
    assert.equal(sha256(snapshot), before, "the excluded snapshot must stay byte-identical");
  });
});

test("still fails on broken project evidence outside the snapshot", () => {
  usingFixture((root) => {
    write(root, "docs/evidence/settlement/README.md", "# Settlement\n\nOpen the [report](./missing-report.json).\n");
    const result = run(root);
    assert.equal(result.status, 1, result.stdout);
    const output = slashes(result.stderr);
    assert.match(output, /FAIL: 1 broken link\(s\), 3 checked/);
    assert.match(output, /docs\/evidence\/settlement\/README\.md -> \.\/missing-report\.json/);
  });
});

test("still fails on a similarly named sibling of the preserved snapshot", () => {
  usingFixture((root) => {
    write(
      root,
      "docs/evidence/release-2-2026-11-10/github-readme-copy/README.github.md",
      "# Copy\n\n[judge guide](./docs/judge-guide.md)\n",
    );
    const result = run(root);
    assert.equal(result.status, 1, result.stdout);
    const output = slashes(result.stderr);
    assert.match(output, /FAIL: 1 broken link\(s\), 4 checked/);
    assert.match(output, /github-readme-copy\/README\.github\.md -> \.\/docs\/judge-guide\.md/);
  });
});

test("still fails when the same directory name sits under a different evidence parent", () => {
  usingFixture((root) => {
    write(
      root,
      "docs/evidence/release-3-2026-11-11/github-readme/README.github.md",
      "# Other release\n\n[judge guide](./docs/judge-guide.md)\n",
    );
    const result = run(root);
    assert.equal(result.status, 1, result.stdout);
    const output = slashes(result.stderr);
    assert.match(output, /FAIL: 1 broken link\(s\), 4 checked/);
    assert.match(output, /release-3-2026-11-11\/github-readme\/README\.github\.md -> \.\/docs\/judge-guide\.md/);
  });
});

test("still fails on ordinary docs links", () => {
  usingFixture((root) => {
    write(root, "docs/judge-guide.md", "# Judge guide\n\n[missing page](./missing-guide.md)\n");
    const result = run(root);
    assert.equal(result.status, 1, result.stdout);
    const output = slashes(result.stderr);
    assert.match(output, /FAIL: 1 broken link\(s\), 3 checked/);
    assert.match(output, /docs\/judge-guide\.md -> \.\/missing-guide\.md/);
  });
});
