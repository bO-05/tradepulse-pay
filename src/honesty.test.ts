import { expect, test } from "vitest";

/**
 * Claims-integrity regression checks.
 *
 * These assert the source of the user-facing surfaces still tells the truth:
 * no fabricated registry verification, no canned-document download, no
 * "parity / zero cheating" eval framing. If someone reintroduces those strings,
 * this suite fails before the claims reach the deployment.
 */
const componentSources = import.meta.glob("./components/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const libSources = import.meta.glob("./lib/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const rootSources = import.meta.glob("./*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const convexSources = import.meta.glob("../convex/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const libConvexSources = import.meta.glob("../convex/lib/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function find(pathFragment: string, sources: Record<string, string>): string {
  const key = Object.keys(sources).find((k) => k.endsWith(pathFragment));
  if (!key) throw new Error(`Source not found: ${pathFragment}`);
  return sources[key];
}

test("Discovery never claims registry verification for unverified records", () => {
  const discovery = find("contractorDiscovery.ts", convexSources);
  expect(discovery).not.toContain("835-24");
  expect(discovery).not.toContain("20000 + i * 142");
  expect(discovery).not.toContain("Firecrawl Live Web Discovery");
  expect(discovery).not.toContain("Built-in sample directory");
  expect(discovery).toContain("Unverified — from web search result");
  expect(discovery).toContain("no usable results");

  const view = find("SubcontractorDiscoveryView.tsx", componentSources);
  expect(view).not.toContain("Verified Trades");
  expect(view).not.toContain("Live Web & TDLR Directory Ingest");
  expect(view).toContain("Provenance shown per record");
});

test("File download serves stored bytes and never synthesises documents from the filename", () => {
  const view = find("ProjectFilesView.tsx", componentSources);
  expect(view).not.toContain("getRealDocumentPdfBytes(");
  expect(view).not.toContain("getRealDocumentText(");
  expect(view).not.toContain("100% Real Construction Document Specification");
  expect(view).toContain("resolveStoredFileUrl");

  const helper = find("storedFile.ts", libSources);
  expect(helper).toContain("resolveStoredFileUrl");
});

test("Eval surface is labeled as an extraction/normalization check with a real holdout", () => {
  const diagnostics = find("SponsorDiagnosticsView.tsx", componentSources);
  expect(diagnostics).not.toContain("Zero Cheating");
  expect(diagnostics).not.toContain("PARITY ACHIEVED");
  expect(diagnostics).not.toContain("Chief Estimator Ground-Truth Evaluation Suite");
  expect(diagnostics).toContain("Bid Extraction & ADR-0003 Normalization Check");
  expect(diagnostics).toContain("Holdout");
  expect(diagnostics).toContain("states no total at all");

  const evals = find("evals.ts", convexSources);
  expect(evals).toContain("case-holdout-26-01");
  expect(evals).toContain("isHoldout: true");
  expect(evals).toContain("holdoutMape");
});

test("Sponsor status cards do not overclaim availability or registry verification", () => {
  const diagnostics = find("SponsorDiagnosticsView.tsx", componentSources);
  expect(diagnostics).not.toContain("TDLR & TSBPE");
  expect(diagnostics).not.toContain("Primary LLM Reasoning");
  expect(diagnostics).not.toContain("satisfying 100% of the hackathon judging rubric");
  expect(diagnostics).toContain("Adapter Ready / Key Required");
  expect(diagnostics).toContain("provenance-first");
});

test("Tour narration does not hard-code demo dollar figures or verification claims", () => {
  const tour = find("InvestorDemoTourBar.tsx", componentSources);
  expect(tour).not.toContain("$61k-$96k");
  expect(tour).not.toContain("100% TDLR Validated");
  expect(tour).not.toContain("$1,225,000 Subcontract Sealed");
  // Narrative is built from live context.
  expect(tour).toContain("buildDemoScenes");
  expect(tour).toContain("runnerUpBaseCost");
});

test("Lead-time adjustment copy is not presented as contract liquidated damages", () => {
  const docs = find("realDocuments.ts", convexSources);
  expect(docs).not.toContain("liquidated damages at $6,000/week");
  expect(docs).toContain("LEAD-TIME DELAY ADJUSTMENT");
});

test("Model diagnostics disclose unavailable providers instead of silently grading another one", () => {
  const router = find("llmRouter.ts", convexSources);
  expect(router).toContain("getProviderAvailability");
  expect(router).toContain("No fallback provider was invoked");
  expect(router).toContain("unavailable: true");

  const diagnostics = find("SponsorDiagnosticsView.tsx", componentSources);
  expect(diagnostics).toContain("Adapter ready —");
  expect(diagnostics).toContain("getProviderAvailability");
  // No implied measured throughput hard-coded on the provider cards.
  expect(diagnostics).not.toContain("m.throughput");
  expect(diagnostics).not.toContain("305");
});

test("F3: the New Project form uses placeholders, not silent prefilled values", () => {
  const header = find("Header.tsx", componentSources);
  expect(header).toContain('placeholder="e.g. Austin, TX"');
  expect(header).toContain('placeholder="e.g. 5500000"');
  expect(header).not.toContain('useState("Austin, TX")');
  expect(header).not.toContain('useState("Class-A Commercial Mixed-Use")');
  expect(header).not.toContain("useState(5500000)");
  expect(header).not.toContain("useState(52)");
  expect(header).toContain("validateNewProjectFields");
});

test("F4: the leveling simulate control's label matches what it opens", () => {
  const levelingView = find("BidLevelingMatrixView.tsx", componentSources);
  expect(levelingView).not.toContain("Simulate Inbound Bid…");
  expect(levelingView).toContain("Open Demo Simulation…");
  expect(levelingView).toContain("Scenario B (deceptive bid)");
});

test("F6: the RFI form sends an explicit target trade package", () => {
  const qna = find("PreBidQnAView.tsx", componentSources);
  expect(qna).toContain("tradePackageId: targetPackage._id");
  expect(qna).toContain("Routing to:");
});

test("F7: the PM queue button does not use white text on amber-600", () => {
  const qna = find("PreBidQnAView.tsx", componentSources);
  expect(qna).not.toMatch(/bg-amber-600[^"]*text-white/);
  expect(qna).toContain("bg-amber-400 hover:bg-amber-300 text-slate-950");
});

test("F5: each stage exposes one primary next-step CTA and no duplicated empty-state action", () => {
  const leveling = find("BidLevelingMatrixView.tsx", componentSources);
  expect((leveling.match(/Advance to Scope Clash Engine/g) || []).length).toBe(1);
  expect(leveling).not.toContain('Scope Clash Engine\n              </button>');

  const discovery = find("SubcontractorDiscoveryView.tsx", componentSources);
  expect((discovery.match(/Advance to Pre-Bid Q&A/g) || []).length).toBe(1);
  expect(discovery).toContain("Skip to leveling");

  const packages = find("TradePackagesView.tsx", componentSources);
  expect(packages).not.toContain("Run AI Spec Breakdown");
  expect(packages).toContain("in the header above to get started");
});

test("F9: inbox copy reflects plan-limit sharing, never a 'dedicated' claim", () => {
  const tour = find("InvestorDemoTourBar.tsx", componentSources);
  expect(tour).not.toContain("Dedicated AgentMail Inboxes");
  expect(tour).not.toMatch(/dedicated programmatic @agentmail\.to inbox/i);
  expect(tour).toContain("packages share an inbox once the plan limit is reached");

  const http = find("http.ts", convexSources);
  expect(http).toContain("shared when the free-tier plan limit is reached");
  expect(http).not.toContain("Dedicated Stateful Project Inboxes");

  const diag = find("SponsorDiagnosticsView.tsx", componentSources);
  expect(diag).not.toContain("Dedicated Stateful Project Inboxes");
});

test("F12: 'Buyout' means the dollar forecast; award counts use award wording", () => {
  const kpi = find("ExecutiveKpiBar.tsx", componentSources);
  // "Buyout" may only appear as "Leveled Buyout" (the dollar figure), never as a bare award counter.
  const buyoutOccurrences = (kpi.match(/Buyout: <strong/g) || []).length;
  const leveledBuyoutOccurrences = (kpi.match(/Leveled Buyout: <strong/g) || []).length;
  expect(buyoutOccurrences).toBe(leveledBuyoutOccurrences);
  expect(kpi).toContain("Subcontracts: <strong");
  expect(kpi).toContain("Subcontract Awards");
});

test("FIX-NEW-02: no UI surface claims a Gemini version that is not configured", () => {
  for (const [path, source] of Object.entries(componentSources)) {
    if (path.includes("SponsorDiagnosticsView")) {
      // The diagnostics view must read the configured model, not hard-code one.
      expect(source).toContain("Configured model:");
      continue;
    }
    expect(source, `${path} must not claim Gemini 3.8 Flash`).not.toContain("Gemini 3.8 Flash");
  }
  const app = find("App.tsx", rootSources);
  expect(app).not.toContain("Gemini 3.8 Flash");
  const http = find("http.ts", convexSources);
  expect(http).not.toContain("Gemini 3.8 Flash");
});

test("F2: no surface hard-codes the bid-based buyout label or a budget savings percent", () => {
  const kpi = find("ExecutiveKpiBar.tsx", componentSources);
  expect(kpi).not.toContain("(best bid per package)");
  expect(kpi).toContain("leveledBuyoutShort");
  expect(kpi).toContain("varianceIsLeveled");
  const leveling = find("leveling.ts", rootSources);
  expect(leveling).toContain("leveledBuyoutCaption");
  expect(leveling).toContain("varianceIsLeveled");
});
test("Offline fallbacks are labeled 'Offline rules engine' and never claim an OpenAI model ran", () => {
  for (const file of ["llmRouter.ts", "evals.ts", "files.ts", "emailActions.ts"]) {
    const src = find(file, convexSources);
    expect(src).not.toContain("OpenAI-SimulationEngine");
    expect(src).not.toContain("gpt-4o-deterministic-cache");
    expect(src).not.toContain("gpt-4o-bid-leveler");
  }
  expect(find("llmRouter.ts", convexSources)).toContain("provider: OFFLINE_RULES_ENGINE");
  expect(find("lib/aiLabels.ts", libConvexSources)).toContain('OFFLINE_RULES_ENGINE = "Offline rules engine"');
});

test("License UI never calls a license verified; only an active CSLB result is shown as positive", async () => {
  const license = (await import("./payments/LicenseCheck.tsx?raw")).default as string;
  const reviews = (await import("./payments/PayAppReviews.tsx?raw")).default as string;
  for (const src of [license, reviews]) {
    expect(src).not.toMatch(/>\s*Verified\b|"Verified"|License verified/);
  }
  expect(license).toContain('unverified: { label: "License unverified"');
  expect(license).toContain('none: { label: "No license check yet"');
  expect(reviews).toContain('none: "No license check yet"');
});
