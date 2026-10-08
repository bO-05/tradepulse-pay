import { getErrorMessage } from "../lib/errors.ts";
import React, { useState, useEffect } from "react";
import {
  Sparkles,
  CheckCircle2,
  Clock,
  Send,
  Building2,
  HelpCircle,
  FileText,
  FileDown,
  AlertTriangle,
  Check,
  X,
  Edit3,
  ShieldCheck,
  Filter,
  RefreshCw,
} from "lucide-react";
import { useAction, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api.js";
import { Conversation, Contractor, TradePackage } from "../types.ts";
import { MarkdownLite } from "../lib/markdown.tsx";
import { formatFullDateTime } from "../lib/datetime.ts";

interface PreBidQnAViewProps {
  currentPackage: TradePackage | null;
  tradePackages?: TradePackage[];
  onSelectPackage?: (id: string) => void;
  conversations: Conversation[];
  projectConversationsForAddendum?: Conversation[];
  contractors: Contractor[];
  onSubmitRfi: (data: {
    contractorId: string;
    subject: string;
    question: string;
    tradePackageId?: string;
  }) => Promise<{ conversationId?: string } | void>;
  onOpenSimulation: () => void;
  projectId?: string;
  projectTitle?: string;
  onRetryRfi?: (conversationId: string) => Promise<void>;
  onReviewRfi?: (
    convoId: string,
    status: "clarified" | "escalated_to_pm" | "rejected",
    newReply?: string,
    note?: string
  ) => Promise<void>;
  onNavigateToLeveling?: () => void;
  onNavigateToPackages?: () => void;
}

export const PreBidQnAView: React.FC<PreBidQnAViewProps> = ({
  currentPackage,
  tradePackages = [],
  onSelectPackage,
  conversations,
  projectConversationsForAddendum,
  contractors,
  onSubmitRfi,
  onOpenSimulation,
  projectId,
  projectTitle,
  onRetryRfi,
  onReviewRfi,
  onNavigateToLeveling,
  onNavigateToPackages,
}) => {
  const [submitting, setSubmitting] = useState(false);
  const [pendingRfi, setPendingRfi] = useState<{
    conversationId?: string;
    startedAt: number;
    baselineCount: number;
  } | null>(null);
  const [pendingTimedOut, setPendingTimedOut] = useState(false);
  const [rfiSubmitError, setRfiSubmitError] = useState<{ message: string; conversationId?: string } | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [selectedTradePackageId, setSelectedTradePackageId] = useState(currentPackage?._id || "");
  const [showWhyCare, setShowWhyCare] = useState(false);

  useEffect(() => {
    if (currentPackage?._id) setSelectedTradePackageId(currentPackage._id);
  }, [currentPackage?._id]);
  const [selectedContractorId, setSelectedContractorId] = useState("");
  const [subject, setSubject] = useState("");
  const [question, setQuestion] = useState("");
  const [filterMode, setFilterMode] = useState<"all" | "escalated" | "clarified">("all");

  // Editing state for PM review
  const [editingConvoId, setEditingConvoId] = useState<string | null>(null);
  const [editedReplyText, setEditedReplyText] = useState("");
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  // Pre-Bid Legal Addendum Generation State
  const [isGeneratingAddendum, setIsGeneratingAddendum] = useState(false);
  const [addendumError, setAddendumError] = useState<string | null>(null);
  const [addendumResult, setAddendumResult] = useState<{
    success: boolean;
    fileName: string;
    storageId: string;
    downloadUrl?: string;
    addendumText?: string;
    qaCount: number;
    csiDivisionCount: number;
    isLocalPreview?: boolean;
  } | null>(null);

  const generatePreBidAddendumAction = useAction(api.files.generatePreBidAddendum);
  const reviewEscalatedRfiMutation = useMutation(api.rfq.reviewEscalatedRfi);

  const handleDownloadAddendumFile = () => {
    if (!addendumResult) return;
    if (addendumResult.downloadUrl) {
      window.open(addendumResult.downloadUrl, "_blank");
      return;
    }
    const content = addendumResult.addendumText || "# ADDENDUM NO. 01\nCSI Specifications Addendum";
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", addendumResult.fileName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  if (!currentPackage) {
    return (
      <div className="p-12 text-center bg-slate-900 border border-slate-800 rounded-xl space-y-3">
        <p className="text-slate-400 text-sm">Please select a trade package to inspect pre-bid Q&A.</p>
        {onNavigateToPackages && (
          <button
            onClick={onNavigateToPackages}
            className="bg-slate-800 hover:bg-slate-750 text-emerald-300 border border-slate-700 text-xs font-semibold px-3 py-1.5 rounded-lg transition"
          >
            Go to CSI Scoping
          </button>
        )}
      </div>
    );
  }

  const contractorMap = new Map<string, Contractor>();
  contractors.forEach((c) => contractorMap.set(c._id, c));
  const addendumConversations = projectConversationsForAddendum ?? conversations;

  // F6: routing selector defaults to the active package but can be changed, so a
  // Div 22 question is never silently filed under the active Div 26 package.
  const tradeOptions = tradePackages.length > 0 ? tradePackages : [currentPackage];
  const targetPackage = tradeOptions.find((pkg) => pkg._id === selectedTradePackageId) || currentPackage;
  const isCrossPackage = targetPackage._id !== currentPackage._id;

  const escalatedCount = conversations.filter(
    (c) => (c.status === "escalated_to_pm" || c.status === "clarified") && !c.pmCertifiedAt
  ).length;
  const clarifiedCount = conversations.filter((c) => c.status === "clarified" && Boolean(c.pmCertifiedAt)).length;
  const pendingCertificationCount = addendumConversations.filter(
    (c) => c.status !== "rejected" && !c.pmCertifiedAt
  ).length;

  const filteredConversations = conversations.filter((c) => {
    if (filterMode === "escalated") {
      return (c.status === "escalated_to_pm" || c.status === "clarified") && !c.pmCertifiedAt;
    }
    if (filterMode === "clarified") return c.status === "clarified" && Boolean(c.pmCertifiedAt);
    return true;
  });

  const submitRfi = async () => {
    if (!question.trim() || submitting) return;
    if (!isCrossPackage && !selectedContractorId && contractors.length > 0) {
      setSelectedContractorId(contractors[0]._id);
    }
    const cId = isCrossPackage ? "guest_contractor" : (selectedContractorId || contractors[0]?._id || "guest_contractor");

    setSubmitting(true);
    setRfiSubmitError(null);
    setPendingTimedOut(false);
    try {
      const res = await onSubmitRfi({
        contractorId: cId,
        subject,
        question,
        tradePackageId: targetPackage._id,
      });
      setSubject("");
      setQuestion("");
      setPendingRfi({
        conversationId: res && "conversationId" in res ? res.conversationId : undefined,
        startedAt: Date.now(),
        baselineCount: conversations.length,
      });
    } catch (err: any) {
      setRfiSubmitError({
        message: getErrorMessage(err) || "The RFI could not be submitted. Your text was kept — try again.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submitRfi();
  };

  const retryAnalysis = async (conversationId?: string) => {
    const id = conversationId || pendingRfi?.conversationId || rfiSubmitError?.conversationId;
    if (!id || !onRetryRfi) {
      setRfiSubmitError(null);
      void submitRfi();
      return;
    }
    setRetryingId(id);
    setRfiSubmitError(null);
    try {
      await onRetryRfi(id);
      setPendingRfi({ conversationId: id, startedAt: Date.now(), baselineCount: conversations.length });
      setPendingTimedOut(false);
    } catch (err: any) {
      setRfiSubmitError({
        message: getErrorMessage(err) || "The retry could not be queued. The question is still saved.",
        conversationId: id,
      });
    } finally {
      setRetryingId(null);
    }
  };

  // F1: resolve the in-flight indicator from the persisted RFI row's status and
  // never spin forever — a timeout offers a retry without retyping.
  useEffect(() => {
    if (!pendingRfi) return;
    const byId = pendingRfi.conversationId
      ? conversations.find((c) => c._id === pendingRfi.conversationId)
      : undefined;
    if (byId) {
      if (byId.status === "pending_analysis") return;
      setPendingRfi(null);
      setPendingTimedOut(false);
      if (byId.status === "failed_analysis") {
        setRfiSubmitError({
          message: byId.analysisError || "The AI analysis failed. Your question is saved — retry it below.",
          conversationId: byId._id,
        });
      }
      return;
    }
    if (!pendingRfi.conversationId && conversations.length > pendingRfi.baselineCount) {
      setPendingRfi(null);
      setPendingTimedOut(false);
    }
  }, [conversations, pendingRfi]);

  useEffect(() => {
    if (!pendingRfi || pendingTimedOut) return;
    const startedAt = pendingRfi.startedAt;
    const timer = setInterval(() => {
      if (Date.now() - startedAt > 75_000) setPendingTimedOut(true);
    }, 3000);
    return () => clearInterval(timer);
  }, [pendingRfi, pendingTimedOut]);

  const handleGenerateAddendum = async () => {
    if (!projectId) {
      setAddendumError("No active project is selected for generating the addendum.");
      return;
    }
    setIsGeneratingAddendum(true);
    setAddendumError(null);
    if (pendingCertificationCount > 0) {
      setIsGeneratingAddendum(false);
      setAddendumError(`PM certification is required before issuing a binding addendum. Review ${pendingCertificationCount} pending RFI(s).`);
      return;
    }
    const certifiedCount = addendumConversations.filter((c) => c.status === "clarified" && c.pmCertifiedAt).length;
    if (certifiedCount === 0) {
      setIsGeneratingAddendum(false);
      setAddendumError("An addendum must clarify at least one PM-certified RFI. Submit and certify an RFI before issuing one.");
      return;
    }
    try {
      const res = await generatePreBidAddendumAction({ projectId: projectId as any });
      setAddendumResult(res as any);
    } catch (err: any) {
      if (!projectId.startsWith("proj_")) {
        setAddendumResult(null);
        setAddendumError(getErrorMessage(err) || "The addendum could not be stored in Convex File Storage.");
      } else {
      // Standalone mode can preview the addendum, but does not claim it was filed remotely.
      const mockFileName = `ADDENDUM_NO_01_CLARIFICATIONS.md`;
      const title = projectTitle || (currentPackage ? `${currentPackage.tradeName} Procurement Project` : "Commercial Construction Project");
      const div = currentPackage ? `${currentPackage.csiDivision} (${currentPackage.tradeName})` : "Multi-Division Specifications";
      const clarifiedList = addendumConversations.filter((c) => c.status === "clarified" && c.pmCertifiedAt);
      const activeList = clarifiedList;
      const qaItems = activeList.length > 0
        ? activeList.map((c, i) => `
#### Item 2.${i + 1} - CSI Division ${c.csiDivision || (currentPackage ? currentPackage.csiDivision : "Multi-Trade")} (${c.tradeName || (currentPackage ? currentPackage.tradeName : "Commercial Scope")}): ${c.inboundSubject}
- **Subcontractor Inquiry:** "${c.inboundQuestion}"
- **Authoritative Resolution:** ${c.autonomousReply}
- **Status:** Officially certified by General Contractor for AIA A401 contract inclusion
`).join("\n")
        : "No formal pre-bid RFIs submitted as of this addendum date.";

      const dynamicAddendumText = `# ADDENDUM NO. 01
## PROJECT SPECIFICATIONS & BIDDING DOCUMENTS CLARIFICATIONS
**Project:** ${title}
**Trade Scope:** ${div}
**Issuance Date:** ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
**Prepared by:** TradePulse Pay pre-bid clarification log
**Distribution:** All Registered CSI MasterFormat Trade Subcontractors

---

### NOTICE TO ALL BIDDERS:
This Addendum forms a legally binding part of the Contract Documents and modifies the original Bidding Documents. Bidders shall acknowledge receipt of this Addendum on their Proposal Forms. Failure to acknowledge receipt of this Addendum may subject the Bidder to disqualification.

### ARTICLE 1: GENERAL SPECIFICATIONS
1. **General Coordination**: Subcontractors shall coordinate deliveries, hoisting, rigging, and staging with General Contractor superintendent at least 72 hours prior to site mobilization.
2. **Temporary Utilities**: Temporary utility connections must be coordinated with the primary trade subcontractor.
3. **Mandatory Insurance Standards (ACORD 25)**: All trade subcontractors must maintain $2,000,000 General Aggregate, $1,000,000 Each Occurrence, and $5,000,000 Commercial Umbrella liability naming General Contractor as Additional Insured.

### ARTICLE 2: PRE-BID QUESTIONS & AUTHORITATIVE CLARIFICATIONS
${qaItems}

### ARTICLE 3: ACKNOWLEDGEMENT REQUIRED
Each proposal submitted must include affirmative written acknowledgement of ADDENDUM NO. 01.

---
**END OF ADDENDUM NO. 01**
`;

      setAddendumResult({
        success: true,
        fileName: mockFileName,
        storageId: `local_addendum_${Date.now()}`,
        addendumText: dynamicAddendumText,
        qaCount: activeList.length,
        csiDivisionCount: currentPackage ? 1 : 2,
        isLocalPreview: true,
      });
      }
    } finally {
      setIsGeneratingAddendum(false);
    }
  };

  const handleApprove = async (convo: Conversation) => {
    setReviewingId(convo._id);
    setReviewError(null);
    try {
      const newReply = editingConvoId === convo._id ? editedReplyText : convo.autonomousReply;
      if (onReviewRfi) {
        await onReviewRfi(convo._id, "clarified", newReply, "Approved by Project Manager for Addendum NO. 01");
      } else {
        await reviewEscalatedRfiMutation({
          conversationId: convo._id as any,
          status: "clarified",
          autonomousReply: newReply,
          reviewNote: "Approved by Project Manager for Addendum NO. 01",
        });
      }
      setEditingConvoId(null);
    } catch (err: any) {
      console.warn("Approve RFI fallback:", err);
      setReviewError(getErrorMessage(err) || "The RFI approval could not be saved.");
    } finally {
      setReviewingId(null);
    }
  };

  const handleReject = async (convo: Conversation) => {
    setReviewingId(convo._id);
    setReviewError(null);
    try {
      if (onReviewRfi) {
        await onReviewRfi(convo._id, "rejected", undefined, "Returned to subcontractor for scope clarification");
      } else {
        await reviewEscalatedRfiMutation({
          conversationId: convo._id as any,
          status: "rejected" as any,
          reviewNote: "Returned to subcontractor for scope clarification",
        });
      }
    } catch (err: any) {
      console.warn("Reject RFI fallback:", err);
      setReviewError(getErrorMessage(err) || "The RFI rejection could not be saved.");
    } finally {
      setReviewingId(null);
    }
  };

  const startEditing = (convo: Conversation) => {
    setEditingConvoId(convo._id);
    setEditedReplyText(convo.autonomousReply);
  };

  return (
    <div className="space-y-4">
      {reviewError && (
        <div className="rounded-xl border border-rose-800/80 bg-rose-950/40 p-3 text-xs text-rose-300" role="alert">
          RFI review failed: {reviewError}
        </div>
      )}
      {/* Header Banner with Trade Package Switcher */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5 shadow-sm space-y-3">
        {/* Trade Package Switcher Ribbon */}
        {tradePackages && tradePackages.length > 1 && onSelectPackage && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-2 border-b border-slate-800">
            <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mr-1.5 shrink-0">
              Select Trade:
            </span>
            {tradePackages.map((pkg) => {
              const isSelected = pkg._id === currentPackage.csiDivision || pkg._id === (currentPackage as any)?._id;
              return (
                <button
                  key={pkg._id}
                  aria-pressed={isSelected}
                  onClick={() => onSelectPackage(pkg._id)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition shrink-0 ${
                    isSelected
                      ? "bg-emerald-700 text-white font-bold shadow-sm ring-1 ring-emerald-400"
                      : "bg-slate-800 hover:bg-slate-750 text-slate-300 border border-slate-700 hover:border-slate-600"
                  }`}
                >
                  <span className="font-mono text-[11px] opacity-90">{pkg.csiDivision}</span>
                  <span className="truncate max-w-[140px] sm:max-w-[220px]" title={pkg.tradeName}>{pkg.tradeName}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-xs font-bold px-2 py-0.5 bg-slate-800 text-sky-400 border border-slate-700 rounded">
                CSI {currentPackage.csiDivision}
              </span>
              <h2 className="text-lg font-bold text-white tracking-tight">
                Pre-Bid RFI Autonomous Clarification & PM Review Queue
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-slate-400">
                Subcontractor inquiries answered by the configured AI provider against specifications (answers are drafts a project manager reviews before sending).
              </p>
              <button
                onClick={() => setShowWhyCare(!showWhyCare)}
                className="text-[10px] font-semibold text-sky-400 hover:text-sky-300 bg-sky-950/60 hover:bg-sky-900/60 border border-sky-800/60 px-2 py-0.5 rounded-full flex items-center gap-1 transition"
                title="Toggle commercial context"
              >
                <span>💡 Why GCs Care</span>
                <span className="text-[9px]">{showWhyCare ? "▲" : "▼"}</span>
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2.5 flex-wrap">
            {projectId && (
              <button
                disabled={isGeneratingAddendum || clarifiedCount === 0}
                onClick={handleGenerateAddendum}
                className="bg-slate-800 hover:bg-slate-750 disabled:opacity-50 disabled:cursor-not-allowed text-slate-200 border border-slate-700 hover:border-slate-600 font-semibold text-xs px-3.5 py-2 rounded-lg flex items-center gap-1.5 transition shadow-sm"
                title={
                  clarifiedCount === 0
                    ? "Certify at least one RFI (Approve for Addendum) before issuing a binding addendum"
                    : "Compile PM-certified RFIs into a TradePulse-generated CSI-style addendum (not an AIA document)"
                }
              >
                <FileText className="w-4 h-4 text-emerald-400" />
                {isGeneratingAddendum ? "Compiling Addendum..." : "📜 Issue Pre-Bid Addendum NO. 01"}
              </button>
            )}
            {projectId && clarifiedCount === 0 && (
              <span className="text-[10px] text-slate-400 font-mono w-full sm:w-auto">
                {escalatedCount > 0
                  ? `Certify at least one RFI to enable (${escalatedCount} awaiting PM review)`
                  : "Certify at least one RFI to enable"}
              </span>
            )}

            <button
              onClick={onOpenSimulation}
              className="bg-sky-700 hover:bg-sky-600 text-white font-semibold text-xs px-3.5 py-2 rounded-lg flex items-center gap-1.5 transition shadow-sm"
            >
              <Sparkles className="w-4 h-4" />
              Simulate Inbound RFI
            </button>
          </div>
        </div>

        {/* Collapsible Context */}
        {showWhyCare && (
          <div className="mt-3 pt-3 border-t border-slate-800 text-xs text-slate-300 leading-relaxed bg-slate-950/60 rounded-lg p-3 border animate-in fade-in">
            <span className="font-semibold text-sky-300">Addenda Rigor: </span>
            Verbal clarifications and disjointed email chains create over $300,000 in scope gap claims per commercial project. TradePulse Pay uses the configured AI provider (<strong className="text-sky-300 font-semibold">OpenAI is a BYOK adapter; Gemini/Claude run when configured</strong>) to answer trade RFIs against contract specifications, automatically cites governing CSI articles, and compiles binding <strong className="text-emerald-300 font-semibold">CSI Addendum No. 01</strong> files stored in Convex File Storage (<code className="text-emerald-300 bg-slate-900 px-1 py-0.5 rounded font-mono">_storage</code>).
          </div>
        )}
      </div>

      {/* Escalated RFI Alert Banner if pending items exist */}
      {escalatedCount > 0 && (
        <div className="bg-amber-950/40 border border-amber-800/80 rounded-xl p-4 flex items-center justify-between gap-4 animate-in fade-in">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
            <div className="text-xs space-y-0.5">
              <span className="font-bold text-amber-300">
                {escalatedCount} Subcontractor RFI{escalatedCount > 1 ? "s" : ""} Require PM Certification
              </span>
              <p className="text-slate-300">
                Requires Lead Estimator / Project Manager verification before being certified into official ADDENDUM NO. 01.
              </p>
            </div>
          </div>
          <button
            onClick={() => setFilterMode("escalated")}
            className="bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs px-3 py-1.5 rounded-lg shrink-0 transition"
          >
             Review PM Queue ({escalatedCount})
          </button>
        </div>
      )}

      {/* Addendum Issued Confirmation Banner */}
      {addendumResult && (
        <div className="bg-emerald-950/40 border border-emerald-800/80 rounded-xl p-4 flex items-start justify-between gap-4 animate-in fade-in">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            <div className="text-xs space-y-1">
              <h4 className="font-bold text-emerald-300 text-sm">
                 {addendumResult.isLocalPreview ? "Local Pre-Bid Addendum Preview Ready" : "Pre-Bid Addendum NO. 01 Successfully Issued & Filed"}
              </h4>
              <p className="text-slate-300 leading-relaxed">
                 {addendumResult.isLocalPreview ? "Preview only; this artifact was not filed to Convex Storage. " : "Compiled "}<strong className="text-white">{addendumResult.qaCount} PM-certified RFIs</strong> across{" "}
                <strong className="text-white">{addendumResult.csiDivisionCount} CSI divisions</strong> into a CSI MasterFormat pre-bid addendum (the subcontract draft is a separate A401-style document). Filed to the project document register as{" "}
                <span className="font-mono text-emerald-400 font-bold">{addendumResult.fileName}</span>.
              </p>
            </div>
          </div>
          {addendumResult.downloadUrl ? (
            <a
              href={addendumResult.downloadUrl}
              target="_blank"
              rel="noreferrer"
              className="bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-xs px-3 py-1.5 rounded-lg flex items-center gap-1 shrink-0 transition"
            >
              <FileDown className="w-3.5 h-3.5" />
              Download Addendum
            </a>
          ) : (
            <button
              type="button"
              onClick={handleDownloadAddendumFile}
              className="bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-xs px-3 py-1.5 rounded-lg flex items-center gap-1 shrink-0 transition"
            >
              <FileDown className="w-3.5 h-3.5" />
              Download Addendum
            </button>
          )}
        </div>
      )}
      {addendumError && (
        <div className="bg-rose-950/40 border border-rose-800/80 rounded-xl p-4 text-xs text-rose-300">
          Addendum generation failed: {addendumError}
        </div>
      )}

      {/* Filter Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3 text-xs">
        <span className="text-slate-400 font-medium flex items-center gap-1">
          <Filter className="w-3.5 h-3.5" />
          Queue Filter:
        </span>
        <button
          onClick={() => setFilterMode("all")}
          className={`px-3 py-1 rounded-lg font-semibold transition ${
            filterMode === "all"
              ? "bg-slate-800 text-white border border-slate-700"
              : "text-slate-400 hover:text-white"
          }`}
        >
          All RFIs ({conversations.length})
        </button>
        <button
          onClick={() => setFilterMode("escalated")}
          className={`px-3 py-1 rounded-lg font-semibold transition flex items-center gap-1.5 ${
            filterMode === "escalated"
              ? "bg-amber-950 text-amber-300 border border-amber-800"
              : "text-slate-400 hover:text-amber-300"
          }`}
        >
          <AlertTriangle className="w-3 h-3 text-amber-400" />
          PM Review Queue ({escalatedCount})
        </button>
        <button
          onClick={() => setFilterMode("clarified")}
          className={`px-3 py-1 rounded-lg font-semibold transition flex items-center gap-1.5 ${
            filterMode === "clarified"
              ? "bg-emerald-950 text-emerald-300 border border-emerald-800"
              : "text-slate-400 hover:text-emerald-300"
          }`}
        >
          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
          Approved for Addendum ({clarifiedCount})
        </button>
      </div>

      {/* Main Grid: Feed + Direct Submission */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Conversations Feed */}
        <div className="lg:col-span-2 space-y-4">
          {filteredConversations.length === 0 ? (
            <div className="p-12 text-center bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-400 space-y-1.5">
              {conversations.length === 0 ? (
                <>
                  <p className="text-slate-300 font-semibold">No pre-bid RFIs yet.</p>
                  <p>
                    Bidders email questions to this package's AgentMail inbox and they appear here automatically, or use
                    the form on the right to file one manually. Dispatch RFQs from Discovery first to start the round.
                  </p>
                </>
              ) : (
                <p>No pre-bid RFIs matching this queue filter.</p>
              )}
            </div>
          ) : (
            filteredConversations.map((conv) => {
              const contractor = contractorMap.get(conv.contractorId);
               const isEscalated = conv.status === "escalated_to_pm";
               const isClarified = conv.status === "clarified";
               const isCertified = isClarified && Boolean(conv.pmCertifiedAt);
               const isPendingCertification = !isCertified && (conv.status === "escalated_to_pm" || conv.status === "clarified");
              const isEditing = editingConvoId === conv._id;
              const isReviewing = reviewingId === conv._id;
              const isAnalyzing = conv.status === "pending_analysis";
              const isFailed = conv.status === "failed_analysis";

              return (
                <div
                  key={conv._id}
                  className={`bg-slate-900 border rounded-xl p-5 space-y-4 shadow-sm transition ${
                    isFailed
                      ? "border-rose-800/80 bg-rose-950/10"
                      : isAnalyzing
                      ? "border-sky-800/70 bg-sky-950/10"
                      : isPendingCertification
                      ? "border-amber-800/80 bg-amber-950/10"
                      : isClarified
                      ? "border-slate-800"
                      : "border-rose-800/50 bg-rose-950/10"
                  }`}
                >
                  {/* Contractor Header */}
                  <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
                    <div className="flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-slate-400" />
                      <span className="text-xs font-bold text-white">
                        {contractor ? contractor.companyName : (conv.contractorId === "guest_contractor" ? "Guest Subcontractor Bidder" : "Registered Subcontractor")}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                       {isCertified && (
                        <span
                          className="flex items-center gap-1 text-[11px] font-semibold bg-emerald-950/80 text-emerald-400 border border-emerald-800/60 px-2 py-0.5 rounded-full"
                          title={
                            conv.pmCertifiedBy
                              ? `Certified by ${conv.pmCertifiedBy}${conv.pmCertifiedAt ? ` on ${formatFullDateTime(conv.pmCertifiedAt)}` : ""}`
                              : undefined
                          }
                        >
                          <CheckCircle2 className="w-3 h-3" />
                          Approved for Addendum{conv.pmCertifiedBy ? ` · ${conv.pmCertifiedBy}` : ""}
                        </span>
                      )}
                      {isEscalated && (
                        <span className="flex items-center gap-1 text-[11px] font-semibold bg-amber-950/80 text-amber-300 border border-amber-800/60 px-2 py-0.5 rounded-full">
                          <AlertTriangle className="w-3 h-3 text-amber-400" /> PM Review Required
                        </span>
                      )}
                       {isPendingCertification && !isEscalated && (
                         <span className="flex items-center gap-1 text-[11px] font-semibold bg-rose-950/80 text-rose-300 border border-rose-800/60 px-2 py-0.5 rounded-full">
                           <Clock className="w-3 h-3" /> PM Review Required
                         </span>
                       )}
                      <span className="text-[11px] text-slate-400 font-mono" title="Local time with timezone">
                        {formatFullDateTime(conv.timestamp)}
                      </span>
                    </div>
                  </div>

                  {/* Subcontractor Inquiry */}
                  <div className="space-y-1.5 text-xs">
                    <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                      <HelpCircle className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      {conv.inboundSubject}
                    </div>
                    <p className="text-slate-300 pl-5 leading-relaxed bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/60 font-mono text-[11px]">
                      "{conv.inboundQuestion}"
                    </p>
                  </div>

                  {/* In-flight analysis status (F1) */}
                  {isAnalyzing && (
                    <div className="rounded-xl border border-sky-800/70 bg-sky-950/30 p-3 text-xs text-sky-200 flex items-start gap-2" role="status" aria-live="polite">
                      <RefreshCw className="w-4 h-4 text-sky-400 shrink-0 mt-0.5 animate-spin" />
                      <span className="leading-relaxed">
                        Saved. The AI is analyzing this question against the specification and drafting a citation.
                        This row updates automatically — no need to resubmit.
                      </span>
                    </div>
                  )}

                  {/* Failed analysis (F1): text is preserved, retry available */}
                  {isFailed && (
                    <div className="rounded-xl border border-rose-800/80 bg-rose-950/40 p-3 text-xs text-rose-200 space-y-2" role="alert">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                        <span className="leading-relaxed">
                          AI analysis failed for this RFI. The submitted question is preserved.
                          {conv.analysisError ? <span className="block text-rose-300/80 mt-1 font-mono text-[10px]">{conv.analysisError}</span> : null}
                        </span>
                      </div>
                      {onRetryRfi && (
                        <button
                          type="button"
                          onClick={() => retryAnalysis(conv._id)}
                          disabled={retryingId === conv._id}
                          className="bg-rose-700 hover:bg-rose-600 disabled:opacity-50 text-white font-bold text-xs px-3.5 py-1.5 rounded-lg flex items-center gap-1.5 transition"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${retryingId === conv._id ? "animate-spin" : ""}`} />
                          {retryingId === conv._id ? "Re-queuing..." : "Retry analysis"}
                        </button>
                      )}
                    </div>
                  )}

                  {/* AI Autonomous Clarification or PM Editing Form */}
                  {conv.autonomousReply && !isEditing && !isAnalyzing && !isFailed && (
                    <div className="bg-slate-950 rounded-xl p-4 border border-sky-900/40 space-y-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 font-bold text-sky-400 text-[11px]">
                          <Sparkles className="w-3.5 h-3.5" />
                          TradePulse AI Clarification
                        </span>

                        {conv.confidenceScore && (
                          <span className="text-[10px] font-mono px-2 py-0.5 bg-sky-950 text-sky-300 rounded border border-sky-800"title="Model confidence is self-reported by the LLM and still requires PM certification before it can bind.">
                            Confidence (self-reported): {Math.round(conv.confidenceScore * 100)}%
                          </span>
                        )}
                      </div>

                      <p className="text-slate-200 leading-relaxed pl-1">
                        <MarkdownLite text={conv.autonomousReply} className="space-y-1.5" />
                      </p>
                    </div>
                  )}

                  {/* Inline PM Response Editor */}
                  {isEditing && (
                    <div className="bg-slate-950 rounded-xl p-4 border border-amber-800/80 space-y-3 text-xs">
                      <div className="flex items-center justify-between text-amber-400 font-semibold text-xs">
                        <span className="flex items-center gap-1.5">
                          <Edit3 className="w-3.5 h-3.5" />
                          Edit Clarification for Addendum
                        </span>
                        <span className="text-[11px] text-slate-400">Governs legally once approved</span>
                      </div>
                      <textarea
                        rows={4}
                        value={editedReplyText}
                        onChange={(e) => setEditedReplyText(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-slate-100 text-xs focus:ring-1 focus:ring-amber-500 focus:outline-none font-mono"
                      />
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setEditingConvoId(null)}
                          className="px-3 py-1.5 rounded-lg text-slate-400 hover:text-white text-xs"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleApprove(conv)}
                          disabled={isReviewing}
                          className="bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-xs px-3.5 py-1.5 rounded-lg flex items-center gap-1"
                        >
                          <Check className="w-3.5 h-3.5" />
                          Save & Approve for Addendum
                        </button>
                      </div>
                    </div>
                  )}

                  {/* PM Review Actions Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800/80">
                    <div className="text-[11px] text-slate-400 flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 text-slate-400" />
                       {isAnalyzing
                         ? "Analysis in progress — no PM action needed yet."
                         : isFailed
                         ? "Analysis failed — the question is preserved; retry or ask the bidder to resubmit."
                         : isCertified
                         ? "Certified for inclusion in binding legal addenda."
                         : "Requires PM verification before addendum inclusion."}
                    </div>

                    <div className="flex items-center gap-2">
                      {!isEditing && !isAnalyzing && !isFailed && (
                        <button
                          onClick={() => startEditing(conv)}
                          className="p-1.5 bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-white rounded-lg transition text-xs flex items-center gap-1 border border-slate-700"
                          title="Edit clarification text before approving"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          <span className="text-[11px]">Edit Response</span>
                        </button>
                      )}

                       {isPendingCertification && (
                        <>
                          <button
                            onClick={() => handleReject(conv)}
                            disabled={isReviewing}
                            className="p-1.5 bg-slate-800 hover:bg-rose-950/80 text-slate-400 hover:text-rose-400 rounded-lg transition text-xs flex items-center gap-1 border border-slate-700"
                            title="Reject and request subcontractor revision"
                          >
                            <X className="w-3.5 h-3.5" />
                            <span className="text-[11px]">Reject</span>
                          </button>

                          <button
                            onClick={() => handleApprove(conv)}
                            disabled={isReviewing}
                            className="bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-xs px-3.5 py-1.5 rounded-lg flex items-center gap-1 transition shadow-sm"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>{isReviewing ? "Approving..." : "Approve for Addendum"}</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Right 1 Col: Direct RFI Submission Panel */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 h-fit space-y-4">
          {pendingRfi && (
            <div
              className={`rounded-xl border p-3 text-xs flex items-start gap-2 ${
                pendingTimedOut
                  ? "border-amber-800/70 bg-amber-950/30 text-amber-200"
                  : "border-sky-800/70 bg-sky-950/40 text-sky-200"
              }`}
              role="status"
              aria-live="polite"
            >
              {pendingTimedOut ? (
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              ) : (
                <RefreshCw className="w-4 h-4 text-sky-400 shrink-0 mt-0.5 animate-spin" />
              )}
              <span className="leading-relaxed">
                {pendingTimedOut ? (
                  <>
                    Analysis is taking longer than usual. Your question is saved as a pending RFI — you do not need
                    to retype it.{" "}
                    {pendingRfi.conversationId && onRetryRfi && (
                      <button
                        type="button"
                        onClick={() => retryAnalysis()}
                        disabled={retryingId !== null}
                        className="underline font-bold text-amber-100 hover:text-white disabled:opacity-50"
                      >
                        Retry analysis
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    RFI saved. The AI is analyzing it against the specification and drafting a citation; the
                    clarification appears in the list automatically (typically 10–30 seconds). No need to resubmit.
                  </>
                )}
              </span>
            </div>
          )}
          {rfiSubmitError && (
            <div className="rounded-xl border border-rose-800/70 bg-rose-950/40 p-3 text-xs text-rose-200 flex flex-wrap items-center gap-2" role="alert">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
              <span className="leading-relaxed flex-1 min-w-[160px]">{rfiSubmitError.message}</span>
              <button
                type="button"
                onClick={() => (rfiSubmitError.conversationId ? retryAnalysis(rfiSubmitError.conversationId) : submitRfi())}
                disabled={retryingId !== null || submitting}
                className="bg-rose-700 hover:bg-rose-600 disabled:opacity-50 text-white font-bold text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${retryingId || submitting ? "animate-spin" : ""}`} />
                {retryingId ? "Re-queuing..." : submitting ? "Submitting..." : "Retry"}
              </button>
            </div>
          )}
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
              <Send className="w-4 h-4 text-sky-400" />
              Manual Subcontractor RFI Form
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Submit a question as a trade bidder to test real-time spec-grounded LLM clarification.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
            <div>
              <label htmlFor="rfi-trade-package" className="block font-semibold text-slate-300 mb-1">
                Trade Package / Division
              </label>
              <select
                id="rfi-trade-package"
                aria-label="Target trade package for this RFI"
                value={targetPackage._id}
                onChange={(e) => setSelectedTradePackageId(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-sky-500 focus:outline-none font-medium"
              >
                {tradeOptions.map((pkg) => (
                  <option key={pkg._id} value={pkg._id}>
                    CSI {pkg.csiDivision} — {pkg.tradeName}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block font-semibold text-slate-300 mb-1">
                Subcontractor
              </label>
              <select
                value={isCrossPackage ? "guest_contractor" : selectedContractorId}
                aria-label="Submitting subcontractor"
                onChange={(e) => setSelectedContractorId(e.target.value)}
                disabled={isCrossPackage}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-sky-500 focus:outline-none font-medium disabled:opacity-60"
              >
                {isCrossPackage || contractors.length === 0 ? (
                  <option value="guest_contractor">
                    {isCrossPackage
                      ? "Guest / Inquiring Subcontractor (cross-package routing)"
                      : "Guest / Inquiring Subcontractor (No pre-registered bidders)"}
                  </option>
                ) : (
                  contractors.map((c) => (
                    <option key={c._id} value={c._id}>
                      {c.companyName} ({c.licenseNumber})
                    </option>
                  ))
                )}
              </select>
            </div>

            <div>
              <label className="block font-semibold text-slate-300 mb-1">
                Subject / Scope Topic
              </label>
              <input
                type="text"
                required
                value={subject}
                aria-label="RFI subject or scope topic"
                onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g. Hoisting responsibility for switchgear"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-sky-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-300 mb-1">
                Subcontractor Question
              </label>
              <textarea
                required
                rows={4}
                value={question}
                aria-label="Subcontractor question"
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask a technical or scope coordination question..."
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-sky-500 focus:outline-none leading-relaxed"
              />
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-300 flex items-start gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-sky-400 shrink-0 mt-0.5" />
              <span>
                <strong className="text-slate-200">Routing to:</strong> CSI {targetPackage.csiDivision} — {targetPackage.tradeName}
                {isCrossPackage && (
                  <span className="block text-slate-400 mt-0.5">
                    Different package than the page selector. No registered contractor exists here, so the inquiry will be
                    filed as a Guest bidder for {targetPackage.csiDivision}.
                  </span>
                )}
              </span>
            </div>

            <button
              type="submit"
              disabled={submitting || !subject.trim() || !question.trim()}
              className="w-full bg-sky-700 hover:bg-sky-600 disabled:opacity-50 text-white font-bold text-xs py-2.5 px-4 rounded-lg flex items-center justify-center gap-1.5 transition shadow-sm"
            >
              <Send className="w-3.5 h-3.5" />
              {submitting ? "Analyzing Specifications..." : "Submit RFI for Clarification"}
            </button>
          </form>
        </div>
      </div>

      {/* Forward Action: Next Pipeline Stage Banner */}
      {onNavigateToLeveling && (
        <div className="bg-gradient-to-r from-slate-900 via-slate-850 to-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 shadow-md">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-sky-950/80 border border-sky-800/60 flex items-center justify-center text-sky-400">
              <Check className="w-4 h-4" />
            </div>
            <div>
              <div className="text-xs font-bold text-white">
                Pre-Bid Clarifications Recorded ({conversations.length} RFIs Processed)
              </div>
              <div className="text-[11px] text-slate-400">
                Next Stage: Compare incoming trade proposals side-by-side and normalize hidden exclusions.
              </div>
            </div>
          </div>
          <button
            onClick={onNavigateToLeveling}
            className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-xs py-2 px-4 rounded-lg flex items-center gap-1.5 transition shadow-sm"
          >
            <span>Proceed to Bid Leveling Matrix</span>
            <span>➔</span>
          </button>
        </div>
      )}
    </div>
  );
};
