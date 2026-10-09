import React, { useState } from "react";
import {
  FileText,
  CheckCircle2,
  Clock,
  Download,
  Printer,
  Copy,
  Check,
  X,
  Search,
  Award,
} from "lucide-react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api.js";
import { Project, Agreement } from "../types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { useDialogFocus, useEscapeToClose } from "../lib/useDialogFocus.ts";
import { printContractText } from "../lib/printContract.ts";
import { formatCents, fromDollars } from "../../convex/lib/money";
import { AgreementTermsPanel } from "../contracts/AgreementTermsPanel.tsx";

interface ContractsRegisterViewProps {
  currentProject: Project | null;
  onNavigateToLeveling?: () => void;
  fallbackAgreements?: Agreement[];
  onExecuteAgreement?: (agreementId: string) => Promise<void>;
  onNavigateToAudit?: () => void;
}

export const ContractsRegisterView: React.FC<ContractsRegisterViewProps> = ({
  currentProject,
  onNavigateToLeveling,
  fallbackAgreements = [],
  onExecuteAgreement,
  onNavigateToAudit,
}) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedAgreementId, setSelectedAgreementId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showWhyCare, setShowWhyCare] = useState(false);
  const [agreementToExecute, setAgreementToExecute] = useState<string | null>(null);
  const [agreementToVoid, setAgreementToVoid] = useState<string | null>(null);
  const agreementsData = useQuery(
    api.agreements.listAgreements,
    currentProject && !currentProject._id.startsWith("proj_") ? { projectId: currentProject._id as any } : "skip"
  );
  const agreements: Agreement[] = (agreementsData as any) ?? fallbackAgreements;
  // Read from the live list so saved terms and regenerated text show without reopening the viewer.
  const selectedAgreement = agreements.find((a) => a._id === selectedAgreementId) ?? null;
  const contractDialogRef = useDialogFocus<HTMLDivElement>(Boolean(selectedAgreement));
  useEscapeToClose(Boolean(selectedAgreement), () => setSelectedAgreementId(null));

  const executeAgreementMutation = useMutation(api.agreements.executeAgreement);
  const voidExecutedAgreementMutation = useMutation(api.agreements.voidExecutedAgreement);

  const handleExecute = async (agreementId: string) => {
    setAgreementToExecute(agreementId);
  };

  const confirmExecute = async () => {
    if (!agreementToExecute) return;
    // A12-06: rethrow so the refusal renders inline in the confirm dialog.
    if (onExecuteAgreement) {
      await onExecuteAgreement(agreementToExecute);
    } else {
      await executeAgreementMutation({ agreementId: agreementToExecute as any });
    }
    setAgreementToExecute(null);
  };

  const handleCopyText = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

