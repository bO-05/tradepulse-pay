import React, { useState, useEffect, useMemo } from "react";
import {
  Sparkles,
  ChevronRight,
  ChevronLeft,
  X,
  Play,
  Tv,
  Minimize2,
  Maximize2,
  Volume2,
  Zap,
} from "lucide-react";

export interface DemoScene {
  id: string;
  tabId: string;
  stepNumber: string;
  title: string;
  category: string;
  problemStatement: string;
  talkTrack: string;
  keyMetric: string;
  actionLabel: string;
  actionDescription: string;
}

export interface TourLiveContext {
  projectTitle: string;
  packagesCount: number;
  contractorsCount: number;
  conversationsCount: number;
  bidsCount: number;
  agreementsCount: number;
  awardedPackages: number;
  totalPackages: number;
  totalBudget: number;
  totalLeveledBuyout: number;
  variance: number;
  gapsCaught: number;
  deceptiveBidsCount: number;
  openClashes: number;
  effectiveBidName?: string;
  effectiveBidCost?: number;
  runnerUpName?: string;
  runnerUpCost?: number;
  runnerUpBaseCost?: number;
  contractSum?: number;
  contractExecuted?: boolean;
  hasBids: boolean;
}

const money = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? `$${Math.round(value).toLocaleString()}` : "—";

/**
 * Scene scripts are presenter cues, but every quantitative claim is interpolated from
 * `liveContext` (computed once in App) so the narration can never contradict the screen.
 */
