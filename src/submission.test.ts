import { describe, expect, test } from "vitest";

/**
 * Submission hygiene: the README tells the truth about the deployment and the checks, `.env.example`
 * names every variable the code reads (with no secret values), and legacy scripts are marked legacy.
 */
const raw = (files: Record<string, unknown>) => files as Record<string, string>;

const rootFiles = raw(
  import.meta.glob(["../README.md", "../LICENSE", "../.env.example", "../package.json", "../vite.config.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);
const appSources = raw(
  import.meta.glob(["../convex/**/*.ts", "../src/**/*.{ts,tsx}", "!../convex/_generated/**", "!../**/*.test.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);
const legacyPython = raw(import.meta.glob("../tests/*.py", { query: "?raw", import: "default", eager: true }));
const scriptSources = raw(import.meta.glob("../scripts/**/*.mjs", { query: "?raw", import: "default", eager: true }));

const README = rootFiles["../README.md"];
const ENV_EXAMPLE = rootFiles["../.env.example"];

const LEGACY_SCRIPTS = [
  "scripts/qa/live-smoke.mjs",
  "scripts/run-expert-evals.mjs",
  "scripts/run-real-world-benchmark.mjs",
  "scripts/verify-deep-real-world.mjs",
  "scripts/verify-real-world-edge-cases.mjs",
  "scripts/test-run-model-diagnostic.mjs",
  "scripts/test-all-models-live.mjs",
  "scripts/inspect-live-db.mjs",
  "scripts/inspect-live-prod.mjs",
  "scripts/verify-prod.mjs",
];

function section(heading: string): string {
  const start = README.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`README section missing: ${heading}`);
  const next = README.indexOf("\n## ", start + heading.length + 2);
  return README.slice(start, next === -1 ? undefined : next);
}

describe("README", () => {
  test("is rebranded and has the required sections", () => {
    expect(README.startsWith("# TradePulse Pay\n")).toBe(true);
    for (const heading of [
      "## The problem",
      "## The pitch",
      "## What changed since Oct 1",
      "## Architecture",
      "## Setup and run",
      "## Demo accounts and password",
      "## Guest test card (PayPal sandbox)",
      "## Billing-agent sign-in (AgentID)",
      "## Which integrations are live and which fall back",
      "## Tools used and how",
      "## Verification",
      "## License",
    ]) {
      expect(README, heading).toContain(`\n${heading}\n`);
    }
  });

  test("documents the commit range, demo accounts, password, guest card and setup", () => {
    expect(section("## What changed since Oct 1")).toMatch(/2ad5543\.\.paypal-hackathon/);
    const accounts = section("## Demo accounts and password");
    for (const who of ["gc", "sub1", "sub2", "sub3", "owner"]) expect(accounts).toContain(`${who}@demo.tradepulse`);
    expect(accounts).toContain("TradePulseDemo!2026");
    const card = section("## Guest test card (PayPal sandbox)");
    for (const v of ["4032031427005060", "01/29", "480"]) expect(card).toContain(v);
    const setup = section("## Setup and run");
    for (const step of ["npm ci", "npx convex dev --once", ".env.example", "http://localhost:3150", "demoAccounts:seedDemo"]) {
      expect(setup, step).toContain(step);
    }
  });

  test("describes AgentID sign-in and GC linking without credentials", () => {
    const agent = section("## Billing-agent sign-in (AgentID)");
    expect(agent).toContain("Continue with AgentID");
    expect(agent).toContain("Billing agents");
    expect(agent).toContain("Agent not authorized");
    expect(agent).not.toMatch(/am_[A-Za-z0-9]{8,}/);
  });

  test("names every sponsor tool and links the Postman collection and APIMatic log", () => {
    const tools = section("## Tools used and how");
    for (const tool of ["PayPal", "Anthropic", "AG Studio", "APIMatic", "Postman", "KERNEL", "AgentID / AgentMail", "Firecrawl", "Convex"]) {
      expect(tools, tool).toContain(`**${tool}**`);
    }
    expect(README).toContain("./docs/postman/TradePulse-Pay.postman_collection.json");
    expect(README).toContain("./docs/apimatic-log.md");
    expect(section("## Which integrations are live and which fall back")).toMatch(/shared/);
    expect(section("## Which integrations are live and which fall back")).toContain("Offline rules engine");
  });

  test("never presents brainy-skunk-440 as the TradePulse Pay deployment", () => {
    const lines = README.split("\n").filter((l) => l.includes("brainy-skunk-440"));
    expect(lines.length).toBeLessThanOrEqual(2);
    for (const l of lines) expect(l).toMatch(/frozen|refuse/);
    expect(README).not.toMatch(/https:\/\/brainy-skunk-440/);
  });

  test("states the MIT license, matching LICENSE", () => {
    expect(rootFiles["../LICENSE"].startsWith("MIT License")).toBe(true);
    expect(README).toMatch(/MIT licensed/);
  });

  test("verification commands exclude the legacy Python tests and pre-auth scripts", () => {
    const blocks = [...section("## Verification").matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
    expect(blocks).toContain("npx tsc -b");
    expect(blocks).toContain("npx vitest run --maxWorkers=2");
    expect(blocks).toContain("npm run build");
    expect(blocks).not.toMatch(/python|\.py\b|smoke:live|npm run (evals|benchmark)|scripts\/(qa\/live-smoke|audit7)/);
    for (const s of [...LEGACY_SCRIPTS, "tests/test_tradepulse.py", "tests/verify_setup.py"]) {
      expect(section("## Verification"), s).toContain(s);
    }
  });
});

describe("legacy files", () => {
  test("Python tests carry a legacy header and nothing runs them", () => {
    for (const name of ["../tests/test_tradepulse.py", "../tests/verify_setup.py"]) {
      expect(legacyPython[name], name).toMatch(/^# LEGACY\b/);
    }
    expect(rootFiles["../package.json"]).not.toMatch(/test_tradepulse|verify_setup/);
    for (const [file, src] of Object.entries(scriptSources)) expect(src, file).not.toMatch(/test_tradepulse\.py|verify_setup\.py/);
  });

  test("pre-auth Node scripts carry a legacy header", () => {
    const audit7 = Object.keys(scriptSources).filter((k) => k.startsWith("../scripts/audit7/"));
    expect(audit7.length).toBeGreaterThan(5);
    for (const file of [...LEGACY_SCRIPTS.map((s) => `../${s}`), ...audit7]) {
      expect(scriptSources[file], file).toBeDefined();
      expect(scriptSources[file].slice(0, 400), file).toContain("LEGACY, pre-auth script");
    }
  });

  test("the AgentMail webhook setup requires CONVEX_SITE_URL and has no deployment default", () => {
    const src = scriptSources["../scripts/setup-agentmail-webhook.mjs"];
    expect(src).toContain("CONVEX_SITE_URL is required");
    expect(src).not.toMatch(/https:\/\/brainy-skunk-440/);
    expect(src).not.toMatch(/console\.log\([^)]*\$\{secret\}/);
  });
});

describe("app code", () => {
  test("has no fallback to the frozen brainy-skunk-440 deployment", () => {
    for (const [file, src] of Object.entries({ ...appSources, "../vite.config.ts": rootFiles["../vite.config.ts"] })) {
      expect(src, file).not.toContain("brainy-skunk-440");
    }
  });
});

describe(".env.example", () => {
  const BUILT_INS = new Set(["MODE", "DEV", "PROD", "SSR", "BASE_URL"]);
  const ALLOWED_VALUES = new Set(["sandbox", "claude-sonnet-5-5", "http://localhost:3150", "us-central1"]);

  const entries = ENV_EXAMPLE.split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const);
  const declared = new Set(entries.map(([k]) => k));

  test("lists every env var name read in convex/ and src/", () => {
    const used = new Set<string>();
    for (const src of Object.values(appSources)) {
      for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) used.add(m[1]);
      for (const m of src.matchAll(/import\.meta\.env\.([A-Z0-9_]+)/g)) if (!BUILT_INS.has(m[1])) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(20);
    expect([...used].filter((n) => !declared.has(n)).sort()).toEqual([]);
    for (const n of ["PAYPAL_SANDBOX_GC_BUYER_EMAIL", "PAYPAL_SANDBOX_OWNER_EMAIL", "JWT_PRIVATE_KEY", "JWKS", "VITE_PAYPAL_CLIENT_ID"]) {
      expect(declared.has(n), n).toBe(true);
    }
  });

  test("has no values except non-secret literals", () => {
    const populated = entries.filter(([, v]) => v !== "" && !ALLOWED_VALUES.has(v));
    expect(populated).toEqual([]);
  });
});
