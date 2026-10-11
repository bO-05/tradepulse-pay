/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { bidRowFromDollars } from "./lib/bidMoney";
import { buildTenancyFixture } from "./lib/tenancyFixtures";

const modules = import.meta.glob("./**/*.ts");

/** Captures the system prompt of every Anthropic call; no other provider is configured. */
function stubAnthropic() {
  const systems: string[] = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.anthropic.com/")) return new Response("unexpected", { status: 500 });
    systems.push(JSON.parse(String(init?.body)).system);
    return new Response(JSON.stringify({ content: [{ type: "text", text: "{\"doubleBuys\":[],\"scopeVoids\":[]}" }] }), { status: 200 });
  }) as typeof fetch);
  return systems;
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
  for (const name of ["OPENAI_API_KEY", "GEMINI_API_KEY", "VERTEX_API_KEY", "VERTEX_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT"]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("both coordination reasoning paths name TradePulse Pay and the project's GC company in the system prompt", async () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  const fx = await buildTenancyFixture(t);
  const projectId = fx.gcA.project.projectId;
  await t.run(async (ctx) => {
    const hvac = await ctx.db.insert("tradePackages", {
      projectId,
      csiDivision: "23 00 00",
      tradeName: "HVAC",
      budgetEstimate: 60_000,
      agentMailbox: "fixture@example.invalid",
      agentMailboxId: "fixture",
      scopeSummary: "Rooftop units and VFDs",
      mandatoryInclusions: [],
      bidDeadline: "2026-12-01",
      status: "bidding",
    });
    const contractorId = await ctx.db.insert("contractors", {
      tradePackageId: hvac,
      companyName: "Lakeshore Mechanical",
      contactEmail: "ray@lakeshore.test",
      licenseNumber: "0",
      licenseStatus: "Unverified",
      sourceUrl: "https://example.invalid",
      rfqStatus: "bid_received",
    });
    await ctx.db.insert("bids", bidRowFromDollars({
      tradePackageId: hvac,
      contractorId,
      subcontractorName: "Lakeshore Mechanical",
      baseBidAmount: 50_000,
      lineItems: [],
      identifiedExclusions: [],
      longLeadEquipmentWeeks: 4,
      leadTimePenalty: 0,
      coiComplianceStatus: "compliant",
      coiPenalty: 0,
      leveledTotalCost: 50_000,
      isAwarded: false,
      receivedAt: Date.now(),
    }));
  });

  const systems = stubAnthropic();
  const scan = await fx.gcA.admin.as.action(api.coordination.scanCrossTradeClashes, { projectId });
  expect(scan.analyzed).toBe(true);
  await fx.gcA.admin.as.action(api.coordination.extractDynamicClashes, { projectId });

  expect(systems).toHaveLength(2);
  for (const system of systems) {
    expect(system).toContain("TradePulse Pay");
    expect(system).toContain("Bayview Builders Inc.");
    expect(system).not.toContain("Sonoran Interiors GC");
  }
});
