/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { bidRowFromDollars } from "./lib/bidMoney";
import { buildTenancyFixture } from "./lib/tenancyFixtures";
import { projectSetupArgs } from "./lib/projectSetupFixture";
import { generalContractorNameFor, projectGcCompanyName, workingOnBehalfOf } from "./lib/gcCompanyName";
import { payAgentSystemPrompt } from "./agent/agentLoop";
import { reviewSystemPrompt, runPayAppReview, type ModelCaller } from "./payApps/reviewModel";
import { PAY_APP_REVIEW_FIXTURES } from "./payApps/reviewEvalFixtures";
import { DEFAULT_GENERAL_CONTRACTOR } from "./validation";

const modules = import.meta.glob("./**/*.ts");

describe("AI system prompts name TradePulse Pay and the GC company", () => {
  test("the pay agent prompt says it works on behalf of the given GC company", () => {
    const prompt = payAgentSystemPrompt("Bayview Builders Inc.");
    expect(prompt).toContain("TradePulse Pay, working on behalf of Bayview Builders Inc.");
    expect(prompt).not.toContain(DEFAULT_GENERAL_CONTRACTOR);
    expect(payAgentSystemPrompt(null)).toContain("TradePulse Pay, working on behalf of the general contractor");
  });

  test("the pay-app review prompt says it works on behalf of the given GC company", () => {
    const prompt = reviewSystemPrompt("Sonoran Interiors GC");
    expect(prompt).toContain("TradePulse Pay, working on behalf of Sonoran Interiors GC");
    expect(prompt).not.toContain(DEFAULT_GENERAL_CONTRACTOR);
    expect(workingOnBehalfOf("  ")).toBe("TradePulse Pay, working on behalf of the general contractor");
  });

  test("a model review sends and stores the company-specific system prompt", async () => {
    const fixture = PAY_APP_REVIEW_FIXTURES[0];
    let sent = "";
    const callModel: ModelCaller = async ({ system }) => {
      sent = system;
      const { rulesEngineJudgement } = await import("./payApps/reviewMath");
      return { judgement: rulesEngineJudgement(fixture.context), modelId: "m", inputTokens: 1, outputTokens: 1, rawResponse: "{}" };
    };
    const run = await runPayAppReview({ ...fixture.context, gcCompanyName: "Bayview Builders Inc." }, { apiKey: "k", modelId: "m" }, { callModel });
    expect(sent).toContain("TradePulse Pay, working on behalf of Bayview Builders Inc.");
    expect(run.systemPrompt).toBe(sent);
  });
});

describe("GC company name in generated documents", () => {
  test("project company lookups use the owning company, and only Demo projects keep the seeded name", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    await t.run(async (ctx) => {
      const a = (await ctx.db.get(f.gcA.project.projectId))!;
      const demo = (await ctx.db.get(f.demo.project.projectId))!;
      expect(await projectGcCompanyName(ctx, a)).toBe("Bayview Builders Inc.");
      expect(await generalContractorNameFor(ctx, a)).toBe("Bayview Builders Inc.");
      expect(await generalContractorNameFor(ctx, demo)).toBe(DEFAULT_GENERAL_CONTRACTOR);
      expect(await generalContractorNameFor(ctx, { ...a, generalContractorName: "Bayview Builders (West)" })).toBe("Bayview Builders (West)");
    });
  });

  test("createProject without a GC name stores the caller's company name", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const args = projectSetupArgs({
      title: "Camelback Suite 500",
      address: { line1: "2425 E Camelback Rd", city: "Phoenix", zip: "85016" },
      state: "AZ",
      projectType: "Tenant improvement",
    });
    const projectId = await f.gcB.admin.as.mutation(api.projects.createProject, args);
    const project = await t.run((ctx) => ctx.db.get(projectId));
    expect(project!.generalContractorName).toBe("Sonoran Interiors GC");
  });

  test("an agreement generated for a project without a GC name names the GC company, not the Demo default", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const ids = await t.run(async (ctx) => {
      const tradePackageId = await ctx.db.insert("tradePackages", {
        projectId: f.gcB.project.projectId,
        csiDivision: "09 00 00",
        tradeName: "Finishes",
        budgetEstimate: 30_000,
        agentMailbox: "fixture@example.invalid",
        agentMailboxId: "fixture",
        scopeSummary: "Drywall and paint",
        mandatoryInclusions: [],
        bidDeadline: "2026-12-01",
        status: "leveling",
      });
      const contractorId = await ctx.db.insert("contractors", {
        tradePackageId,
        companyName: "Desert Drywall",
        contactEmail: "bids@desertdrywall.invalid",
        licenseNumber: "0",
        licenseStatus: "Unverified",
        sourceUrl: "https://example.invalid",
        rfqStatus: "bid_received",
      });
      const bidId = await ctx.db.insert("bids", bidRowFromDollars({
        tradePackageId,
        contractorId,
        subcontractorName: "Desert Drywall",
        baseBidAmount: 25_000,
        lineItems: [],
        identifiedExclusions: [],
        longLeadEquipmentWeeks: 2,
        leadTimePenalty: 0,
        coiComplianceStatus: "compliant",
        coiPenalty: 0,
        leveledTotalCost: 25_000,
        isAwarded: false,
        receivedAt: Date.now(),
      }));
      return { tradePackageId, bidId };
    });
    const result = await f.gcB.admin.as.mutation(api.agreements.generateAgreement, ids);
    const agreement = await t.run((ctx) => ctx.db.get((result as { _id: Id<"agreements"> })._id));
    expect(agreement!.generalContractorName).toBe("Sonoran Interiors GC");
    expect(agreement!.contractText).toContain("Prepared in TradePulse Pay for Sonoran Interiors GC");
    expect(agreement!.contractText).not.toContain(DEFAULT_GENERAL_CONTRACTOR);
  });

  test("the pay agent and reviewer inputs carry the project's GC company name", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const payAppId = await t.run(async (ctx) =>
      ctx.db.insert("payApplications", {
        agreementId: f.gcA.project.agreementId,
        subUserId: f.sub.admin.userId,
        periodLabel: "Pay app #1",
        status: "submitted",
        lines: [],
        requestedTotalCents: 0,
        lienWaiver: true,
        notes: "",
        submittedBy: { userId: f.sub.admin.userId, actorType: "human" },
        createdAt: Date.now(),
      }),
    );
    const inputs = await t.query(internal.payApps.review.loadReviewInputs, { payAppId });
    expect(inputs!.context.gcCompanyName).toBe("Bayview Builders Inc.");
  });
});
