import { getErrorMessage } from "../lib/errors.ts";
import React, { useEffect, useState } from "react";
import { Zap, RefreshCw, X, ShieldAlert, CheckCircle2, MessageSquare, AlertTriangle, Play, RotateCcw } from "lucide-react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api.js";
import { TradePackage } from "../types.ts";
import { useDialogFocus } from "../lib/useDialogFocus.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { JUDGE_DEMO_AUTOSTART_KEY } from "../payments/judgeDemo/steps.ts";

interface JudgeSimulationDockProps {
  isOpen: boolean;
  onClose: () => void;
  tradePackages: TradePackage[];
  activePackageId: string;
  onTriggerSimulation: (scenario: "rfi_inquiry" | "bid_with_hidden_exclusion" | "bid_clean_compliant") => Promise<void>;
  onResetSeedData: () => Promise<void>;
  projectId?: string;
  projectTitle?: string;
  isDemoProject?: boolean;
  onRunFullCycle?: (packageId?: string) => Promise<string>;
}

export const JudgeSimulationDock: React.FC<JudgeSimulationDockProps> = ({
  isOpen,
  onClose,
  tradePackages,
  activePackageId,
  onTriggerSimulation,
  onResetSeedData,
  projectId,
  projectTitle,
  isDemoProject = false,
  onRunFullCycle,
}) => {
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);
  const [simConfirm, setSimConfirm] = useState<{ label: string; run: () => Promise<void> } | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen);

  const runFullCycleMutation = useMutation(api.simulation.runFullProcurementCycle);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !loadingAction && !isResetConfirmOpen && !simConfirm) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, loadingAction, onClose, isResetConfirmOpen, simConfirm]);

  if (!isOpen) return null;

  const currentPkg = tradePackages.find((p) => p._id === activePackageId) || tradePackages[0];

  const handleAction = async (actionKey: string, fn: () => Promise<void>) => {
    setLoadingAction(actionKey);
    setLastMessage(null);
    try {
      await fn();
      setLastMessage(`Action '${actionKey}' executed successfully.`);
    } catch (err: any) {
      setLastMessage(`Error: ${getErrorMessage(err) || "Execution failed"}`);
    } finally {
      setLoadingAction(null);
    }
  };

  const handleRunFullCycle = async () => {
    const run = async () => {
      setLoadingAction("full_cycle");
      setLastMessage(null);
      try {
        if (onRunFullCycle) {
          const msg = await onRunFullCycle(currentPkg?._id);
          setLastMessage(msg);
        } else {
          if (!projectId) {
            setLastMessage("Error: No active project ID available for full simulation.");
            return;
          }
          const res = await runFullCycleMutation({
            projectId: projectId as any,
            tradePackageId: currentPkg?._id as any,
          });
          setLastMessage(
            `✓ Full Autonomous Lifecycle Complete! Awarded ${res.winningBidder} ($${res.winningLeveledCost.toLocaleString()}) with generated A401-style subcontract draft ${res.agreementNumber}. Forensic leveling engine caught $${res.hiddenExclusionsCaughtCost.toLocaleString()} in hidden scope exclusions from ${res.deceptiveBidder}; external signature verification remains required.`
          );
        }
      } catch (err: any) {
        setLastMessage(`Lifecycle simulation failed: ${getErrorMessage(err) || "Unknown error"}`);
      } finally {
        setLoadingAction(null);
      }
    };
    if (!isDemoProject) {
      setSimConfirm({ label: "Run the full autonomous lifecycle", run });
      return;
    }
    await run();
  };

  const handleScenario = async (actionKey: string, scenario: "rfi_inquiry" | "bid_with_hidden_exclusion" | "bid_clean_compliant") => {
    const run = async () => {
      await handleAction(actionKey, () => onTriggerSimulation(scenario));
    };
    if (!isDemoProject) {
      setSimConfirm({ label: `Run the "${actionKey.replace(/_/g, " ")}" simulation`, run });
      return;
    }
    await run();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150" role="presentation">
      <div ref={dialogRef} className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="judge-dock-title">
        {/* Modal Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-amber-500/20 via-slate-800 to-slate-900 border-b border-slate-700/80 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-500 text-slate-950 flex items-center justify-center font-black shadow-md">
              <Zap className="w-4 h-4 fill-slate-950" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <span id="judge-dock-title">Demo simulator</span>
                <span className="text-[10px] font-semibold uppercase bg-amber-400/20 text-amber-300 border border-amber-400/30 px-2 py-0.5 rounded-full">
                  Instant Showcase
                </span>
              </h2>
              <p className="text-xs text-slate-400">
                Executes end-to-end procurement workflows instantly for screen recordings, live demos, and technical evaluation.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close demo simulator"
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3">
          <div className="bg-slate-850 p-2.5 rounded-lg border border-slate-700/60 text-xs flex items-center justify-between gap-2">
            <span className="text-slate-400">Target CSI Trade Package:</span>
            <span className="font-semibold text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 px-2 py-0.5 rounded font-mono truncate">
              {currentPkg ? `${currentPkg.csiDivision} - ${currentPkg.tradeName}` : "Auto-provisioned when the cycle runs"}
            </span>
          </div>
          <div className="bg-slate-850 p-2.5 rounded-lg border border-slate-700/60 text-xs flex items-center justify-between gap-2">
            <span className="text-slate-400">Target project:</span>
            <span className={`font-semibold px-2 py-0.5 rounded font-mono truncate ${isDemoProject ? "text-emerald-400" : "text-amber-300 bg-amber-950/40 border border-amber-800/40"}`}>
              {projectTitle || "Active project"} {isDemoProject ? "(demo)" : "(custom project)"}
            </span>
          </div>

          {!isDemoProject && (
            <div className="bg-amber-950/50 border border-amber-700/70 rounded-xl p-3 text-xs text-amber-200 flex items-start gap-2" role="alert">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span className="leading-relaxed">
                Simulations write real records — packages, proposals, bids, and a subcontract draft — into{" "}
                <strong className="text-amber-100">{projectTitle || "this project"}</strong>. Reset Demo Data only restores the
                demo project, so run scenarios on the demo unless you intend to modify this project. Each action asks for
                confirmation.
              </span>
            </div>
          )}

          {/* Hero: 1-Click Full Autonomous Procurement Lifecycle Simulation */}
          <div className="bg-gradient-to-r from-emerald-950/70 via-slate-850 to-amber-950/50 border-2 border-emerald-500/50 rounded-xl p-3.5 shadow-lg space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 fill-emerald-400" />
                Autonomous End-to-End Showcase
              </span>
              <span className="text-[10px] bg-emerald-950 text-emerald-300 border border-emerald-800 px-2 py-0.5 rounded-full font-bold">
                1-Click Full Loop
              </span>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Executes the complete procurement causal loop in one click: scopes Div 26 package, discovers trade contractors, records a Demo RFQ (no email), drafts a pre-bid RFI answer for GC review, ingests dual proposals, forensically levels with <strong className="text-emerald-300">ADR-0003</strong>, and drafts an A401-style subcontract agreement for external execution.
            </p>
            <p className="text-[10px] text-slate-400">
              The three scenario cards below use fixed demonstration figures for repeatable walkthroughs; they write real records to the active project.
            </p>
            <button
              disabled={loadingAction !== null || !projectId}
              onClick={handleRunFullCycle}
              className="w-full bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600 hover:from-emerald-400 hover:to-teal-400 disabled:opacity-50 text-slate-950 font-black text-xs py-2 px-4 rounded-xl flex items-center justify-center gap-2 transition shadow-lg shadow-emerald-950/40"
            >
              {loadingAction === "full_cycle" ? (
                <RefreshCw className="w-4 h-4 animate-spin text-slate-950" />
              ) : (
                <Zap className="w-4 h-4 fill-slate-950" />
              )}
              {loadingAction === "full_cycle"
                ? "Executing Full Autonomous Procurement Loop..."
                : "⚡ 1-Click Run Full Autonomous Procurement Lifecycle"}
            </button>
          </div>

          <div className="bg-gradient-to-r from-sky-950/70 via-slate-850 to-indigo-950/50 border-2 border-sky-500/50 rounded-xl p-3.5 shadow-lg space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-sky-300 uppercase tracking-wider flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 fill-sky-300" />
                TradePulse Pay
              </span>
              <span className="text-[10px] bg-sky-950 text-sky-300 border border-sky-800 px-2 py-0.5 rounded-full font-bold">
                Sandbox · about 3 minutes
              </span>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Executes a demo agreement, builds the schedule of values, files an honest pay app for sub1 and an overbilled one for
              its billing agent, then runs AI review, the KERNEL license check and pay-agent proposals. You approve one as proposed
              and one edited down; capture and payout keep 10% retainage, and a change order is invoiced to the Owner. You approve
              the PayPal funding yourself, and the Owner pays the invoice in their own browser.
            </p>
            <button
              disabled={loadingAction !== null}
              onClick={() => {
                sessionStorage.setItem(JUDGE_DEMO_AUTOSTART_KEY, "1");
                window.location.hash = "#/judge-demo";
                onClose();
              }}
              className="w-full bg-gradient-to-r from-sky-500 to-indigo-500 hover:from-sky-400 hover:to-indigo-400 disabled:opacity-50 text-slate-950 font-black text-xs py-2 px-4 rounded-xl flex items-center justify-center gap-2 transition shadow-lg shadow-sky-950/40"
            >
              <Play className="w-4 h-4 fill-slate-950" />
              Run TradePulse Pay demo
            </button>
          </div>

          {lastMessage && (
            <div className="bg-slate-800 border border-slate-700 text-xs text-slate-200 p-2.5 rounded-lg flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span className="leading-relaxed">{lastMessage}</span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-0.5">
            {/* Scenario 1: Subcontractor RFI */}
            <div className="bg-slate-850 border border-slate-700/80 rounded-xl p-3 sm:p-3.5 flex flex-col justify-between hover:border-slate-600 transition">
              <div>
                <div className="flex items-center gap-2 mb-1.5 text-sky-400 font-semibold text-xs">
                  <MessageSquare className="w-4 h-4" />
                  Scenario A: Pre-Bid RFI Inquiry
                </div>
                <p className="text-xs text-slate-300 mb-2 leading-relaxed">
                  Simulate an inbound electrical subcontractor email asking whether the GC or Sub supplies the 400A temporary power distribution board.
                </p>
                <div className="bg-slate-900 p-2 rounded text-[11px] text-slate-400 mb-2.5 border border-slate-800 font-mono">
                  AI draft answer cites Section 01 00 00 for GC review (no email is sent).
                </div>
              </div>
              <button
                disabled={loadingAction !== null}
                onClick={() => handleScenario("rfi_inquiry", "rfi_inquiry")}
                className="w-full bg-sky-700 hover:bg-sky-600 disabled:opacity-50 text-white text-xs font-semibold py-1.5 px-3 rounded-lg flex items-center justify-center gap-1.5 transition shadow-sm"
              >
                {loadingAction === "rfi_inquiry" ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5 fill-current" />
                )}
                Simulate Inbound RFI
              </button>
            </div>

            {/* Scenario 2: Bid with Scope Gaps & Exclusions */}
            <div className="bg-slate-850 border border-amber-800/40 rounded-xl p-3 sm:p-3.5 flex flex-col justify-between hover:border-amber-700/60 transition">
              <div>
                <div className="flex items-center gap-2 mb-1.5 text-amber-400 font-semibold text-xs">
                  <AlertTriangle className="w-4 h-4" />
                  Scenario B: Exclusion-Heavy Low Bidder
                </div>
                <p className="text-xs text-slate-300 mb-2 leading-relaxed">
                  Simulate a bidder submitting a deceptively low base bid ($1.08M) with hidden exclusions for crane hoisting and firestopping.
                </p>
                <div className="bg-slate-900 p-2 rounded text-[11px] text-amber-300/80 mb-2.5 border border-amber-900/30 font-mono">
                  Forensic Leveling: Engine detects $147k in exclusions + lead delay, raising leveled cost to $1.286M.
                </div>
              </div>
              <button
                disabled={loadingAction !== null}
                onClick={() => handleScenario("bid_with_hidden_exclusion", "bid_with_hidden_exclusion")}
                className="w-full bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-slate-950 font-bold text-xs py-1.5 px-3 rounded-lg flex items-center justify-center gap-1.5 transition shadow-sm"
              >
                {loadingAction === "bid_with_hidden_exclusion" ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5 fill-current" />
                )}
                Simulate Exclusion-Heavy Bid
              </button>
            </div>

            {/* Scenario 3: Clean Compliant Bid */}
            <div className="bg-slate-850 border border-emerald-800/40 rounded-xl p-3 sm:p-3.5 flex flex-col justify-between hover:border-emerald-700/60 transition">
              <div>
                <div className="flex items-center gap-2 mb-1.5 text-emerald-400 font-semibold text-xs">
                  <ShieldAlert className="w-4 h-4" />
                  Scenario C: Compliant Quality Bidder
                </div>
                <p className="text-xs text-slate-300 mb-2 leading-relaxed">
                  Simulate Rosendin Electric submitting a compliant bid ($1.225M) including all crane picks, firestop, and a $35k VE alternate deduct.
                </p>
                <div className="bg-slate-900 p-2 rounded text-[11px] text-emerald-300/80 mb-2.5 border border-emerald-900/30 font-mono">
                  Forensic Leveling: Zero exclusions + VE deduct normalizes cost to $1.190M (Rank #1 true lowest cost).
                </div>
              </div>
              <button
                disabled={loadingAction !== null}
                onClick={() => handleScenario("bid_clean_compliant", "bid_clean_compliant")}
                className="w-full bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold text-xs py-1.5 px-3 rounded-lg flex items-center justify-center gap-1.5 transition shadow-sm"
              >
                {loadingAction === "bid_clean_compliant" ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5 fill-current" />
                )}
                Simulate Compliant Bid
              </button>
            </div>

            {/* Scenario 4: Reset Demo State */}
            <div className="bg-slate-850 border border-slate-700/80 rounded-xl p-3 sm:p-3.5 flex flex-col justify-between hover:border-slate-600 transition">
              <div>
                <div className="flex items-center gap-2 mb-1.5 text-slate-400 font-semibold text-xs">
                  <RotateCcw className="w-4 h-4" />
                  Reset Demo Project Seed
                </div>
                <p className="text-xs text-slate-300 mb-2 leading-relaxed">
                  Restore the shared demo project to its seeded baseline. This clears live bids and contractor statuses on the demo only; audit history is kept but no longer shown.
                </p>
                <div className="bg-slate-900 p-2 rounded text-[11px] text-slate-400 mb-2.5 border border-slate-800 font-mono">
                  Resets the shared seeded demo project to its baseline (live bids and contractor statuses; audit history is kept). Custom projects are not modified.
                </div>
              </div>
              <button
                disabled={loadingAction !== null}
                onClick={() => setIsResetConfirmOpen(true)}
                className="w-full bg-slate-800 hover:bg-slate-750 text-slate-300 border border-slate-700 text-xs font-semibold py-1.5 px-3 rounded-lg flex items-center justify-center gap-1.5 transition"
              >
                {loadingAction === "reset_seed" ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="w-3.5 h-3.5" />
                )}
                Reset Demo Data
              </button>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-2.5 bg-slate-950 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
          <span>All simulation events write real-time audit logs to Convex database.</span>
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-750 text-slate-200 rounded-lg transition"
          >
            Close Dock
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={isResetConfirmOpen}
        title="Reset the shared demo project?"
        description="This restores the seeded demo project to its baseline and clears live bids and contractor statuses on the demo only. Audit history is kept but no longer shown. Custom projects are not modified."
        confirmLabel="Reset demo project"
        onCancel={() => setIsResetConfirmOpen(false)}
        onConfirm={async () => {
          await handleAction("reset_seed", onResetSeedData);
          setIsResetConfirmOpen(false);
        }}
      />
      <ConfirmDialog
        open={Boolean(simConfirm)}
        title="Run simulation in this project?"
        description={`${simConfirm?.label || "This simulation"} writes simulated packages, proposals, bids, and a subcontract draft into "${projectTitle || "the active project"}". This is a custom project — Reset Demo Data will not undo it.`}
        confirmLabel="Run simulation"
        onCancel={() => setSimConfirm(null)}
        onConfirm={async () => {
          const run = simConfirm?.run;
          setSimConfirm(null);
          if (run) await run();
        }}
      />
    </div>
  );
};