const handleDownload = (agr: Agreement) => {
  const blob = new Blob([agr.contractText], { type: "text/plain;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `${agr.agreementNumber}_AIA-style_Subcontract_Draft.txt`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/**
 * A12-04/A13-04: print the contract in an isolated document (see lib/printContract).
 */
const handlePrint = (agr: Agreement) => {
  printContractText(agr.agreementNumber, agr.contractText);
};

  const activeAgreements = agreements.filter((a) => a.status !== "superseded");

  const filteredAgreements = agreements.filter((agr) => {
    const matchesSearch =
      agr.agreementNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      agr.subcontractorName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      agr.tradeName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      agr.csiDivision.includes(searchTerm);

    const matchesStatus =
      statusFilter === "all"
        ? agr.status !== "superseded"
        : statusFilter === "superseded"
        ? agr.status === "superseded"
        : agr.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const totalContractedSum = activeAgreements.reduce((sum, a) => sum + (a.contractSum || 0), 0);
  const executedCount = agreements.filter((a) => a.status === "executed").length;
  const supersededCount = agreements.filter((a) => a.status === "superseded").length;

  if (!currentProject) {
    return (
      <div className="p-12 text-center bg-slate-900 border border-slate-800 rounded-xl">
        <p className="text-slate-400 text-sm">Please select a commercial construction project to view contracts.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-xs font-bold px-2 py-0.5 bg-emerald-950 text-emerald-400 border border-emerald-800 rounded">
                AIA-style Subcontract Draft
              </span>
              <h2 className="text-lg font-bold text-white tracking-tight">
                Subcontract Agreements Register
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-slate-400">
                Centrally register, review, and record execution status for standard form agreements.
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

          {/* Quick Summary Metrics */}
          <div className="flex items-center gap-3">
            <div className="bg-slate-950 border border-slate-800 px-3.5 py-2 rounded-lg text-right">
              <span className="text-[10px] text-slate-400 block uppercase">Active Contracted Sum</span>
              <span className="text-sm font-bold font-mono text-emerald-400">
                ${totalContractedSum.toLocaleString("en-US")}
              </span>
            </div>

            <div className="bg-slate-950 border border-slate-800 px-3.5 py-2 rounded-lg text-right">
               <span className="text-[10px] text-slate-400 block uppercase">Execution Status Recorded</span>
              <span className="text-sm font-bold font-mono text-white">
                {executedCount} / {activeAgreements.length}
              </span>
            </div>
          </div>
        </div>

        {/* Collapsible Context */}
        {showWhyCare && (
          <div className="mt-3 pt-3 border-t border-slate-800 text-xs text-slate-300 leading-relaxed bg-slate-950/60 rounded-lg p-3 border animate-in fade-in">
            <span className="font-semibold text-emerald-400">Legal Safeguard: </span>
            Manual subcontract generation takes 2 to 3 weeks of administrative delay, risking jobsite mobilization and material escalation costs. TradePulse Pay instantly generates standardized, 10-article <strong className="text-emerald-300 font-semibold">AIA-style subcontract drafts</strong> populated with the awarded contract sum, mandatory inclusions and each agreement's own terms (retainage capped by the project's state, payment terms, liquidated damages, insurance limits, warranty and governing state). The GC edits the terms until execution; after execution they are locked.
          </div>
        )}
      </div>

      {/* Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/60 p-3 rounded-xl border border-slate-800">
        <div className="flex items-center gap-2 flex-1 min-w-[240px]">
          <div className="relative w-full max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5 pointer-events-none" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search by agreement #, subcontractor, trade, or CSI division..."
              className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-400 mr-1">Status:</span>
          {[
            { id: "all", label: "Active Contracts" },
             { id: "executed", label: "Execution Status Recorded" },
            { id: "generated", label: "Pending Execution" },
            ...(supersededCount > 0 ? [{ id: "superseded", label: `Superseded (${supersededCount})` }] : []),
          ].map((st) => (
            <button
              key={st.id}
              onClick={() => setStatusFilter(st.id)}
              className={`text-xs px-3 py-1.5 rounded-lg font-medium transition ${
                statusFilter === st.id
                  ? "bg-emerald-700 text-white font-semibold"
                  : "bg-slate-800 text-slate-400 hover:text-white"
              }`}
            >
              {st.label}
            </button>
          ))}
        </div>
      </div>

      {/* Contracts Table */}
      {filteredAgreements.length === 0 ? (
        <div className="p-12 text-center bg-slate-900 border border-slate-800 rounded-xl space-y-3">
          <FileText className="w-10 h-10 text-slate-600 mx-auto" />
          <h3 className="text-base font-bold text-white">No Subcontract Agreements Found</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            {agreements.length === 0
              ? "When you award a leveled bid in the Bid Leveling Matrix, TradePulse Pay automatically generates an AIA-style subcontract draft for external execution."
              : "No agreements match your search criteria."}
          </p>
          {onNavigateToLeveling && agreements.length === 0 && (
            <button
              onClick={onNavigateToLeveling}
              className="mt-2 bg-emerald-700 hover:bg-emerald-700 text-white font-semibold text-xs px-4 py-2 rounded-lg inline-flex items-center gap-1.5 transition"
            >
              <Award className="w-4 h-4" />
              Go to Bid Leveling Matrix to Award Subcontracts
            </button>
          )}
        </div>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950 border-b border-slate-800 text-slate-400 uppercase font-semibold">
                <tr>
                  <th className="px-4 py-3">Agreement No.</th>
                  <th className="px-4 py-3">Subcontractor</th>
                  <th className="px-4 py-3">Trade Scope</th>
                  <th className="px-4 py-3 font-mono">Contract Sum</th>
                  <th className="px-4 py-3">Terms</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {filteredAgreements.map((agr) => (
                  <tr key={agr._id} className="hover:bg-slate-850/50 transition">
                    <td className="px-4 py-3.5 font-mono font-bold text-emerald-400">
                      {agr.agreementNumber}
                    </td>

                    <td className="px-4 py-3.5 font-medium text-white">
                      {agr.subcontractorName}
                      <span className="block text-[11px] text-slate-400 font-mono">
                        {agr.generalContractorName}
                      </span>
                    </td>

                    <td className="px-4 py-3.5 text-slate-300">
                      <span className="font-mono text-[11px] font-bold text-slate-400 mr-1.5">
                        Div {agr.csiDivision}
                      </span>
                      {agr.tradeName}
                    </td>

                    <td className="px-4 py-3.5 font-mono font-bold text-white text-sm">
                      {formatCents(fromDollars(agr.contractSum))}
                    </td>

                    <td className="px-4 py-3.5 text-slate-400 font-mono text-[11px]">
                      <div>Retainage: <strong className="text-slate-200">{agr.retainagePercent}%</strong></div>
                      <div>LDs: <strong className="text-slate-200">{agr.liquidatedDamagesDaily > 0 ? `${formatCents(fromDollars(agr.liquidatedDamagesDaily))}/day` : "None"}</strong></div>
                    </td>

                    <td className="px-4 py-3.5">
                      {agr.status === "executed" ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800">
                           <CheckCircle2 className="w-3 h-3" /> Execution Status Recorded
                        </span>
                      ) : agr.status === "superseded" ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-600">
                          Superseded — read-only
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-950 text-amber-400 border border-amber-800">
                          <Clock className="w-3 h-3" /> Pending Execution
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-3.5 text-right space-x-2 whitespace-nowrap">
                      <button
                        onClick={() => setSelectedAgreementId(agr._id)}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-slate-700 inline-flex items-center gap-1 transition"
                      >
                        <FileText className="w-3.5 h-3.5 text-emerald-400" />
                        Inspect Draft
                      </button>

                      {agr.status === "generated" && (
                        <button
                          onClick={() => handleExecute(agr._id)}
                          className="bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1 transition shadow-sm"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                           Record Execution Status
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Forward Action: Next Pipeline Stage Banner */}
      {onNavigateToAudit && (
        <div className="bg-gradient-to-r from-slate-900 via-slate-850 to-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 shadow-md">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-950/80 border border-emerald-800/60 flex items-center justify-center text-emerald-400">
              <Check className="w-4 h-4" />
            </div>
            <div>
              <div className="text-xs font-bold text-white">
                 Subcontract Agreements In Place ({activeAgreements.length} Active, {executedCount} Execution Statuses Recorded)
              </div>
              <div className="text-[11px] text-slate-400">
                Next Stage: Inspect the immutable reactive audit stream tracking every RFI, bid leveling calculation, and cron audit.
              </div>
            </div>
          </div>
          <button
            onClick={onNavigateToAudit}
            className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-xs py-2 px-4 rounded-lg flex items-center gap-1.5 transition shadow-sm"
          >
            <span>Inspect Live Activity Audit Stream</span>
            <span>➔</span>
          </button>
        </div>
      )}

      {/* Full Agreement Inspection Modal */}
      {selectedAgreement && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelectedAgreementId(null);
          }}
        >
          <div ref={contractDialogRef} className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="contract-viewer-title">
            {/* Modal Header */}
            <div className="p-4 sm:p-5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-950">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-emerald-950/80 border border-emerald-700/60 flex items-center justify-center text-emerald-400">
                  <FileText className="w-5 h-5" />
                </div>
                <div>
                  <h3 id="contract-viewer-title" className="text-sm sm:text-base font-bold text-white flex items-center gap-2">
                    AIA-style Subcontract Draft
                    {selectedAgreement.status === "executed" ? (
                      <span className="text-[10px] font-bold bg-emerald-950 text-emerald-400 border border-emerald-800 px-2 py-0.5 rounded-full">
                         Execution Status Recorded • Signature Verification Required
                      </span>
                    ) : selectedAgreement.status === "superseded" ? (
                      <span className="text-[10px] font-bold bg-slate-800 text-slate-300 border border-slate-600 px-2 py-0.5 rounded-full">
                        Superseded — voided or replaced. This draft is read-only.
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold bg-amber-950 text-amber-400 border border-amber-800 px-2 py-0.5 rounded-full">
                        Generated / Pending Execution
                      </span>
                    )}
                  </h3>
                  <p className="text-xs text-slate-400 font-mono">
                    {selectedAgreement.agreementNumber} • CSI Division {selectedAgreement.csiDivision} ({selectedAgreement.tradeName})
                  </p>
                </div>
              </div>

              {/* Action Toolbar */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleCopyText(selectedAgreement.contractText)}
                  className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs transition flex items-center gap-1"
                  title="Copy contract text to clipboard"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
                </button>

                <button
                  onClick={() => handleDownload(selectedAgreement)}
                  className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs transition flex items-center gap-1"
                  title="Download subcontract agreement text file"
                >
                  <Download className="w-4 h-4 text-sky-400" />
                  <span className="hidden sm:inline">Download</span>
                </button>

                <button
                  onClick={() => handlePrint(selectedAgreement)}
                  className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs transition flex items-center gap-1"
                  title="Print agreement or save as PDF"
                >
                  <Printer className="w-4 h-4 text-emerald-400" />
                  <span className="hidden sm:inline">Print</span>
                </button>

                <button
                  onClick={() => setSelectedAgreementId(null)}
                  aria-label="Close contract viewer"
                  className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-lg transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Document Body */}
            <div className="flex-1 overflow-y-auto p-5 sm:p-8 bg-slate-950 font-mono text-xs text-slate-300 leading-relaxed print:bg-white print:text-black print:p-0">
              <div className="max-w-3xl mx-auto space-y-4">
                <div className="border border-slate-800 bg-slate-900/80 p-4 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs not-italic print:hidden">
                  <div>
                    <span className="text-slate-400 block text-[10px] uppercase">Awarded Subcontractor</span>
                    <span className="font-bold text-white text-sm">{selectedAgreement.subcontractorName}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px] uppercase">Subcontract Sum</span>
                    <span className="font-bold text-emerald-400 text-sm font-mono">
                      {formatCents(fromDollars(selectedAgreement.contractSum))}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px] uppercase">Retainage</span>
                    <span className="font-bold text-slate-300">{selectedAgreement.retainagePercent}%</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px] uppercase">Liquidated Damages</span>
                    <span className="font-bold text-slate-300">{selectedAgreement.liquidatedDamagesDaily > 0 ? `${formatCents(fromDollars(selectedAgreement.liquidatedDamagesDaily))}/day` : "None"}</span>
                  </div>
                </div>

                {selectedAgreement.status === "executed" && (
                  <div className="bg-emerald-950/70 border-2 border-emerald-500/80 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3 text-emerald-300 shadow-inner">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-400 flex items-center justify-center shrink-0">
                        <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                      </div>
                      <div>
                        <div className="font-bold text-xs tracking-wider uppercase text-emerald-300">
                          ✓ Execution recorded in TradePulse for this AIA-style draft
                        </div>
                        <div className="text-[10px] text-emerald-400/80 font-mono">
                          Audit record: {selectedAgreement.agreementNumber}-EXE • External signature verification required
                        </div>
                      </div>
                    </div>
                    <span className="text-[10px] font-mono font-bold px-2 py-0.5 bg-emerald-900/80 border border-emerald-600 rounded text-emerald-200 uppercase tracking-wider">
                        RECORDED • SIGNATURE REQUIRED
                    </span>
                    <button
                      type="button"
                      onClick={() => setAgreementToVoid(selectedAgreement._id)}
                      className="bg-slate-800 hover:bg-rose-950/60 text-slate-300 hover:text-rose-300 border border-slate-700 hover:border-rose-800/70 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg transition"
                      title="Void the recorded execution so the package can be re-awarded (requires an audit reason)"
                    >
                      Void execution record
                    </button>
                  </div>
                )}

                {agreementsData !== undefined && (
                  <div className="font-sans not-italic print:hidden">
                    <AgreementTermsPanel agreementId={selectedAgreement._id} />
                  </div>
                )}

                <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 font-sans print:hidden">Subcontract preview</h4>
                <pre aria-label="Subcontract preview" className="whitespace-pre-wrap font-mono text-xs bg-slate-900 p-6 rounded-xl border border-slate-800/80 leading-relaxed text-slate-200 print:border-none print:p-0 print:text-black">
                  {selectedAgreement.contractText}
                </pre>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-800 bg-slate-900 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="text-slate-400 text-[11px] flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                Generated AIA-style draft — not an AIA form • Prime Project: {selectedAgreement.projectTitle}
              </div>

              <div className="flex items-center gap-2">
                {selectedAgreement.status === "generated" && (
                  <button
                    onClick={() => handleExecute(selectedAgreement._id)}
                    className="bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-xs px-4 py-2 rounded-lg flex items-center gap-1.5 transition shadow-sm"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                     Record External Execution
                  </button>
                )}
                <button
                  onClick={() => setSelectedAgreementId(null)}
                  className="bg-slate-800 hover:bg-slate-750 text-slate-300 text-xs px-4 py-2 rounded-lg transition"
                >
                  Close Viewer
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(agreementToExecute)}
        title="Record external execution?"
        description="This records that external signatures were completed; TradePulse does not provide a signature service."
        confirmLabel="Record execution"
        onCancel={() => setAgreementToExecute(null)}
        onConfirm={confirmExecute}
      />
      <ConfirmDialog
        open={Boolean(agreementToVoid)}
        title="Void the recorded execution?"
        description="This supersedes the executed subcontract record, un-awards the bid, and reopens the package for leveling. Any executed paper contract remains governed by its own terms and requires an external amendment — TradePulse cannot cancel a signed agreement. The void reason is written to the audit stream."
        confirmLabel="Void execution record"
        onCancel={() => setAgreementToVoid(null)}
        onConfirm={async () => {
          const voidedId = agreementToVoid;
          await voidExecutedAgreementMutation({
            agreementId: voidedId as any,
            reason: "Voided in TradePulse to correct a recorded execution; external amendment handled outside the system.",
          });
          setAgreementToVoid(null);
        }}
      />
    </div>
  );
};