export function buildDemoScenes(ctx: TourLiveContext): DemoScene[] {
  const pkgLabel = `${ctx.packagesCount} CSI Trade Package${ctx.packagesCount === 1 ? "" : "s"}`;
  const subLabel = `${ctx.contractorsCount} Contractor Record${ctx.contractorsCount === 1 ? "" : "s"} in Directory`;
  const runnerUpDelta =
    ctx.effectiveBidCost !== undefined && ctx.runnerUpCost !== undefined
      ? Math.abs(ctx.runnerUpCost - ctx.effectiveBidCost)
      : undefined;

  const levelingTalk = ctx.hasBids
    ? `"${ctx.runnerUpName || "The lowest competitor"} appears cheapest on paper at ${money(ctx.runnerUpBaseCost ?? ctx.runnerUpCost)}. ADR-0003 normalization exposes ${money(ctx.gapsCaught)} in hidden scope gaps on ${ctx.deceptiveBidsCount} flagged bid${ctx.deceptiveBidsCount === 1 ? "" : "s"} — true leveled costs land at ${money(ctx.effectiveBidCost)} for ${ctx.effectiveBidName || "the compliant winner"}${
        runnerUpDelta !== undefined ? `, a ${money(runnerUpDelta)} true variance` : ""
      }."`
    : `"No proposals have been leveled for ${ctx.projectTitle} yet. Scope the packages, ingest the trade quotes, and this scene will narrate the live ADR-0003 variance."`;

  const levelingMetric = ctx.hasBids
    ? `${money(ctx.variance)} True Variance vs Budget • ${ctx.deceptiveBidsCount} apparent-low bid${ctx.deceptiveBidsCount === 1 ? "" : "s"} not leveled low`
    : `No bids leveled yet • ${ctx.packagesCount} package${ctx.packagesCount === 1 ? "" : "s"} awaiting proposals`;

  const contractsMetric =
    ctx.agreementsCount > 0 && typeof ctx.contractSum === "number"
      ? `$${Math.round(ctx.contractSum).toLocaleString()} Subcontract ${ctx.contractExecuted ? "Execution Recorded" : "Generated"} • A401-style Draft`
      : "No A401-style draft yet • Award a leveled bid to generate one";

  const coordinationMetric =
    ctx.openClashes > 0
      ? `${ctx.openClashes} Open Coordination Item${ctx.openClashes === 1 ? "" : "s"} • Review Double-Buys & Voids`
      : "No open cross-trade clashes detected";

  return [
    {
      id: "scoping",
      tabId: "packages",
      stepNumber: "01",
      category: "CSI MasterFormat Scoping",
      title: "The Scope Exclusion Trap & Automated Scoping",
      problemStatement:
        "Commercial GCs lose six figures on MEP buyout to fine-print scope exclusions and trade overlaps hidden in architectural specs.",
      talkTrack: `"Welcome to TradePulse Pay. TradePulse parses complex CSI specifications into trade packages — each with a programmatic @agentmail.to inbox for trade communication. On the AgentMail free tier, packages share an inbox once the plan limit is reached, and the package card labels it. The active project currently has ${pkgLabel}."`,
      keyMetric:
        ctx.packagesCount > 0
          ? `${pkgLabel} • AgentMail inbox per package`
          : "No packages scoped yet • Run AI Spec Breakdown to create them",
      actionLabel: "Advance to Contractor Sourcing",
      actionDescription: "Inspects scoped packages and transitions to autonomous subcontractor discovery.",
    },
    {
      id: "discovery",
      tabId: "discovery",
      stepNumber: "02",
      category: "Autonomous Discovery",
      title: "Specialty Contractor Discovery & Provenance",
      problemStatement:
        "Vetting specialty MEP subcontractors manually across state licensing boards takes days of tedious verification.",
      talkTrack: `"TradePulse discovers regional specialty contractors and records where each data point came from. Every record shows its provenance — live web discovery results are labeled unverified until a registry lookup is actually performed. The directory currently holds ${subLabel}."`,
      keyMetric:
        ctx.contractorsCount > 0
          ? `${subLabel} • Provenance shown per record`
          : "Directory empty • Run Discover Trade Contractors",
      actionLabel: "Advance to Pre-Bid Q&A",
      actionDescription: "Reviews contractor records and moves to incoming pre-bid inquiries.",
    },
    {
      id: "qna",
      tabId: "qna",
      stepNumber: "03",
      category: "Dynamic Pre-Bid Q&A",
      title: "AI Technical Clarifications & CSI Addendum Issuance",
      problemStatement:
        "Uncoordinated verbal answers to bidder inquiries lead to post-award delay and dispute claims.",
      talkTrack: `"Subcontractors email technical questions to the package inbox. Our spec-grounded AI analyzes the inquiry against project specifications, drafts an accurate citation, and flags edge cases for PM review. Once certified, it compiles a CSI Addendum stored in Convex File Storage. The active package has ${ctx.conversationsCount} RFI record${ctx.conversationsCount === 1 ? "" : "s"}."`,
      keyMetric: `${ctx.conversationsCount} RFI record${ctx.conversationsCount === 1 ? "" : "s"} • PM-certified CSI Addendum`,
      actionLabel: "Advance to Forensic Leveling",
      actionDescription: "Moves to the core bid leveling engine to compare incoming subcontractor proposals.",
    },
    {
      id: "leveling",
      tabId: "leveling",
      stepNumber: "04",
      category: "Forensic Bid Leveling",
      title: "ADR-0003 Normalization: Apparent Low vs Leveled Low",
      problemStatement:
        "A low paper bid can hide crane hoisting, firestopping and seismic exclusions that surface as change orders after award.",
      talkTrack: levelingTalk,
      keyMetric: levelingMetric,
      actionLabel: "Advance to Scope Clash Engine",
      actionDescription: "Awards the compliant winner and proceeds to cross-trade coordination.",
    },
    {
      id: "coordination",
      tabId: "coordination",
      stepNumber: "05",
      category: "Cross-Trade Coordination",
      title: "Cross-Trade Scope Clash & Double-Buy Deductions",
      problemStatement:
        "Electrical and HVAC scopes can both price the same equipment (for example VFDs), resulting in redundant spend, or both can omit shared wiring.",
      talkTrack: `"Trades don't always talk to each other. The clash engine flags equipment priced by both trades and scope omitted by both, so the GC can deduct or assign with one click. ${coordinationMetric}."`,
      keyMetric: coordinationMetric,
      actionLabel: "Advance to Subcontract Execution",
      actionDescription: "Transitions to the Contracts Register to inspect the generated A401-style subcontract draft.",
    },
    {
      id: "contracts",
      tabId: "contracts",
      stepNumber: "06",
      category: "Subcontract Buyout",
      title: "A401-style Subcontract Draft",
      problemStatement:
        "Manual subcontract drafting causes weeks of administrative lag, risking site mobilization delays.",
      talkTrack: `"With the winner leveled and clashes resolved, TradePulse drafts a standard 10-article A401-style Subcontract Draft incorporating mandatory inclusions, retainage terms, and liquidated damages. It is ready for external execution. ${ctx.awardedPackages} of ${ctx.totalPackages} package${ctx.totalPackages === 1 ? "" : "s"} currently hold an agreement."`,
      keyMetric: contractsMetric,
      actionLabel: "Complete Tour & View Audit Trail",
      actionDescription: "Inspects the subcontract register and reviews the causal audit log.",
    },
  ];
}

interface InvestorDemoTourBarProps {
  activeTab: string;
  onSelectTab: (tabId: string) => void;
  onClose: () => void;
  onExecuteSceneAction?: (sceneId: string) => Promise<void>;
  onOpenSimulationModal?: () => void;
  liveContext: TourLiveContext;
}

