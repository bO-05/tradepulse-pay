import { getErrorMessage } from "../lib/errors.ts";
import React, { useState } from "react";
import {
  Layers,
  DollarSign,
  Mail,
  Calendar,
  Send,
  Plus,
  CheckCircle,
  AlertCircle,
  Clock,
  ShieldCheck,
  Sparkles,
  X,
  Check,
  Trash2,
} from "lucide-react";
import { useQuery, useAction } from "convex/react";
import { api } from "../../convex/_generated/api.js";
import { TradePackage, Project } from "../types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { useDialogFocus, useEscapeToClose } from "../lib/useDialogFocus.ts";

/** A14-01: the date input minimum must be the user's LOCAL calendar day. */
function localDateInputValue(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

interface TradePackagesViewProps {
  currentProject?: Project | null;
  tradePackages: TradePackage[];
  activePackageId: string;
  onSelectPackage: (id: string) => void;
  onDispatchRfqs: (packageId: string) => Promise<void>;
  onCreatePackage: (pkg: {
    csiDivision: string;
    tradeName: string;
    budgetEstimate: number;
    scopeSummary: string;
    mandatoryInclusions: string[];
    bidDeadline: string;
  }) => Promise<void>;
  onGenerateTradePackagesFromSpec?: (
    specText: string,
    opts?: { previewOnly?: boolean; confirmedPackages?: any[] }
  ) => Promise<{ packagesCount: number; packages?: any[] }>;
  onDeletePackage?: (packageId: string) => Promise<void>;
  onNavigateToDiscovery?: () => void;
  isLoading?: boolean;
}

export const TradePackagesView: React.FC<TradePackagesViewProps> = ({
  currentProject,
  tradePackages,
  activePackageId,
  onSelectPackage,
  onDispatchRfqs,
  onCreatePackage,
  onGenerateTradePackagesFromSpec,
  onDeletePackage,
  onNavigateToDiscovery,
  isLoading = false,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const createDialogRef = useDialogFocus<HTMLDivElement>(isModalOpen);
  useEscapeToClose(isModalOpen, () => setIsModalOpen(false));
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);
  const [showWhyCare, setShowWhyCare] = useState(false);

  // AI Spec Breakdown Modal state
  const [isSpecModalOpen, setIsSpecModalOpen] = useState(false);
  const specDialogRef = useDialogFocus<HTMLDivElement>(isSpecModalOpen);
  const [specInputText, setSpecInputText] = useState("");
  const [isGeneratingPackages, setIsGeneratingPackages] = useState(false);
  useEscapeToClose(isSpecModalOpen, () => setIsSpecModalOpen(false), !isGeneratingPackages);
  const [generationSuccessMessage, setGenerationSuccessMessage] = useState<string | null>(null);
  const [generationErrorMessage, setGenerationErrorMessage] = useState<string | null>(null);
  // A6-42: parsed divisions must be echoed and confirmed before anything is written.
  const [previewPackages, setPreviewPackages] = useState<any[] | null>(null);
  const [packageToDelete, setPackageToDelete] = useState<TradePackage | null>(null);
  const [creationError, setCreationError] = useState<string | null>(null);

  // Form state
  const [csiDivision, setCsiDivision] = useState("26 00 00");
  const [tradeName, setTradeName] = useState("");
  const [budgetEstimate, setBudgetEstimate] = useState(1250000);
  const [scopeSummary, setScopeSummary] = useState("");
  const [mandatoryInclusions, setMandatoryInclusions] = useState("Crane hoisting\nSeismic bracing\nTemporary power");
  const [bidDeadline, setBidDeadline] = useState("2026-09-30");

  const generateTradePackagesAction = useAction(api.tradePackages.generateTradePackagesFromSpec);
  // A6-29: real per-package email delivery outcome from the audit trail.
  const deliveryStatus = useQuery(
    api.rfq.getProjectDeliveryStatus,
    currentProject && !currentProject._id.startsWith("proj_") ? { projectId: currentProject._id as any } : "skip"
  ) as Record<string, { sent: number; eligible: number; at: number }> | undefined;

  const handleDispatch = async (pkgId: string) => {
    setDispatchingId(pkgId);
    try {
      await onDispatchRfqs(pkgId);
    } finally {
      setDispatchingId(null);
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreationError(null);
    try {
      await onCreatePackage({
        csiDivision,
        tradeName,
        budgetEstimate: Number(budgetEstimate),
        scopeSummary,
        mandatoryInclusions: mandatoryInclusions.split("\n").map((s) => s.trim()).filter(Boolean),
        bidDeadline,
      });
      setIsModalOpen(false);
      setTradeName("");
      setScopeSummary("");
    } catch (err: any) {
      setCreationError(getErrorMessage(err) || "The trade package could not be created.");
    }
  };

  // A6-42 step 1: parse and echo detected divisions/scope; nothing is written yet.
  const handleSpecBreakdownSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentProject || !specInputText.trim()) return;
    setIsGeneratingPackages(true);
    setGenerationSuccessMessage(null);
    setGenerationErrorMessage(null);
    setPreviewPackages(null);
    try {
      let packages: any[] = [];
      if (onGenerateTradePackagesFromSpec) {
        const res = await onGenerateTradePackagesFromSpec(specInputText.trim(), { previewOnly: true });
        packages = res.packages ?? [];
      } else {
        const res = await generateTradePackagesAction({
          projectId: currentProject._id as any,
          specDocumentTextOverride: specInputText.trim(),
          previewOnly: true,
        });
        packages = (res as any).packages ?? [];
      }
      if (packages.length === 0) {
        throw new Error("No trade divisions could be detected from that text. Review the specification and try again.");
      }
      setPreviewPackages(packages);
    } catch (err: any) {
      setGenerationErrorMessage(getErrorMessage(err) || "Specification breakdown failed.");
    } finally {
      setIsGeneratingPackages(false);
    }
  };

  // A6-42 step 2: write exactly the packages the GC confirmed.
  const handleConfirmGenerate = async () => {
    if (!currentProject || !previewPackages || previewPackages.length === 0) return;
    setIsGeneratingPackages(true);
    setGenerationErrorMessage(null);
    try {
      let count = previewPackages.length;
      if (onGenerateTradePackagesFromSpec) {
        const res = await onGenerateTradePackagesFromSpec(specInputText.trim(), { confirmedPackages: previewPackages });
        count = res.packagesCount;
      } else {
        const res = await generateTradePackagesAction({
          projectId: currentProject._id as any,
          specDocumentTextOverride: specInputText.trim(),
          confirmedPackages: previewPackages as any,
        });
        count = (res as any).packagesCount;
      }
      setGenerationSuccessMessage(
        `Generated ${count} GC-confirmed CSI MasterFormat trade package(s) with AgentMail inboxes!`
      );
      setPreviewPackages(null);
      setTimeout(() => {
        setIsSpecModalOpen(false);
        setGenerationSuccessMessage(null);
        setSpecInputText("");
      }, 2000);
    } catch (err: any) {
      setGenerationErrorMessage(getErrorMessage(err) || "Specification breakdown failed.");
    } finally {
      setIsGeneratingPackages(false);
    }
  };

  const populateSampleSpec = () => {
    setPreviewPackages(null);
    setGenerationErrorMessage(null);
    setSpecInputText(
      `SECTION 01 00 00 - SUMMARY OF WORK
General Contractor shall furnish all temporary site utilities, crane access, and safety coordination.
All subcontractors must carry $5,000,000 umbrella liability and name Owner and General Contractor as additional insureds under ACORD 25.

SECTION 26 00 00 - ELECTRICAL SPECIFICATIONS
Furnish and install 1600A 480/277V Main Distribution Switchboard, dry-type step-down transformers, and emergency lighting inverters. Subcontractor is strictly responsible for crane hoisting and rigging of heavy switchgear to the 14th-floor penthouse equipment room. Provide UL 1479 compliant penetrations and IBC Section 1613 seismic bracing for all conduits and cable trays.

SECTION 23 00 00 - HEATING, VENTILATING, AND AIR CONDITIONING (HVAC)
Furnish and install rooftop air handling units, variable air volume (VAV) terminal boxes with electric reheat coils, and hydronic chiller loops. Includes BACnet MS/TP automation protocol integration gateways to central building management system. Subcontractor must provide sound attenuators and vibration isolation springs.

SECTION 22 00 00 - PLUMBING SYSTEMS
Furnish and install domestic cold, hot, and recirculated water piping, sanitary waste, vent piping, and triplex domestic water booster pump system. Subcontractor must provide factory certified startup technician commissioning, seismic snubbers, and shock arrestors.`
    );
  };

  const getStatusBadge = (status: TradePackage["status"]) => {
    switch (status) {
      case "awarded":
        return (
          <span className="flex items-center gap-1 text-[11px] font-semibold bg-emerald-950/70 text-emerald-400 border border-emerald-800/60 px-2 py-0.5 rounded-full">
            <CheckCircle className="w-3 h-3" /> Subcontract Awarded
          </span>
        );
      case "leveling":
        return (
          <span className="flex items-center gap-1 text-[11px] font-semibold bg-amber-950/70 text-amber-300 border border-amber-800/60 px-2 py-0.5 rounded-full">
            <AlertCircle className="w-3 h-3" /> Active Bid Leveling
          </span>
        );
      case "rfqs_dispatched":
        return (
          <span className="flex items-center gap-1 text-[11px] font-semibold bg-sky-950/70 text-sky-300 border border-sky-800/60 px-2 py-0.5 rounded-full">
            <Clock className="w-3 h-3" /> RFQs Dispatched
          </span>
        );
      default:
        return (
          <span className="text-[11px] font-semibold bg-slate-800 text-slate-300 border border-slate-700 px-2 py-0.5 rounded-full">
            Draft
          </span>
        );
    }
  };

  return (
    <div className="space-y-4">
      {/* View Header Card */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-[11px] font-bold px-2 py-0.5 bg-emerald-950/80 text-emerald-400 border border-emerald-800/60 rounded flex items-center gap-1">
                <Layers className="w-3.5 h-3.5" />
                Stage 01: CSI Scoping
              </span>
              <h2 className="text-lg font-bold text-white tracking-tight">
                CSI MasterFormat Trade Packages
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-0.5">
              <p className="text-xs text-slate-400">
                Commercial trade divisions scoped with mandatory inclusions and programmatic AgentMail project inboxes.
              </p>
              <button
                onClick={() => setShowWhyCare(!showWhyCare)}
                className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300 bg-emerald-950/60 hover:bg-emerald-900/60 border border-emerald-800/60 px-2 py-0.5 rounded-full flex items-center gap-1 transition"
                title="Toggle commercial context"
              >
                <span>💡 Why GCs Care</span>
                <span className="text-[9px]">{showWhyCare ? "▲" : "▼"}</span>
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            {currentProject && (
              <button
                onClick={() => {
                  // A18-01: start each breakdown from a clean draft.
                  setPreviewPackages(null);
                  setGenerationErrorMessage(null);
                  setSpecInputText("");
                  setIsSpecModalOpen(true);
                  populateSampleSpec();
                }}
                className="bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-600 hover:to-yellow-600 text-slate-950 font-bold text-xs px-3.5 py-2 rounded-lg flex items-center gap-1.5 transition shadow-sm"
              >
                <Sparkles className="w-4 h-4 fill-slate-950" />
                ⚡ AI Spec Breakdown (Auto-Scope)
              </button>
            )}
            <button
              onClick={() => {
                // A18-01: a cancelled package draft must not leak values forward.
                setCsiDivision("26 00 00");
                setTradeName("");
                setBudgetEstimate(1250000);
                setScopeSummary("");
                setMandatoryInclusions("Crane hoisting\nSeismic bracing\nTemporary power");
                setBidDeadline("2026-09-30");
                setCreationError(null);
                setIsModalOpen(true);
              }}
              className="bg-emerald-700 hover:bg-emerald-700 text-white font-semibold text-xs px-3.5 py-2 rounded-lg flex items-center gap-1.5 transition shadow-sm"
            >
              <Plus className="w-4 h-4" />
              Create Trade Package
            </button>
          </div>
        </div>

        {/* Collapsible Executive Problem & Value Context */}
        {showWhyCare && (
          <div className="mt-3 pt-3 border-t border-slate-800 text-xs text-slate-300 leading-relaxed bg-slate-950/60 rounded-lg p-3 border animate-in fade-in">
            <span className="font-semibold text-emerald-400">GC Preconstruction Baseline: </span>
            General Contractors prevent scope voids and trade clash claims by defining clear CSI MasterFormat boundaries before soliciting bids. TradePulse Pay provisions programmatic <code className="text-emerald-300 bg-slate-900 px-1 py-0.5 rounded font-mono">@agentmail.to</code> inboxes per trade package — shared when the AgentMail plan limit is reached, and labeled as shared on the package card — so all subcontractor communications are tracked and audit-ready.
          </div>
        )}
      </div>

      {/* Package Grid */}
      {isLoading && tradePackages.length === 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5" aria-busy="true" aria-label="Loading trade packages">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-44 rounded-2xl bg-slate-900/60 border border-slate-800 animate-pulse" />
          ))}
        </div>
      ) : tradePackages.length === 0 ? (
        <div className="p-12 text-center bg-slate-900/60 border border-dashed border-slate-800 rounded-2xl flex flex-col items-center justify-center space-y-3">
          <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center text-slate-400">
            <Layers className="w-6 h-6" />
          </div>
          <h3 className="text-base font-bold text-white">No Trade Packages Configured</h3>
          <p className="text-xs text-slate-400 max-w-md">
            Break down your architectural specifications into CSI MasterFormat buyout packages using AI Spec Breakdown, or create a package manually.
          </p>
          <p className="text-[11px] text-slate-400 pt-1">
            Use <strong className="text-slate-300">⚡ AI Spec Breakdown (Auto-Scope)</strong> or{" "}
            <strong className="text-slate-300">Create Trade Package</strong> in the header above to get started.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {tradePackages.map((pkg) => {
            const isSelected = pkg._id === activePackageId;
            return (
              <div
                key={pkg._id}
                onClick={() => onSelectPackage(pkg._id)}
                className={`rounded-xl border p-5 transition cursor-pointer flex flex-col justify-between ${
                  isSelected
                    ? "bg-slate-850/90 border-emerald-500/80 shadow-lg shadow-emerald-950/20 ring-1 ring-emerald-500/30"
                    : "bg-slate-900/80 border-slate-800 hover:border-slate-700"
                }`}
              >
                <div>
                  {/* Division & Status */}
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <span className="font-mono text-xs font-bold px-2 py-0.5 bg-slate-800 text-slate-200 border border-slate-700 rounded">
                      Div {pkg.csiDivision}
                    </span>
                    {getStatusBadge(pkg.status)}
                  </div>

                  {/* Trade Name */}
                  <h3 className="text-base font-bold text-white mb-2 line-clamp-1">
                    {pkg.tradeName}
                  </h3>

                  <p className="text-xs text-slate-400 mb-4 line-clamp-2 leading-relaxed">
                    {pkg.scopeSummary}
                  </p>

                  {/* Key Metrics */}
                  <div className="space-y-2 mb-4 text-xs border-y border-slate-800/80 py-3">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400 flex items-center gap-1">
                        <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
                        Budget Estimate:
                      </span>
                      <span className="font-semibold text-slate-200 font-mono">
                        ${pkg.budgetEstimate.toLocaleString()}
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-slate-400 flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" />
                        Bid Deadline:
                      </span>
                      <span className="text-slate-300 font-mono text-[11px]">
                        {pkg.bidDeadline}
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-slate-400 flex items-center gap-1">
                        <Mail className="w-3.5 h-3.5 text-blue-400" />
                        AgentMail Inbox:
                      </span>
                      <span className="text-blue-300 font-mono text-[11px] truncate max-w-[180px]">
                        {pkg.agentMailbox}
                      </span>
                    </div>
                    {pkg.agentMailboxShared && (
                      <div className="text-[10px] text-amber-300 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        Shared inbox — AgentMail plan inbox limit reached
                      </div>
                    )}
                    {String(pkg.agentMailboxId || "").startsWith("local_") && (
                      <div className="text-[10px] text-amber-300 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        Inbox not provisioned — AgentMail unavailable
                      </div>
                    )}
                    {deliveryStatus?.[pkg._id]?.sent === 0 && deliveryStatus[pkg._id].eligible > 0 && (
                      <div className="text-[10px] text-rose-300 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        Email delivery unavailable — last dispatch delivered 0 of {deliveryStatus[pkg._id].eligible} (see audit)
                      </div>
                    )}
                  </div>

                  {/* Mandatory Inclusions */}
                  <div>
                    <div className="text-[11px] font-semibold text-slate-300 mb-1.5 flex items-center gap-1">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                      Mandatory Scope Inclusions:
                    </div>
                    <ul className="space-y-1">
                      {pkg.mandatoryInclusions.slice(0, 3).map((inc, i) => (
                        <li key={i} className="text-[11px] text-slate-400 flex items-start gap-1.5">
                          <span className="text-emerald-500 font-bold">•</span>
                          <span className="line-clamp-1">{inc}</span>
                        </li>
                      ))}
                      {pkg.mandatoryInclusions.length > 3 && (
                        <li className="text-[10px] text-slate-400 font-medium pl-3">
                          +{pkg.mandatoryInclusions.length - 3} more required items
                        </li>
                      )}
                    </ul>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="mt-5 pt-3 border-t border-slate-800/80 flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectPackage(pkg._id);
                    }}
                    className={`flex-1 text-xs font-semibold py-1.5 px-3 rounded-lg transition text-center ${
                      isSelected
                        ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                        : "bg-slate-800 hover:bg-slate-700 text-slate-300"
                    }`}
                  >
                    {isSelected ? "Active Package" : "Inspect Package"}
                  </button>

                  <button
                    disabled={dispatchingId === pkg._id}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDispatch(pkg._id);
                    }}
                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold py-1.5 px-3 rounded-lg flex items-center gap-1 transition"
                    title="Dispatch RFQ emails to discovered contractors via AgentMail"
                  >
                    <Send className="w-3 h-3" />
                    Dispatch RFQs
                  </button>

                  {onDeletePackage && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setPackageToDelete(pkg);
                      }}
                      className="bg-slate-800 hover:bg-rose-950/60 hover:text-rose-400 hover:border-rose-800/60 border border-slate-700 text-slate-400 text-xs font-semibold p-1.5 rounded-lg transition"
                      title="Delete Trade Package"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Forward Action: Next Pipeline Stage Banner */}
      {tradePackages.length > 0 && onNavigateToDiscovery && (
        <div className="bg-gradient-to-r from-slate-900 via-slate-850 to-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 shadow-md">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-950/80 border border-blue-800/60 flex items-center justify-center text-blue-400">
              <Check className="w-4 h-4" />
            </div>
            <div>
              <div className="text-xs font-bold text-white">
                CSI Scoping Ready ({tradePackages.length} Divisions Active)
              </div>
              <div className="text-[11px] text-slate-400">
                Next Stage: Discover licensed specialty contractors via Firecrawl and dispatch invitation to bid.
              </div>
            </div>
          </div>
          <button
            onClick={onNavigateToDiscovery}
            className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-xs py-2 px-4 rounded-lg flex items-center gap-1.5 transition shadow-sm"
          >
            <span>Advance to Contractor Discovery</span>
            <span>➔</span>
          </button>
        </div>
      )}

      {/* AI Spec Breakdown Modal */}
      {isSpecModalOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isGeneratingPackages) setIsSpecModalOpen(false);
          }}
        >
          <div
            ref={specDialogRef}
            className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="spec-breakdown-title"
          >
            <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-amber-950/80 border border-amber-700/60 flex items-center justify-center text-amber-400">
                  <Sparkles className="w-5 h-5 fill-amber-400" />
                </div>
                <div>
                  <h3 id="spec-breakdown-title" className="text-base font-bold text-white">
                    AI Specification Breakdown & Auto-Scoping
                  </h3>
                  <p className="text-xs text-slate-400">
                    Parse architectural project specifications into standard CSI MasterFormat divisions with AgentMail inboxes
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsSpecModalOpen(false)}
                className="p-2 text-slate-400 hover:text-white rounded-lg transition"
                aria-label="Close AI specification breakdown dialog"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSpecBreakdownSubmit} className="p-5 space-y-4 text-xs">
              <div className="flex items-center justify-between">
                <label className="font-semibold text-slate-300">
                  Architectural & Engineering Specifications Text
                </label>
                <button
                  type="button"
                  onClick={populateSampleSpec}
                  className="text-amber-400 hover:text-amber-300 text-[11px] font-semibold transition"
                >
                  Load 4-Trade MEP Sample
                </button>
              </div>

              <textarea
                rows={8}
                aria-label="Architectural and engineering specifications text"
                value={specInputText}
                onChange={(e) => setSpecInputText(e.target.value)}
                placeholder="Paste project manual or CSI specification divisions..."
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-white font-mono text-xs focus:ring-1 focus:ring-emerald-500 focus:outline-none leading-relaxed"
                required
              />

              {previewPackages && previewPackages.length > 0 && (
                <div className="bg-slate-950 border border-emerald-800/60 rounded-lg p-3 space-y-2">
                  <div className="text-emerald-300 font-semibold text-xs">
                    Step 2 of 2 — review the {previewPackages.length} detected package(s). Nothing is written until you confirm.
                  </div>
                  <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                    {previewPackages.map((p, i) => (
                      <div key={i} className="border border-slate-800 rounded-lg p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[11px] font-bold text-white">Div {String(p.csiDivision || "?")}</span>
                          <span className="font-mono text-[11px] text-emerald-300">
                            ${Number(p.budgetEstimate || 0).toLocaleString("en-US")}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-200 font-semibold">{String(p.tradeName || "")}</div>
                        <div className="text-[10px] text-slate-400 line-clamp-2">{String(p.scopeSummary || "")}</div>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setPreviewPackages(null)}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg font-semibold transition"
                    >
                      Re-parse
                    </button>
                    <button
                      type="button"
                      onClick={handleConfirmGenerate}
                      disabled={isGeneratingPackages}
                      className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold rounded-lg transition shadow-sm"
                    >
                      {isGeneratingPackages
                        ? "Generating..."
                        : `Generate ${previewPackages.length} Trade Package${previewPackages.length === 1 ? "" : "s"}`}
                    </button>
                  </div>
                </div>
              )}

              {generationSuccessMessage && (
                <div className="bg-emerald-950/60 border border-emerald-800 text-emerald-400 p-3 rounded-lg flex items-center gap-2 text-xs font-semibold">
                  <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                  {generationSuccessMessage}
                </div>
              )}
              {generationErrorMessage && (
                <div className="bg-rose-950/60 border border-rose-800 text-rose-300 p-3 rounded-lg text-xs font-semibold">
                  Specification breakdown failed: {generationErrorMessage}
                </div>
              )}

              <div className="pt-3 border-t border-slate-800 flex items-center justify-between gap-3">
                <span className="text-[11px] text-slate-400">
                  Target Project: {currentProject?.title}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsSpecModalOpen(false)}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-750 text-slate-300 rounded-lg font-semibold transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isGeneratingPackages || !specInputText.trim()}
                    className="px-4 py-2 bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-600 hover:to-yellow-600 disabled:opacity-50 text-slate-950 font-bold rounded-lg flex items-center gap-1.5 transition shadow-sm"
                  >
                    <Sparkles className="w-4 h-4 fill-slate-950" />
                    {isGeneratingPackages
                      ? "Analyzing Specs..."
                      : previewPackages
                      ? "Re-parse Specifications"
                      : "Analyze Specifications & Preview"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Manual Create Modal */}
      {isModalOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsModalOpen(false);
          }}
        >
          <div
            ref={createDialogRef}
            className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-package-title"
          >
            <h3 id="create-package-title" className="text-lg font-bold text-white mb-4">Create CSI Trade Package</h3>
            <form onSubmit={handleFormSubmit} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-400 font-medium mb-1">CSI Division Number</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. 26 00 00"
                  aria-label="CSI division number"
                  value={csiDivision}
                  pattern="[0-9]{2} [0-9]{2} [0-9]{2}"
                  title="Use CSI format NN NN NN, for example 26 00 00."
                  onChange={(e) => setCsiDivision(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-400 font-medium mb-1">Trade Package Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Electrical & Lighting Systems"
                  aria-label="Trade package name"
                  value={tradeName}
                  onChange={(e) => setTradeName(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-400 font-medium mb-1">Budget Estimate ($)</label>
                <input
                  type="number"
                  required
                  aria-label="Budget estimate in dollars"
                  value={budgetEstimate}
                  min={1}
                  max={1000000000}
                  onChange={(e) => setBudgetEstimate(Number(e.target.value))}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-400 font-medium mb-1">Scope Summary</label>
                <textarea
                  required
                  rows={2}
                  placeholder="Scope details..."
                  aria-label="Scope summary"
                  value={scopeSummary}
                  onChange={(e) => setScopeSummary(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-400 font-medium mb-1">Mandatory Inclusions (one per line)</label>
                <textarea
                  rows={3}
                  aria-label="Mandatory inclusions, one per line"
                  value={mandatoryInclusions}
                  onChange={(e) => setMandatoryInclusions(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500 font-mono text-xs"
                />
              </div>

              <div>
                <label className="block text-slate-400 font-medium mb-1">Bid Deadline</label>
                <input
                  type="date"
                  required
                  aria-label="Bid deadline"
                  value={bidDeadline}
                  min={localDateInputValue()}
                  onChange={(e) => setBidDeadline(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                {creationError && <p role="alert" className="mr-auto max-w-[55%] text-[11px] text-rose-400">{creationError}</p>}
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-750 text-slate-300 rounded-lg transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-emerald-700 hover:bg-emerald-700 text-white font-semibold rounded-lg transition"
                >
                  Create Package
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(packageToDelete)}
        title="Delete trade package?"
        description={packageToDelete ? `This removes ${packageToDelete.tradeName} (Division ${packageToDelete.csiDivision}) and its associated proposals, files, and contractor records.` : ""}
        confirmLabel="Delete package"
        onCancel={() => setPackageToDelete(null)}
        onConfirm={async () => {
          if (packageToDelete && onDeletePackage) {
            await onDeletePackage(packageToDelete._id);
          }
          setPackageToDelete(null);
        }}
      />
    </div>
  );
};
