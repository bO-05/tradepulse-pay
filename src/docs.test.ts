import { describe, expect, test } from "vitest";

/**
 * Submission docs checks: the Postman collection is complete, described and secret-free, and the
 * APIMatic log only points at files that exist and is honest about what the plugin covered.
 */
const postmanFiles = import.meta.glob("../docs/postman/*.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const docFiles = import.meta.glob(["../docs/apimatic-log.md", "../README.md"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Lazy globs: only the keys are used, to check that referenced repo files exist.
const repoFiles = new Set(
  Object.keys(import.meta.glob(["../convex/**/*.ts", "../src/**/*.{ts,tsx}", "../docs/**/*", "../scripts/**/*"])).map(
    (k) => k.replace(/^\.\.\//, ""),
  ),
);

const COLLECTION = "../docs/postman/TradePulse-Pay.postman_collection.json";
const ENVIRONMENT = "../docs/postman/TradePulse-Pay-sandbox.postman_environment.json";

type Item = {
  name: string;
  description?: string;
  item?: Item[];
  request?: { method: string; url: { raw: string } | string; description?: string };
};

function requests(items: Item[]): Item[] {
  return items.flatMap((i) => (i.item ? requests(i.item) : [i]));
}

function rawUrl(i: Item): string {
  const u = i.request?.url;
  return typeof u === "string" ? u : (u?.raw ?? "");
}

function descriptionOf(i: Item): string {
  const d = i.request?.description ?? i.description;
  return typeof d === "string" ? d : ((d as { content?: string } | undefined)?.content ?? "");
}

describe("Postman collection", () => {
  const collection = JSON.parse(postmanFiles[COLLECTION] ?? "null") as {
    info: { schema: string; description?: string };
    item: Item[];
    variable?: { key: string; value?: string }[];
  } | null;

  test("exists and declares the v2.1 schema", () => {
    expect(collection).not.toBeNull();
    expect(collection!.info.schema).toBe("https://schema.getpostman.com/json/collection/v2.1.0/collection.json");
  });

  test("every request has a non-empty description", () => {
    const all = requests(collection!.item);
    expect(all.length).toBeGreaterThan(10);
    const missing = all.filter((i) => descriptionOf(i).trim().length === 0).map((i) => i.name);
    expect(missing).toEqual([]);
  });

  test("covers our HTTP endpoints and the PayPal sandbox calls the app uses", () => {
    const urls = requests(collection!.item).map((i) => `${i.request!.method} ${rawUrl(i)}`);
    const expected = [
      /^GET \{\{convexSite\}\}\/api\/health$/,
      /^GET \{\{convexSite\}\}\/llms\.txt$/,
      /^POST \{\{convexSite\}\}\/paypal\/webhook$/,
      /^POST \{\{convexSite\}\}\/ai\/studio$/,
      /^POST \{\{paypalBase\}\}\/v1\/oauth2\/token$/,
      /^POST \{\{paypalBase\}\}\/v2\/checkout\/orders$/,
      /^POST \{\{paypalBase\}\}\/v2\/checkout\/orders\/\{\{orderId\}\}\/authorize$/,
      /^POST \{\{paypalBase\}\}\/v2\/payments\/authorizations\/\{\{authorizationId\}\}\/capture$/,
      /^POST \{\{paypalBase\}\}\/v2\/payments\/authorizations\/\{\{authorizationId\}\}\/void$/,
      /^POST \{\{paypalBase\}\}\/v1\/payments\/payouts$/,
      /^GET \{\{paypalBase\}\}\/v1\/payments\/payouts\/\{\{payoutBatchId\}\}$/,
      /^POST \{\{paypalBase\}\}\/v2\/invoicing\/invoices$/,
      /^POST \{\{paypalBase\}\}\/v2\/invoicing\/invoices\/\{\{invoiceId\}\}\/send$/,
      /^GET \{\{paypalBase\}\}\/v2\/invoicing\/invoices\/\{\{invoiceId\}\}$/,
      /^POST \{\{paypalBase\}\}\/v1\/notifications\/verify-webhook-signature$/,
    ];
    for (const re of expected) expect(urls.some((u) => re.test(u)), re.source).toBe(true);
    expect(urls.some((u) => /api-m\.paypal\.com/.test(u))).toBe(false);
  });

  test("documents the unsigned replay as 400 and the dedupe behavior", () => {
    const replay = requests(collection!.item).filter((i) => rawUrl(i).endsWith("/paypal/webhook"));
    expect(replay.length).toBeGreaterThanOrEqual(2);
    const text = replay.map(descriptionOf).join("\n");
    expect(text).toMatch(/400/);
    expect(text).toMatch(/verified=false/);
    expect(text).toMatch(/one `paypalEvents` row/i);
  });

  test("contains no secret values", () => {
    for (const [file, raw] of Object.entries(postmanFiles)) {
      expect(raw, file).not.toMatch(/Bearer [A-Za-z0-9._-]{20,}/);
      expect(raw, file).not.toMatch(/A21AA[A-Za-z0-9_-]{20,}/);
      expect(raw, file).not.toMatch(new RegExp(`${["sk", "ant", ""].join("-")}[A-Za-z0-9_-]+`));
      expect(raw, file).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/);
    }
    const secretKeys = ["clientId", "clientSecret", "accessToken", "convexAuthToken", "webhookId"];
    for (const v of collection!.variable ?? []) {
      if (secretKeys.includes(v.key)) expect(v.value ?? "", v.key).toBe("");
    }
    const env = JSON.parse(postmanFiles[ENVIRONMENT] ?? "null") as { values: { key: string; value: string }[] } | null;
    expect(env).not.toBeNull();
    for (const v of env!.values) if (secretKeys.includes(v.key)) expect(v.value, v.key).toBe("");
  });

  test("the environment file holds variable names only, and empty values fall back to collection defaults", () => {
    const env = JSON.parse(postmanFiles[ENVIRONMENT] ?? "null") as { values: { key: string; value: string }[] } | null;
    expect(env!.values.length).toBeGreaterThan(5);
    for (const v of env!.values) expect(v.value, v.key).toBe("");
    const defaults = (collection!.variable ?? []).filter((v) => (v.value ?? "") !== "").map((v) => v.key);
    expect(defaults).toEqual(expect.arrayContaining(["convexSite", "paypalBase", "replayEventId", "payoutSenderBatchId", "webhookAuthAlgo"]));
    const raw = JSON.parse(postmanFiles[COLLECTION] ?? "null") as { event?: { listen: string; script: { exec: string[] } }[] };
    const pre = (raw.event ?? []).find((e) => e.listen === "prerequest")?.script.exec.join("\n") ?? "";
    expect(pre).toContain("pm.collectionVariables.toObject()");
    expect(pre).toContain('pm.environment.get(key) === ""');
    expect(pre).toContain("pm.variables.set(key, fallback)");
  });
});

describe("APIMatic log", () => {
  const log = docFiles["../docs/apimatic-log.md"] ?? "";

  test("names plugin tools and concrete SDK methods", () => {
    for (const tool of ["fetch_api", "ask", "endpoint_search", "model_search"]) expect(log).toContain(`\`${tool}\``);
    for (const m of [
      "OrdersController.createOrder",
      "OrdersController.authorizeOrder",
      "PaymentsController.captureAuthorizedPayment",
      "PaymentsController.voidPayment",
    ]) {
      expect(log).toContain(m);
    }
  });

  test("states that Payouts and Invoicing used plain REST, not the plugin", () => {
    expect(log).toMatch(/coverage is limited to Orders and Payments/i);
    expect(log).toMatch(/Payouts[^\n]*Invoicing[^\n]*plain REST/);
  });

  test("references only repo files that exist", () => {
    const refs = [...log.matchAll(/`((?:convex|src|docs|scripts)\/[^`:\s]+\.[a-z]+)(?::[\d-]+)?`/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(5);
    const missing = [...new Set(refs)].filter((r) => !repoFiles.has(r));
    expect(missing).toEqual([]);
  });

  test("README links the collection and the log", () => {
    const readme = docFiles["../README.md"] ?? "";
    expect(readme).toContain("docs/postman/TradePulse-Pay.postman_collection.json");
    expect(readme).toContain("docs/apimatic-log.md");
  });
});