export const InvestorDemoTourBar: React.FC<InvestorDemoTourBarProps> = ({
  activeTab,
  onSelectTab,
  onClose,
  onExecuteSceneAction,
  onOpenSimulationModal,
  liveContext,
}) => {
  const scenes = useMemo(() => buildDemoScenes(liveContext), [liveContext]);
  const [currentSceneIndex, setCurrentSceneIndex] = useState<number>(() => {
    const idx = scenes.findIndex((s) => s.tabId === activeTab);
    return idx >= 0 ? idx : 0;
  });
  const [isMinimized, setIsMinimized] = useState<boolean>(false);
  const [isExecutingAction, setIsExecutingAction] = useState<boolean>(false);
  const [showScriptModal, setShowScriptModal] = useState<boolean>(false);

  useEffect(() => {
    const idx = scenes.findIndex((s) => s.tabId === activeTab);
    if (idx >= 0 && idx !== currentSceneIndex) {
      setCurrentSceneIndex(idx);
    }
  }, [activeTab, currentSceneIndex, scenes]);

  const scene = scenes[Math.min(currentSceneIndex, scenes.length - 1)];

  const handleGoToScene = (index: number) => {
    if (index >= 0 && index < scenes.length) {
      setCurrentSceneIndex(index);
      onSelectTab(scenes[index].tabId);
    }
  };

  const handleNext = () => {
    if (currentSceneIndex < scenes.length - 1) {
      handleGoToScene(currentSceneIndex + 1);
    } else {
      onSelectTab("audit");
    }
  };

  const handlePrev = () => {
    if (currentSceneIndex > 0) {
      handleGoToScene(currentSceneIndex - 1);
    }
  };

  const handleRunSceneAction = async () => {
    setIsExecutingAction(true);
    try {
      if (onExecuteSceneAction) {
        await onExecuteSceneAction(scene.id);
      } else {
        handleNext();
      }
    } finally {
      setIsExecutingAction(false);
    }
  };

  const isTourCompleted = activeTab === "audit" || activeTab === "diagnostics";

  if (isTourCompleted) {
    return (
      <div className="bg-gradient-to-r from-emerald-950/70 via-slate-900 to-emerald-950/70 border-b border-emerald-500/40 shadow-xl relative z-30 transition-all duration-200">
        <div className="px-4 lg:px-8 py-2.5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 border border-emerald-400/40 flex items-center justify-center text-emerald-400">
              <Sparkles className="w-4 h-4 text-emerald-400 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-bold text-white tracking-wide">
                  Guided tour (Demo) complete • All 6 procurement stages covered
                </h4>
                <span className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2 py-0.5 rounded-full font-mono font-bold">
                  Complete
                </span>
              </div>
              <p className="text-[11px] text-slate-300 mt-0.5">
                CSI Scoping ➔ Contractor Discovery ➔ AI Pre-Bid Addenda ➔ ADR-0003 Leveling ➔ Scope Clash Deduction ➔ Subcontract Draft.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleGoToScene(0)}
              className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs py-1.5 px-3 rounded-lg flex items-center gap-1.5 shadow transition"
              title="Restart the guided tour from scene 01"
            >
              <span>Restart guided tour</span>
            </button>
            <button
              onClick={onClose}
              className="bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-white font-medium text-xs py-1.5 px-3 rounded-lg flex items-center gap-1 transition border border-slate-700"
              title="Close Teleprompter"
            >
              <X className="w-3.5 h-3.5" />
              <span>Dismiss</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isMinimized) {
    return (
      <div className="fixed bottom-4 left-4 z-40 animate-in fade-in duration-200">
        <button
          onClick={() => setIsMinimized(false)}
          className="bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-bold px-3.5 py-2 rounded-xl flex items-center gap-2 shadow-2xl border border-amber-300/40 text-xs transition"
          title="Expand the guided tour"
        >
          <Tv className="w-4 h-4 text-slate-950" />
          <span>Guided tour (Demo) ({scene.stepNumber}/06)</span>
          <Maximize2 className="w-3.5 h-3.5 text-slate-950/80" />
        </button>
      </div>
    );
  }

  return (
    <div className="bg-gradient-to-r from-slate-900 via-slate-850 to-slate-900 border-b border-amber-500/40 shadow-xl relative z-30 transition-all duration-200">
      <div className="px-4 lg:px-8 py-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          {/* Left: Scene Tag & Talk Track */}
          <div className="flex-1 basis-[240px] min-w-0 flex items-center gap-2.5">
            <span className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[11px] font-bold tracking-wide">
              <Tv className="w-3 h-3 text-amber-400 animate-pulse" />
              <span>Scene {scene.stepNumber}/06: <strong className="text-amber-200">{scene.category}</strong></span>
            </span>

            {/* Compact Talk Track Cue - Clickable to Open Full Script */}
            <button
              onClick={() => setShowScriptModal(!showScriptModal)}
              className="flex-1 min-w-0 bg-slate-950/90 hover:bg-slate-900 border border-amber-500/30 hover:border-amber-400/50 rounded-lg px-2.5 py-1 flex items-center gap-2 text-xs text-amber-200 overflow-hidden shadow-inner text-left transition group cursor-pointer"
              title="Click to view full presenter script and talking points"
            >
              <Volume2 className="w-3.5 h-3.5 text-amber-400 shrink-0 group-hover:scale-110 transition" />
              <span className="truncate italic font-medium">
                <strong className="text-amber-300 font-semibold not-italic mr-1">Cue:</strong>
                {scene.talkTrack}
              </span>
              <span className="text-[10px] font-mono text-amber-400/80 shrink-0 hidden md:inline ml-auto bg-amber-950/60 px-1.5 py-0.5 rounded border border-amber-800/40">
                Script 📖
              </span>
            </button>

            <span
              className="hidden 2xl:inline-flex shrink-0 text-[10px] font-mono text-emerald-400 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/50"
              title="Figures in this cue are read live from the active project"
            >
              {scene.keyMetric}
            </span>
          </div>

          {/* Right: Step Pills, Action Button & Controls */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Step Pills & Prev Control */}
            <div className="hidden sm:flex items-center gap-0.5 bg-slate-950/80 p-0.5 rounded-lg border border-slate-800">
              <button
                onClick={handlePrev}
                disabled={currentSceneIndex === 0}
                className="p-1 rounded text-slate-400 hover:text-white disabled:opacity-30 transition"
                title="Previous Scene"
              >
                <ChevronLeft className="w-3 h-3" />
              </button>
              {scenes.map((s, idx) => (
                <button
                  key={s.id}
                  onClick={() => handleGoToScene(idx)}
                  aria-current={idx === currentSceneIndex ? "step" : undefined}
                  className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold transition ${
                    idx === currentSceneIndex
                      ? "bg-amber-500 text-slate-950 shadow-sm"
                      : "text-slate-400 hover:text-white hover:bg-slate-800"
                  }`}
                  title={`${s.stepNumber}: ${s.title}`}
                >
                  {s.stepNumber}
                </button>
              ))}
            </div>

            {/* Quick Action Button */}
            <button
              onClick={handleRunSceneAction}
              disabled={isExecutingAction}
              className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-xs py-1.5 px-3 rounded-lg flex items-center gap-1.5 shadow-sm transition active:scale-95"
            >
              <Play className="w-3 h-3 fill-slate-950" />
              <span>{scene.actionLabel}</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>

            {onOpenSimulationModal && (
              <button
                onClick={onOpenSimulationModal}
                className="hidden md:flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-semibold transition"
                title="Open the demo simulator"
              >
                <Zap className="w-3 h-3 text-amber-400 fill-amber-400" />
                <span className="text-[11px]">Simulator (Demo)</span>
              </button>
            )}

            <button
              onClick={() => setIsMinimized(true)}
              className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-800 transition text-xs"
              title="Minimize teleprompter"
            >
              <Minimize2 className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={onClose}
              className="text-slate-400 hover:text-rose-400 p-1 rounded hover:bg-slate-800 transition"
              title="Close the guided tour"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Presenter Teleprompter Script Drawer */}
      {showScriptModal && (
        <div className="bg-slate-950 border-t border-amber-500/30 px-4 lg:px-8 py-3 text-xs animate-in slide-in-from-top-2 duration-150">
          <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-start justify-between gap-4">
            <div className="space-y-1.5 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded">
                  Scene {scene.stepNumber} Presenter Script
                </span>
                <span className="font-bold text-white text-sm">{scene.title}</span>
              </div>
              <p className="text-slate-400 text-xs leading-relaxed">
                <strong className="text-amber-400">Commercial ICP Pain:</strong> {scene.problemStatement}
              </p>
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-3 text-amber-100 italic leading-relaxed text-xs">
                "{scene.talkTrack}"
              </div>
              <p className="text-[10px] text-slate-400">
                Quantitative figures in this cue are interpolated live from the active project ({liveContext.projectTitle}),
                so the narration cannot drift from the screen.
              </p>
            </div>

            <div className="shrink-0 flex flex-col sm:flex-row md:flex-col gap-2 items-start md:items-end">
              <span className="text-[11px] text-emerald-400 font-mono bg-emerald-950/60 border border-emerald-800/60 px-2 py-1 rounded">
                {scene.keyMetric}
              </span>
              <button
                onClick={() => setShowScriptModal(false)}
                className="text-slate-400 hover:text-white text-xs px-2.5 py-1 rounded border border-slate-800 hover:bg-slate-850"
              >
                Close Script ✕
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};