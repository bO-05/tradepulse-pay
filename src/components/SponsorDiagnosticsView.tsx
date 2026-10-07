import React, { useEffect, useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { formatFullDateTime } from "../lib/datetime.ts";
import { PayAppEvalPanel } from "../dashboard/PayAppEvalPanel";
import {
  Activity,
  CheckCircle2,
  ShieldCheck,
  Database,
  Bot,
  Globe,
  Mail,
  FileText,
  Cpu,
  Play,
  Sparkles,
  RefreshCw,
  Download,
  Eye,
  Scale,
} from "lucide-react";

const CONVEX_SITE_URL =
  (import.meta.env.VITE_CONVEX_SITE_URL as string | undefined)?.replace(/\/+$/, "") ||
  ((import.meta.env.VITE_CONVEX_URL as string | undefined) ?? "").replace(/\.convex\.cloud\/?$/, ".convex.site");

/**
 * A6-13: only used when the live /llms.txt fetch fails; the panel prefers the
 * live endpoint so its copy can never drift from what the deployment serves.
 */
const LLMS_FALLBACK_TEXT = `# TradePulse Pro - Autonomous Construction Procurement API
> Autonomous Trade Subcontractor Procurement, RFQ Distribution & Real-Time Bid Leveling
> Built for the Convex "All Gas" Hackathon 2026

## Overview
TradePulse Pro automates the $1.8T commercial construction subcontractor procurement workflow:
1. CSI MasterFormat Trade Scoping (Div 22 Plumbing, Div 23 HVAC, Div 26 Electrical)
2. Subcontractor Web Discovery & Licensing Verification via Firecrawl
3. Programmatic Project Inboxes via AgentMail (@agentmail.to) - shared when the free-tier plan limit is reached, disclosed on each package
4. Autonomous Pre-Bid RFI Clarifications via OpenAI, Gemini & Claude reasoning (OpenAI is a BYOK adapter; Gemini/Claude run when no OpenAI key is configured)
5. Forensic Bid Leveling & Scope Gap Normalization via Claude & OpenAI (OpenAI is a BYOK adapter; Claude runs when no OpenAI key is configured)
6. A401-style Subcontract Draft Generation (not an AIA-licensed form)

## Live Endpoints
- Web UI: ${CONVEX_SITE_URL}
- Webhook Ingest: POST ${CONVEX_SITE_URL}/agentmail/webhook
- Discoverability: GET ${CONVEX_SITE_URL}/llms.txt
- Reactive Engine: Convex Realtime WebSockets (Zero Polling Invariant)

## Normalization Formula (ADR-0003)
Leveled Cost = Base Bid + Sum(Scope Gaps) + Lead Time Penalty + COI Penalty - Accepted Alternates`;

export const SponsorDiagnosticsView: React.FC = () => {
  // Real-World Chief Estimator Evaluation State & Telemetry
  const latestEvalData = useQuery((api as any).evals.getLatestEvalRun, {});
  const providerAvailability = useQuery((api as any).llmRouter.getProviderAvailability, {});
  const executeEvalSuiteAction = useAction((api as any).evals.executeEvalSuite);
  const [isRunningEvals, setIsRunningEvals] = useState<boolean>(false);
  const [expandedTraceCaseId, setExpandedTraceCaseId] = useState<string | null>(null);
  const [evalStatusMsg, setEvalStatusMsg] = useState<string | null>(null);
  // A6-13: the /llms.txt panel must show the live endpoint, not a stale snapshot.
  const [llmsText, setLlmsText] = useState<string | null>(null);
  const [llmsLive, setLlmsLive] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/llms.txt")
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => {
        if (!cancelled && text.trim().length > 0) {
          setLlmsText(text.trim());
          setLlmsLive(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLlmsLive(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRunExpertEvals = async () => {
    setIsRunningEvals(true);
    setEvalStatusMsg("Running the 13-case extraction, holdout and cross-trade evaluation plus the 4 pay-app review fixtures against live backend...");
    try {
      const res = await executeEvalSuiteAction({
        targetEnvironment: "prod",
        triggeredBy: "judge_diagnostics",
      });
      setEvalStatusMsg(`Run ${res.runId} completed. Extraction matches: ${res.passedCases}/${res.totalCases} • Holdout (answer not in prompt): ${res.holdoutPassed ?? 0}/${res.holdoutCases ?? 0} • Leveled-cost MAPE: ${res.leveledCostMape}% • Exclusion recall: ${Math.round(res.scopeRecallAvg * 100)}%${res.payAppReview ? ` • Pay-app review fixtures: ${res.payAppReview.passedCases}/${res.payAppReview.totalCases} (${res.payAppReview.overallScore}%)` : ""}`);
    } catch (err: any) {
      setEvalStatusMsg(`Evaluation failed: ${err.message || err}`);
    } finally {
      setIsRunningEvals(false);
    }
  };

  const handleDownloadTraces = () => {
    if (!latestEvalData) return;
    const blob = new Blob([JSON.stringify(latestEvalData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tradepulse_eval_traces_${latestEvalData.run?.runId || "latest"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Multi-Model Selector State
  const [selectedModel, setSelectedModel] = useState<"gemini" | "openai" | "claude">("gemini");
  const [selectedPromptType, setSelectedPromptType] = useState<string>("spec_div26");
  const [isBenchmarking, setIsBenchmarking] = useState<boolean>(false);
  const [benchmarkResult, setBenchmarkResult] = useState<{
    model: string;
    provider: string;
    latencyMs: number;
    throughputTokSec: number;
    inputTokens: number;
    outputTokens: number;
    inputCostPer1M: number;
    outputCostPer1M: number;
    totalCostUsd: number;
    accuracyScore: number | null;
    sampleOutput: string;
    isLive: boolean;
    unavailable?: boolean;
    usedFallback?: boolean;
    requestedProvider?: string;
   } | null>(null);

  const modelsConfig = {
    gemini: {
      name: "Gemini Flash",
      provider: "Google Cloud Vertex AI / Gemini",
      role: "High-throughput CSI spec breakdown and pre-bid RFI auto-replies",
      badge: "High-Throughput Route",
      color: "border-blue-500 text-blue-400 bg-blue-950/40",
      activeBg: "bg-blue-900/30 border-blue-500 ring-1 ring-blue-500/50",
      referenceInputCostPer1M: 0.75,
      referenceOutputCostPer1M: 3.75,
      keyEnv: "GEMINI_API_KEY",
      availabilityKey: "gemini",
      strengths: "Handles 100+ page CSI specification ingestion and RFI drafting.",
    },
    openai: {
      name: "OpenAI GPT-4o",
      provider: "OpenAI",
      role: "Structured JSON extraction and proposal normalization (BYOK adapter)",
      badge: "BYOK Adapter",
      color: "border-emerald-500 text-emerald-400 bg-emerald-950/40",
      activeBg: "bg-emerald-900/30 border-emerald-500 ring-1 ring-emerald-500/50",
      referenceInputCostPer1M: 2.5,
      referenceOutputCostPer1M: 10.0,
      keyEnv: "OPENAI_API_KEY",
      availabilityKey: "openai",
      strengths: "Strict JSON schema enforcement for subcontractor quote data.",
    },
    claude: {
      name: "Claude Sonnet 5",
      provider: "Anthropic",
      role: "Forensic fine-print and scope-gap reasoning",
      badge: "Forensic Reasoning",
      color: "border-purple-500 text-purple-400 bg-purple-950/40",
      activeBg: "bg-purple-900/30 border-purple-500 ring-1 ring-purple-500/50",
      referenceInputCostPer1M: 3.0,
      referenceOutputCostPer1M: 15.0,
      keyEnv: "ANTHROPIC_API_KEY",
      availabilityKey: "claude",
      strengths: "Deep contract qualification analysis and delay-risk audit.",
    },
  } as const;

  const isProviderConfigured = (key: "gemini" | "openai" | "claude"): boolean | null => {
    if (!providerAvailability) return null;
    return Boolean((providerAvailability as any)[key]);
  };

  const runDiagnosticAction = useAction((api as any).llmRouter.runModelDiagnostic);

  const handleRunBenchmark = async () => {
    setIsBenchmarking(true);
    const config = modelsConfig[selectedModel];
    try {
      if (runDiagnosticAction) {
        const res = await runDiagnosticAction({
          model: selectedModel,
          promptType: selectedPromptType,
        });

        const totalCostUsd =
          (res.inputTokens / 1_000_000) * config.referenceInputCostPer1M +
          (res.outputTokens / 1_000_000) * config.referenceOutputCostPer1M;

        setBenchmarkResult({
          model: `${config.name} (${res.model})`,
          provider: res.provider,
          latencyMs: res.latencyMs,
          throughputTokSec: res.throughputTokSec,
          inputTokens: res.inputTokens,
          outputTokens: res.outputTokens,
          inputCostPer1M: config.referenceInputCostPer1M,
          outputCostPer1M: config.referenceOutputCostPer1M,
          totalCostUsd: Number(totalCostUsd.toFixed(6)),
          accuracyScore: null,
          sampleOutput: res.content.slice(0, 400) + (res.content.length > 400 ? "..." : ""),
          isLive: res.isLive !== false,
          unavailable: Boolean(res.unavailable),
          usedFallback: Boolean(res.usedFallback),
          requestedProvider: res.requestedProvider,
        });
      }
    } catch (err: any) {
      console.warn("Live model diagnostic invocation error:", err);
      setBenchmarkResult({
        model: config.name,
        provider: config.provider,
        latencyMs: 0,
        throughputTokSec: 0,
        inputTokens: 0,
        outputTokens: 0,
        inputCostPer1M: config.referenceInputCostPer1M,
        outputCostPer1M: config.referenceOutputCostPer1M,
        totalCostUsd: 0,
        accuracyScore: null,
        sampleOutput: `Diagnostic could not complete: ${String(err?.message || err).slice(0, 240)}`,
        isLive: false,
        unavailable: true,
      });
    } finally {
      setIsBenchmarking(false);
    }
  };

  const sponsors = [
    {
      name: "Convex",
      role: "Real-Time Reactive Backend, File Storage & Crons",
      status: "Verified / Active",
      details: [
        "Real-time WebSocket sync over useQuery (Zero Polling Invariant)",
        "Convex Crons scheduled jobs (hourly deadline monitoring & compliance sweeps)",
        "Native Convex File Storage (_storage) serving blueprints, specs, and quotes",
        "Static Hosting deployed via @convex-dev/static-hosting on app-owned root router",
      ],
      icon: Database,
      badgeColor: "text-orange-400 bg-orange-950/50 border-orange-800/60",
    },
    {
      name: "OpenAI",
      role: "BYOK LLM Adapter — Structured Extraction & RFI Reasoning",
      status: providerAvailability && !(providerAvailability as any).openai ? "Adapter Ready / Key Required" : "Integrated / Active",
      details: [
        "Activated automatically the moment OPENAI_API_KEY is configured on the deployment",
        "Structured JSON forensic line-item extraction via response_format on OpenAI",
        "The router falls through to Gemini and Claude while the adapter has no key",
        "No OpenAI API credits are provided by the hackathon; the adapter is bring-your-own-key",
      ],
      icon: Bot,
      badgeColor: "text-emerald-400 bg-emerald-950/50 border-emerald-800/60",
    },
    {
      name: "Firecrawl",
      role: "Autonomous Subcontractor Discovery (provenance-first)",
      status: "Connected / Active",
      details: [
        "Live web search (firecrawl.search & POST /v2/search) for trade contractors",
        "Records only published contact and licence data, each with a provenance label",
        "Directory and aggregator pages are skipped; there is no fabricated fallback directory",
        "FIRECRAWL_API_KEY is required for live discovery; registry verification only when the source is a registry page",
      ],
      icon: Globe,
      badgeColor: "text-amber-400 bg-amber-950/50 border-amber-800/60",
    },
    {
      name: "AgentMail",
      role: "Programmatic Email Inboxes for Subcontractor Bidding",
      status: "Connected / Active",
      details: [
        "Inbox provisioning per CSI package through the AgentMail REST API with the deployment key",
        "Real outbound dispatch via rfqActions.dispatchRfqsWithNotification, with per-recipient delivery results",
        "Svix-verified inbound webhook ingestion at /agentmail/webhook",
        "On the free-tier inbox limit, a package reuses an inbox and the UI discloses it as shared",
      ],
      icon: Mail,
      badgeColor: "text-blue-400 bg-blue-950/50 border-blue-800/60",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
          <Activity className="w-5 h-5 text-emerald-400" />
          Sponsor Integration Hub, Multi-Model Router & Diagnostics
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Live integration status across Convex, OpenAI (BYOK adapter), Firecrawl, AgentMail, and the multi-model router.
        </p>
      </div>

      {/* 🏆 Certified Professional Estimator (ASPE / AGC) Ground-Truth Evals & Empirical Trace Inspector */}
      <div className="bg-slate-900 border border-emerald-900/60 rounded-xl p-5 space-y-5 shadow-lg shadow-emerald-950/20">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-950 border border-emerald-700 flex items-center justify-center text-emerald-400">
              <Scale className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  Bid Extraction & ADR-0003 Normalization Check
                </h3>
                <span className="text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-800 px-2 py-0.5 rounded-full font-mono font-semibold">
                  Prompt-grounded extraction check
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Runs 13 commercial MEP cases through the live LLM extraction + ADR-0003 normalization pipeline: 8
                prompt-grounded parsing cases, 2 cross-trade coordination cases, and <strong className="text-slate-200">3 holdout
                cases whose proposal text states no total at all</strong> — those require the model to sum the schedule of
                values and apply the normalization arithmetic itself, so the score cannot be satisfied by copying a figure
                out of the prompt.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {latestEvalData?.traces && latestEvalData.traces.length > 0 && (
              <button
                onClick={handleDownloadTraces}
                className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-3 py-2 rounded-lg flex items-center gap-1.5 transition border border-slate-700"
                title="Download full verifiable prompt/response traces as JSON"
              >
                <Download className="w-3.5 h-3.5 text-slate-400" />
                Download Traces JSON
              </button>
            )}

            <button
              disabled={isRunningEvals}
              onClick={handleRunExpertEvals}
              className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold text-xs px-4 py-2 rounded-lg flex items-center gap-1.5 transition shadow-sm"
            >
              {isRunningEvals ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              {isRunningEvals ? "Evaluating 13 Cases..." : "Run Extraction & Leveling Check"}
            </button>
          </div>
        </div>

        {evalStatusMsg && (
          <div className="p-3 bg-emerald-950/40 border border-emerald-800/60 rounded-lg text-xs font-mono text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{evalStatusMsg}</span>
          </div>
        )}

        {/* Evaluation Summary KPIs */}
        {latestEvalData?.run ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase block font-semibold">Cases Extracted Correctly</span>
              <span className="text-base font-bold text-emerald-400 font-mono">
                {latestEvalData.run.passedCases} / {latestEvalData.run.totalCases}
              </span>
               <span className="text-[10px] text-slate-400 block mt-0.5">Extraction matched the ground truth</span>
            </div>

            <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase block font-semibold">Leveled Cost MAPE</span>
              <span className="text-base font-bold text-sky-400 font-mono">
                {latestEvalData.run.leveledCostMape.toFixed(2)}%
              </span>
              <span className="text-[10px] text-slate-400 block mt-0.5">Target: &le; 0.50%</span>
            </div>

            <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase block font-semibold">Scope Recall</span>
              <span className="text-base font-bold text-amber-400 font-mono">
                {Math.round(latestEvalData.run.scopeRecallAvg * 100)}%
              </span>
              <span className="text-[10px] text-slate-400 block mt-0.5">Exclusions present in the proposal were extracted</span>
            </div>

            <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase block font-semibold">MEP Clash Recall</span>
               <span className="text-base font-bold text-purple-400 font-mono">{Math.round(latestEvalData.run.clashRecallAvg * 100)}%</span>
               <span className="text-[10px] text-slate-400 block mt-0.5">Computed from cross-trade cases</span>
            </div>

<div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
               <span className="text-[10px] text-slate-400 uppercase block font-semibold">AIA A401 Conformity</span>
               <span className="text-base font-bold text-emerald-400 font-mono">{latestEvalData.run.aiaConformityAvg > 0 ? `${Math.round(latestEvalData.run.aiaConformityAvg * 100)}%` : "N/A"}</span>
               <span className="text-[10px] text-slate-400 block mt-0.5">Not covered by this suite</span>
             </div>

            <div className="bg-slate-950 p-3 rounded-lg border border-emerald-800/60">
              <span className="text-[10px] text-slate-400 uppercase block font-semibold">Holdout — Answer Not In Prompt</span>
              <span className="text-base font-bold text-emerald-300 font-mono">
                {latestEvalData.run.holdoutPassed ?? 0} / {latestEvalData.run.holdoutCases ?? 0}
              </span>
              <span className="text-[10px] text-slate-400 block mt-0.5">
                MAPE {latestEvalData.run.holdoutMape !== undefined ? `${latestEvalData.run.holdoutMape.toFixed(2)}%` : "—"} • model must compute
              </span>
            </div>
          </div>
        ) : (
          <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 text-center">
            <p className="text-xs text-slate-400 leading-relaxed">
              Click <strong className="text-white">"Run Extraction &amp; Leveling Check"</strong> above or run <code className="text-emerald-400 bg-slate-900 px-1.5 py-0.5 rounded">npm run evals</code> in the CLI to execute the live benchmark against Convex Cloud. Holdout cases deliberately omit the total from the prompt, so they cannot be passed by copying.
            </p>
          </div>
        )}

        <PayAppEvalPanel run={latestEvalData?.payAppReviewRun} />

        {/* 10-Case Comparative Ground-Truth Table */}
        {latestEvalData?.traces && latestEvalData.traces.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-emerald-400" />
                Case-by-Case Leveling & Extraction Audit Trail
              </h4>
              <span className="text-[11px] text-slate-400">
                Run ID: <code className="font-mono text-slate-300">{latestEvalData.run?.runId}</code>
                {latestEvalData.run?.createdAt ? ` • started ${formatFullDateTime(latestEvalData.run.createdAt)}` : ""}
                {isRunningEvals && <span className="text-amber-300 ml-2">New run in progress…</span>}
              </span>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-900/80 text-slate-400 text-[11px]">
                    <th className="p-2.5 font-semibold">Case ID</th>
                    <th className="p-2.5 font-semibold">CSI Division & Trade</th>
                    <th className="p-2.5 font-semibold">Contractor Proposal</th>
                    <th className="p-2.5 font-semibold text-right">Expert Ground Truth</th>
                    <th className="p-2.5 font-semibold text-right">TradePulse AI Output</th>
                    <th className="p-2.5 font-semibold text-right">Variance Delta</th>
                    <th className="p-2.5 font-semibold text-center">Scope Recall</th>
                    <th className="p-2.5 font-semibold text-center">Status</th>
                    <th className="p-2.5 font-semibold text-center">Trace</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-850">
                  {latestEvalData.traces.map((t: any) => {
                    const isExpanded = expandedTraceCaseId === t.caseId;
                    const gtCost = t.metrics?.groundTruthLeveledCost || t.groundTruth?.leveledCost || t.groundTruth?.expectedRedundantAmount || t.groundTruth?.expectedVoidExposure || 0;
                    const aiCost = t.metrics?.aiLeveledCost || t.parsedOutput?.leveledTotalCost || t.parsedOutput?.totalRedundantAmount || t.parsedOutput?.totalVoidExposure || 0;
                    const delta = aiCost - gtCost;
                    const apePercent = typeof t.metrics?.apePercent === "number" ? t.metrics.apePercent : null;
                    const recallPct = typeof t.metrics?.scopeRecall === "number" ? Math.round(t.metrics.scopeRecall * 100) : null;
                    const passed = t.status === "PASS";

                    return (
                      <React.Fragment key={t.caseId}>
                        <tr className="hover:bg-slate-900/50 transition">
                          <td className="p-2.5 font-mono text-[11px] text-slate-300">
                            {t.caseId}
                            {(t.metrics as any)?.isHoldout && (
                              <span className="ml-2 text-[9px] font-bold uppercase tracking-wider text-emerald-300 bg-emerald-950 border border-emerald-700 px-1.5 py-0.5 rounded">
                                Holdout
                              </span>
                            )}
                          </td>
                          <td className="p-2.5">
                            <span className="font-medium text-slate-200">{t.csiDivision}</span>
                          </td>
                          <td className="p-2.5 text-slate-300 font-semibold">{t.contractorName}</td>
                          <td className="p-2.5 text-right font-mono text-slate-300 font-semibold">
                            ${gtCost.toLocaleString()}
                          </td>
                          <td className="p-2.5 text-right font-mono text-emerald-400 font-bold">
                            ${aiCost.toLocaleString()}
                          </td>
                          <td className="p-2.5 text-right font-mono text-[11px]">
                            {delta === 0 ? (
                              <span className="text-slate-400">$0 (0.00%)</span>
                            ) : delta > 0 ? (
                              <span className="text-amber-400">+${delta.toLocaleString()} ({apePercent === null ? "n/a" : `${apePercent.toFixed(2)}%`})</span>
                            ) : (
                              <span className="text-sky-400">-${Math.abs(delta).toLocaleString()} ({apePercent === null ? "n/a" : `${apePercent.toFixed(2)}%`})</span>
                            )}
                          </td>
                          <td className="p-2.5 text-center font-mono font-semibold text-emerald-400">
                             {recallPct === null ? "N/A" : `${recallPct}%`}
                          </td>
                          <td className="p-2.5 text-center">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${passed ? "bg-emerald-950 text-emerald-400 border border-emerald-800" : "bg-rose-950 text-rose-300 border border-rose-800"}`}>
                              {t.status}
                            </span>
                          </td>
                          <td className="p-2.5 text-center">
                            <button
                              onClick={() => setExpandedTraceCaseId(isExpanded ? null : t.caseId)}
                              className="px-2 py-1 rounded bg-slate-850 hover:bg-slate-800 text-slate-300 text-[11px] font-mono flex items-center gap-1 mx-auto transition border border-slate-700"
                            >
                              <Eye className="w-3 h-3 text-emerald-400" />
                              {isExpanded ? "Hide" : "Inspect"}
                            </button>
                          </td>
                        </tr>

                        {/* Expandable Trace Drawer */}
                        {isExpanded && (
                          <tr className="bg-slate-900/90 border-b border-slate-800">
                            <td colSpan={9} className="p-4 space-y-3">
                              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2 text-xs">
                                <span className="font-bold text-white flex items-center gap-1.5">
                                  <Cpu className="w-3.5 h-3.5 text-emerald-400" />
                                  Execution Trace: {t.contractorName} ({t.provider} • {t.model})
                                </span>
                                <div className="flex items-center gap-3 text-[11px] font-mono text-slate-400">
                                  <span>Latency: <strong className="text-sky-300">{t.latencyMs} ms</strong></span>
                                  <span>Tokens: <strong className="text-slate-200">{t.inputTokens} in / {t.outputTokens} out</strong></span>
                                  {typeof t.costUsd === "number" && (
                                    <span>Cost: <strong className="text-emerald-300">${t.costUsd.toFixed(6)}</strong></span>
                                  )}
                                </div>
                              </div>

                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs font-mono">
                                <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1.5">
                                  <span className="text-[10px] uppercase font-bold text-slate-400 block">Raw Prompt Input</span>
                                  <pre className="text-[11px] text-slate-300 whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed">
                                    {t.rawPrompt}
                                  </pre>
                                </div>

                                <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1.5">
                                  <span className="text-[10px] uppercase font-bold text-slate-400 block">Model Extraction & ADR-0003 Normalization</span>
                                  <pre className="text-[11px] text-emerald-300 whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed">
                                    {JSON.stringify(t.parsedOutput, null, 2)}
                                  </pre>
                                </div>
                              </div>

                              {(t.systemPrompt || t.rawResponse) && (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs font-mono">
                                  {t.systemPrompt && (
                                    <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1.5">
                                      <span className="text-[10px] uppercase font-bold text-slate-400 block">System Prompt</span>
                                      <pre className="text-[11px] text-sky-300 whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed">
                                        {t.systemPrompt}
                                      </pre>
                                    </div>
                                  )}
                                  {t.rawResponse && (
                                    <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1.5">
                                      <span className="text-[10px] uppercase font-bold text-slate-400 block">Raw Model Response</span>
                                      <pre className="text-[11px] text-slate-300 whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed">
                                        {t.rawResponse}
                                      </pre>
                                    </div>
                                  )}
                                </div>
                              )}

                              {t.groundTruth && (
                                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 text-xs">
                                  <span className="text-[10px] uppercase font-bold text-slate-400 block mb-1">
                                    Certified Professional Estimator Ground Truth Verification
                                  </span>
                                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono">
                                    <div>Expected Base: <strong className="text-slate-200">${(t.groundTruth.baseBid || t.groundTruth.expectedRedundantAmount || 0).toLocaleString()}</strong></div>
                                    <div>Scope Plugs: <strong className="text-amber-300">+${(t.groundTruth.exclusionsTotal || 0).toLocaleString()}</strong></div>
                                    <div>Penalties: <strong className="text-rose-300">+${((t.groundTruth.leadPenalty || 0) + (t.groundTruth.coiPenalty || 0)).toLocaleString()}</strong></div>
                                    <div>Expert Leveled Total: <strong className="text-emerald-400">${(t.groundTruth.leveledCost || gtCost).toLocaleString()}</strong></div>
                                  </div>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Multi-Model Selector & Token Diagnostics Studio */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-950 border border-emerald-700 flex items-center justify-center text-emerald-400">
              <Cpu className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                Multi-Model Intelligence Layer & Token Diagnostics
                <span className="text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-800 px-2 py-0.5 rounded-full font-mono">
                  Active
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                Dynamically routes tasks across Gemini Flash, Claude Sonnet 5, and OpenAI GPT-4o (BYOK) when configured, for maximum throughput and forensic precision.
              </p>
            </div>
          </div>

          <div className="flex w-full sm:w-auto min-w-0 max-w-full flex-wrap items-center gap-2">
            <select
              aria-label="Diagnostic prompt scenario"
              value={selectedPromptType}
              onChange={(e) => setSelectedPromptType(e.target.value)}
              className="w-full sm:w-auto max-w-full bg-slate-850 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-emerald-500"
            >
              <option value="spec_div26">Div 26 Switchgear Scope Gap Audit</option>
              <option value="hvac_bacnet">Div 23 BACnet & TAB Exclusion Check</option>
              <option value="plumb_booster">Div 22 Booster Pump COI Verification</option>
            </select>

            <button
              disabled={isBenchmarking}
              onClick={handleRunBenchmark}
              className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold text-xs px-3.5 py-2 rounded-lg flex items-center gap-1.5 transition shadow-sm"
            >
              {isBenchmarking ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              {isBenchmarking ? "Benchmarking..." : "Run Token Diagnostics"}
            </button>
          </div>
        </div>

        {/* 3 Model Selector Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(Object.keys(modelsConfig) as Array<keyof typeof modelsConfig>).map((key) => {
            const m = modelsConfig[key];
            const isSelected = selectedModel === key;
            const configured = isProviderConfigured(m.availabilityKey);
            return (
              <div
                key={key}
                onClick={() => setSelectedModel(key)}
                className={`rounded-xl border p-4 cursor-pointer transition flex flex-col justify-between ${
                  isSelected
                    ? m.activeBg
                    : "bg-slate-850/60 border-slate-800 hover:border-slate-700"
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${m.color}`}>
                      {m.badge}
                    </span>
                    {isSelected && (
                      <span className="text-emerald-400 text-xs flex items-center gap-1 font-semibold">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Selected
                      </span>
                    )}
                  </div>

                  <h4 className="text-sm font-bold text-white mb-1">{m.name}</h4>
                  <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">{m.role}</p>

                  {key === "gemini" && (
                    <p className="text-[10px] font-mono text-slate-400 mb-2">
                      Configured model: {(providerAvailability as any)?.geminiModel || "not reported"}
                    </p>
                  )}
                  {key === "openai" && (
                    <p className="text-[10px] font-mono text-slate-400 mb-2">
                      Configured model: {(providerAvailability as any)?.openaiModel || "not reported"}
                    </p>
                  )}
                  {key === "claude" && (
                    <p className="text-[10px] font-mono text-slate-400 mb-2">
                      Configured model: {(providerAvailability as any)?.anthropicModel || "not reported"}
                    </p>
                  )}

                  <div className="space-y-1.5 text-[11px] text-slate-300 border-t border-slate-800/80 pt-2.5">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Status:</span>
                      {configured === null ? (
                        <span className="font-mono text-slate-400">Checking…</span>
                      ) : configured ? (
                        <span className="font-mono font-bold text-emerald-400">Live — key configured</span>
                      ) : (
                        <span className="font-mono font-bold text-amber-300">Adapter ready — {m.keyEnv} not set</span>
                      )}
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Reference price / 1M:</span>
                      <span className="font-mono text-slate-400">${m.referenceInputCostPer1M.toFixed(2)} in · ${m.referenceOutputCostPer1M.toFixed(2)} out</span>
                    </div>
                  </div>
                </div>

                <div className="mt-3 pt-2 text-[10px] text-slate-400 italic">
                  {m.strengths}
                </div>
              </div>
            );
          })}
        </div>

        {providerAvailability && !(providerAvailability as any).openai && (
          <div className="rounded-xl border border-amber-800/60 bg-amber-950/30 p-3 text-[11px] text-amber-200 leading-relaxed">
            The OpenAI adapter is wired into the router but no key is configured on this deployment (the hackathon
            provides no OpenAI API credits). Add one with{" "}
            <span className="font-mono">npx convex env set OPENAI_API_KEY &lt;key&gt;</span> to run it live; until then the
            pipeline routes to the configured providers.
          </div>
        )}

        {/* Live Token Economics & Diagnostics Gauges */}
        {benchmarkResult && (
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs border-b border-slate-800 pb-2">
              <span className="font-bold text-slate-200 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                 {(benchmarkResult as any).unavailable
                   ? "Diagnostic unavailable"
                   : benchmarkResult.isLive
                   ? "Live measurement"
                   : "Offline fallback"}{" "}
                — {benchmarkResult.model}
              </span>
              <span className="text-emerald-400 font-mono text-[11px]">
                 {(benchmarkResult as any).unavailable
                   ? "No call was made"
                   : `Accuracy: ${benchmarkResult.accuracyScore === null ? "Not measured" : `${benchmarkResult.accuracyScore}%`} • Status: ${
                       (benchmarkResult as any).usedFallback
                         ? `Fallback used (answered by ${benchmarkResult.provider})`
                         : "Live"
                     }`}
              </span>
            </div>

            {benchmarkResult.unavailable ? (
              <div className="p-3 bg-amber-950/30 border border-amber-800/60 rounded-lg text-xs text-amber-200 leading-relaxed">
                {benchmarkResult.sampleOutput}
              </div>
            ) : (
              <>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 text-xs">
              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                <span className="text-[10px] text-slate-400 block mb-0.5 uppercase">Throughput</span>
                <span className="text-sm font-bold text-white font-mono">{benchmarkResult.throughputTokSec} tok/s</span>
              </div>

              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                <span className="text-[10px] text-slate-400 block mb-0.5 uppercase">Latency</span>
                <span className="text-sm font-bold text-sky-400 font-mono">{benchmarkResult.latencyMs} ms</span>
              </div>

              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                <span className="text-[10px] text-slate-400 block mb-0.5 uppercase">Input Tokens</span>
                <span className="text-sm font-bold text-slate-300 font-mono">{benchmarkResult.inputTokens.toLocaleString()}</span>
              </div>

              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                <span className="text-[10px] text-slate-400 block mb-0.5 uppercase">Output Tokens</span>
                <span className="text-sm font-bold text-slate-300 font-mono">{benchmarkResult.outputTokens.toLocaleString()}</span>
              </div>

              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                <span className="text-[10px] text-slate-400 block mb-0.5 uppercase">Query Cost</span>
                <span className="text-sm font-bold text-emerald-400 font-mono">${benchmarkResult.totalCostUsd.toFixed(5)}</span>
              </div>

              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                <span className="text-[10px] text-slate-400 block mb-0.5 uppercase">CSI Accuracy</span>
                 <span className="text-sm font-bold text-amber-400 font-mono">{benchmarkResult.accuracyScore === null ? "N/A" : `${benchmarkResult.accuracyScore}%`}</span>
              </div>
            </div>

            <div className="p-3 bg-slate-900 rounded-lg border border-slate-800 text-xs font-mono text-slate-300 leading-relaxed">
              <span className="text-[10px] text-slate-400 uppercase block mb-1">Model Inference Output</span>
              {benchmarkResult.sampleOutput}
            </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Sponsor Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {sponsors.map((s) => {
          const Icon = s.icon;
          return (
            <div
              key={s.name}
              className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center">
                      <Icon className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-white">{s.name}</h3>
                      <p className="text-[11px] text-slate-400">{s.role}</p>
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-semibold border px-2 py-0.5 rounded-full flex items-center gap-1 ${s.badgeColor}`}
                  >
                    <CheckCircle2 className="w-3 h-3" />
                    {s.status}
                  </span>
                </div>

                <div className="space-y-1.5 border-t border-slate-800/80 pt-3 text-xs">
                  {s.details.map((d, i) => (
                    <div key={i} className="flex items-start gap-2 text-slate-300">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                      <span className="leading-relaxed">{d}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Wayne Sutton / Vibe Apps llms.txt Explorer */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-emerald-400" />
            <h3 className="text-sm font-bold text-white">
              Wayne Sutton / Vibe Apps Discoverability Endpoint (/llms.txt)
            </h3>
          </div>
          <span className="text-[11px] text-slate-400 font-mono">
            GET {CONVEX_SITE_URL}/llms.txt
          </span>
        </div>

        <div className="flex items-center gap-2 text-[11px]">
          {llmsLive === true ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-950/70 text-emerald-300 border border-emerald-800">
              <CheckCircle2 className="w-3 h-3" /> Live endpoint content (fetched now)
            </span>
          ) : llmsLive === false ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-950/70 text-amber-300 border border-amber-800">
              ⚠ Live fetch unavailable — showing static snapshot
            </span>
          ) : (
            <span className="text-slate-400">Fetching /llms.txt…</span>
          )}
        </div>

        <p className="text-xs text-slate-400 leading-relaxed">
          Exposed natively via Convex HTTP actions (<code className="text-emerald-300">convex/http.ts</code>) to allow autonomous procurement agents to query active CSI scopes programmatically.
        </p>

        <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 text-xs font-mono text-slate-300 leading-relaxed overflow-x-auto">
          <pre>{llmsText ?? LLMS_FALLBACK_TEXT}</pre>
        </div>
      </div>
    </div>
  );
};
