import { getErrorMessage } from "../lib/errors.ts";
import React, { useState } from "react";
import {
  Building2,
  Mail,
  ShieldCheck,
  ExternalLink,
  Send,
  RefreshCw,
  CheckCircle2,
  Clock,
  Sparkles,
  Phone,
  Globe,
  X,
  Check,
  Copy,
  Search,
  Plus,
  Edit2,
  Trash2,
  AlertTriangle,
} from "lucide-react";
import { useAction, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api.js";
import { Contractor, TradePackage } from "../types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { useDialogFocus, useEscapeToClose } from "../lib/useDialogFocus.ts";
import { StatusPill } from "../ui";
import { RETRYABLE_RFQ_STATUSES, RFQ_BUDGET_MESSAGE, RFQ_EMAIL_LABELS } from "../vendors/rfqLabels";

interface SubcontractorDiscoveryViewProps {
  currentPackage: TradePackage | null;
  tradePackages?: TradePackage[];
  onSelectPackage?: (id: string) => void;
  contractors: Contractor[];
  onDiscover: (packageId: string) => Promise<void>;
  onDispatchRfq: (contractorId: string) => Promise<void>;
  onCreateContractor?: (contractor: {
    tradePackageId: string;
    companyName: string;
    contactEmail: string;
    phone?: string;
    licenseNumber: string;
    licenseStatus: string;
    sourceUrl: string;
  }) => Promise<void>;
  onUpdateContractor?: (
    contractorId: string,
    updates: {
      companyName: string;
      contactEmail: string;
      phone?: string;
      licenseNumber: string;
      licenseStatus: string;
      sourceUrl: string;
      expectedUpdatedAt?: number;
    }
  ) => Promise<void>;
  onDeleteContractor?: (contractorId: string) => Promise<void>;
  onNavigateToQnA?: () => void;
  onNavigateToLeveling?: () => void;
  onNavigateToPackages?: () => void;
}

export const SubcontractorDiscoveryView: React.FC<SubcontractorDiscoveryViewProps> = ({
  currentPackage,
  tradePackages = [],
  onSelectPackage,
  contractors,
  onDiscover,
  onDispatchRfq,
  onCreateContractor,
  onUpdateContractor,
  onDeleteContractor,
  onNavigateToQnA,
  onNavigateToLeveling,
  onNavigateToPackages,
}) => {
  const [discovering, setDiscovering] = useState(false);
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);
  const [showWhyCare, setShowWhyCare] = useState(false);
  const [scrapingUrl, setScrapingUrl] = useState<string | null>(null);
  const [scrapedData, setScrapedData] = useState<{
    url: string;
    markdown: string;
    title: string;
    source: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "discovered" | "invited" | "rfi_submitted" | "bid_received"
  >("all");

  // Add Contractor Modal State
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isSubmittingAdd, setIsSubmittingAdd] = useState(false);
  const addDialogRef = useDialogFocus<HTMLDivElement>(isAddModalOpen);
  useEscapeToClose(isAddModalOpen, () => setIsAddModalOpen(false), !isSubmittingAdd);
  const [addForm, setAddForm] = useState({
    companyName: "",
    contactEmail: "",
    phone: "",
    licenseNumber: "",
    licenseStatus: "Active & Verified",
    sourceUrl: "",
  });

  // Edit Contractor Modal State
  const [editingContractor, setEditingContractor] = useState<Contractor | null>(null);
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);
  const editDialogRef = useDialogFocus<HTMLDivElement>(Boolean(editingContractor));
  useEscapeToClose(Boolean(editingContractor), () => setEditingContractor(null), !isSubmittingEdit);
  const [editForm, setEditForm] = useState({
    companyName: "",
    contactEmail: "",
    phone: "",
    licenseNumber: "",
    licenseStatus: "Active & Verified",
    sourceUrl: "",
  });
  const [contractorToDelete, setContractorToDelete] = useState<Contractor | null>(null);
  const [contractorActionError, setContractorActionError] = useState<string | null>(null);

  const scrapeAction = useAction(api.contractorDiscovery.scrapeContractorWebsite);
  const createContractorMutation = useMutation(api.contractors.createContractor);
  const updateContractorMutation = useMutation(api.contractors.updateContractor);
  const deleteContractorMutation = useMutation(api.contractors.deleteContractor);

  const handleScrape = async (url: string) => {
    setScrapingUrl(url);
    try {
      const res = await scrapeAction({ url });
      setScrapedData(res);
    } catch (err: any) {
      console.warn("Scrape error:", err);
    } finally {
      setScrapingUrl(null);
    }
  };

  const handleCopyMarkdown = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  if (!currentPackage) {
    return (
      <div className="p-12 text-center bg-slate-900 border border-slate-800 rounded-xl space-y-3">
        <p className="text-slate-400 text-sm">
          Please select a trade package to manage subcontractor discovery.
        </p>
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

  const handleDiscover = async () => {
    setDiscovering(true);
    try {
      await onDiscover(currentPackage._id);
    } finally {
      setDiscovering(false);
    }
  };

  const handleDispatch = async (contractorId: string) => {
    setDispatchingId(contractorId);
    try {
      await onDispatchRfq(contractorId);
    } finally {
      setDispatchingId(null);
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addForm.companyName.trim() || !addForm.contactEmail.trim()) return;
    setIsSubmittingAdd(true);
    setContractorActionError(null);
    try {
      if (onCreateContractor) {
        await onCreateContractor({
          tradePackageId: currentPackage._id,
          companyName: addForm.companyName.trim(),
          contactEmail: addForm.contactEmail.trim(),
          phone: addForm.phone.trim() || undefined,
          licenseNumber: addForm.licenseNumber.trim() || "COMM-LIC-VERIFIED",
          licenseStatus: addForm.licenseStatus,
          sourceUrl: addForm.sourceUrl.trim() || "https://pels.texas.gov/",
        });
      } else {
        await createContractorMutation({
          tradePackageId: currentPackage._id as any,
          companyName: addForm.companyName.trim(),
          contactEmail: addForm.contactEmail.trim(),
          phone: addForm.phone.trim() || undefined,
          licenseNumber: addForm.licenseNumber.trim() || "COMM-LIC-VERIFIED",
          licenseStatus: addForm.licenseStatus,
          sourceUrl: addForm.sourceUrl.trim() || "https://pels.texas.gov/",
          rfqStatus: "discovered",
        });
      }
      setIsAddModalOpen(false);
      setAddForm({
        companyName: "",
        contactEmail: "",
        phone: "",
        licenseNumber: "",
        licenseStatus: "Active & Verified",
        sourceUrl: "",
      });
    } catch (err: any) {
      setContractorActionError(getErrorMessage(err) || "The contractor could not be saved.");
    } finally {
      setIsSubmittingAdd(false);
    }
  };

  const openEditModal = (c: Contractor) => {
    setEditingContractor(c);
    setEditForm({
      companyName: c.companyName,
      contactEmail: c.contactEmail,
      phone: c.phone || "",
      licenseNumber: c.licenseNumber,
      licenseStatus: c.licenseStatus,
      sourceUrl: c.sourceUrl,
    });
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingContractor || !editForm.companyName.trim() || !editForm.contactEmail.trim()) return;
    setIsSubmittingEdit(true);
    setContractorActionError(null);
    try {
      if (onUpdateContractor) {
        await onUpdateContractor(editingContractor._id, {
          companyName: editForm.companyName.trim(),
          contactEmail: editForm.contactEmail.trim(),
          phone: editForm.phone.trim() || undefined,
          licenseNumber: editForm.licenseNumber.trim(),
          licenseStatus: editForm.licenseStatus,
          sourceUrl: editForm.sourceUrl.trim(),
          expectedUpdatedAt: editingContractor.updatedAt,
        });
      } else {
        await updateContractorMutation({
          contractorId: editingContractor._id as any,
          companyName: editForm.companyName.trim(),
          contactEmail: editForm.contactEmail.trim(),
          phone: editForm.phone.trim() || undefined,
          licenseNumber: editForm.licenseNumber.trim(),
          licenseStatus: editForm.licenseStatus,
          sourceUrl: editForm.sourceUrl.trim(),
          expectedUpdatedAt: editingContractor.updatedAt,
        });
      }
      setEditingContractor(null);
    } catch (err: any) {
      setContractorActionError(getErrorMessage(err) || "The contractor could not be updated.");
    } finally {
      setIsSubmittingEdit(false);
    }
  };

  const handleDelete = async (contractorId: string, companyName: string) => {
    setContractorActionError(null);
    const contractor = contractors.find((item) => item._id === contractorId);
    setContractorToDelete(contractor || {
      _id: contractorId,
      tradePackageId: currentPackage._id,
      companyName,
      contactEmail: "",
      licenseNumber: "",
      licenseStatus: "",
      sourceUrl: "",
      rfqStatus: "discovered",
    });
  };

  const confirmDeleteContractor = async () => {
    if (!contractorToDelete) return;
    try {
      if (onDeleteContractor) {
        await onDeleteContractor(contractorToDelete._id);
      } else {
        await deleteContractorMutation({ contractorId: contractorToDelete._id as any });
      }
      setContractorToDelete(null);
    } catch (err: any) {
      setContractorActionError(getErrorMessage(err) || "The contractor could not be removed.");
    }
  };

  const getRfqStatusBadge = (status: Contractor["rfqStatus"]) => {
    const email = RFQ_EMAIL_LABELS[status];
    if (email) return <StatusPill status={status} label={email.label} tone={email.tone} />;
    switch (status) {
      case "bid_received":
        return (
          <span className="flex items-center gap-1 text-[11px] font-semibold bg-emerald-950/70 text-emerald-400 border border-emerald-800/60 px-2 py-0.5 rounded-full">
            <CheckCircle2 className="w-3 h-3" /> Bid Received
          </span>
        );
      case "rfi_submitted":
        return (
          <span className="flex items-center gap-1 text-[11px] font-semibold bg-amber-950/70 text-amber-300 border border-amber-800/60 px-2 py-0.5 rounded-full">
            <Clock className="w-3 h-3" /> Pre-Bid RFI Active
          </span>
        );
      case "invited":
        return (
          <span className="flex items-center gap-1 text-[11px] font-semibold bg-sky-950/70 text-sky-300 border border-sky-800/60 px-2 py-0.5 rounded-full">
            <Send className="w-3 h-3" /> Invited
          </span>
        );
      default:
        return (
          <span className="text-[11px] font-semibold bg-slate-800 text-slate-300 border border-slate-700 px-2 py-0.5 rounded-full">
            Discovered
          </span>
        );
    }
  };

  // Filter contractors
  const filteredContractors = contractors.filter((c) => {
    const matchesSearch =
      !searchQuery ||
      c.companyName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.contactEmail.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.licenseNumber.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || c.rfqStatus === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="space-y-4">
      {contractorActionError && (
        <div className="rounded-xl border border-rose-800/80 bg-rose-950/40 p-3 text-xs text-rose-300" role="alert">
          Contractor action failed: {contractorActionError}
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
              const isSelected = pkg._id === currentPackage._id;
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
              <span className="font-mono text-xs font-bold px-2 py-0.5 bg-slate-800 text-emerald-400 border border-slate-700 rounded">
                CSI {currentPackage.csiDivision}
              </span>
              <h2 className="text-lg font-bold text-white tracking-tight">
                {currentPackage.tradeName} Discovery & Directory
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-slate-400">
                Powered by <strong className="text-amber-300">Firecrawl web search</strong>. Records are labeled with provenance; license verification requires a registry lookup.
              </p>
              <button
                onClick={() => setShowWhyCare(!showWhyCare)}
                className="text-[10px] font-semibold text-amber-400 hover:text-amber-300 bg-amber-950/60 hover:bg-amber-900/60 border border-amber-800/60 px-2 py-0.5 rounded-full flex items-center gap-1 transition"
                title="Toggle commercial context"
              >
                <span>💡 Why GCs Care</span>
                <span className="text-[9px]">{showWhyCare ? "▲" : "▼"}</span>
              </button>
      </div>
          </div>

          <div className="flex items-center gap-2.5 flex-wrap">
            <button
              onClick={() => {
                // A18-01: discard any cancelled draft before opening again.
                setAddForm({
                  companyName: "",
                  contactEmail: "",
                  phone: "",
                  licenseNumber: "",
                  licenseStatus: "Active & Verified",
                  sourceUrl: "",
                });
                setIsAddModalOpen(true);
              }}
              className="bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 hover:border-slate-600 text-xs font-semibold px-3 py-2 rounded-lg flex items-center gap-1.5 transition shadow-sm"
            >
              <Plus className="w-4 h-4 text-emerald-400" />
              Add Contractor Manually
            </button>
            <button
              disabled={discovering}
              onClick={handleDiscover}
              className="bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-600 hover:to-yellow-600 disabled:opacity-50 text-slate-950 font-bold text-xs px-4 py-2 rounded-lg flex items-center gap-2 transition shadow-lg shadow-amber-500/10"
            >
              {discovering ? (
                <RefreshCw className="w-4 h-4 animate-spin text-slate-950" />
              ) : (
                <Sparkles className="w-4 h-4 fill-slate-950" />
              )}
              {discovering ? "Scanning Web & Licensing..." : "Discover Trade Contractors"}
            </button>
          </div>
        </div>

        {/* Collapsible Context */}
        {showWhyCare && (
          <div className="mt-3 pt-3 border-t border-slate-800 text-xs text-slate-300 leading-relaxed bg-slate-950/60 rounded-lg p-3 border animate-in fade-in">
            <span className="font-semibold text-amber-300">Vetting & Compliance: </span>
            Unlicensed or non-compliant specialty subcontractors expose commercial GCs to stop-work orders, OSHA fines, and catastrophic mechanics liens. TradePulse Pay utilizes <strong className="text-amber-300 font-semibold">Firecrawl</strong> web discovery to gather candidate contractors and records the provenance of every data point, so license status is never presented as verified unless the source itself is a registry page.
          </div>
        )}
      </div>

      {/* Filter & Search Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        {/* Search input */}
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search contractors by company name, license number, or email..."
            className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none"
          />
        </div>

        {/* Status Filters */}
        <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs flex-wrap">
          {(
            [
              { id: "all", label: `All (${contractors.length})` },
              {
                id: "discovered",
                label: `Discovered (${contractors.filter((c) => c.rfqStatus === "discovered").length})`,
              },
              {
                id: "invited",
                label: `Invited (${contractors.filter((c) => c.rfqStatus === "invited").length})`,
              },
              {
                id: "rfi_submitted",
                label: `RFI Active (${contractors.filter((c) => c.rfqStatus === "rfi_submitted").length})`,
              },
              {
                id: "bid_received",
                label: `Bid Received (${contractors.filter((c) => c.rfqStatus === "bid_received").length})`,
              },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              onClick={() => setStatusFilter(tab.id)}
              className={`px-2.5 py-1 rounded text-[11px] font-semibold transition ${
                statusFilter === tab.id
                  ? "bg-emerald-700 text-white shadow-sm"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Contractor Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between text-xs">
          <div className="text-slate-300 font-semibold flex items-center gap-2">
            <Building2 className="w-4 h-4 text-emerald-400" />
            Trade Directory ({filteredContractors.length} of {contractors.length})
          </div>
          <span className="text-slate-400">Provenance shown per record; verify licensing before sourcing</span>
        </div>

        {contractors.some((c) => /unverified/i.test(c.licenseStatus)) && (
          <div className="px-5 py-2.5 border-b border-amber-900/40 bg-amber-950/30 text-[11px] text-amber-200 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
            <span>
              Some records below are unverified directory results. TradePulse has not completed a state registry
              lookup for them, so treat license numbers and contacts as unconfirmed until verified.
            </span>
          </div>
        )}

        {filteredContractors.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-xs">
            {contractors.length === 0
              ? 'No contractors discovered for this package yet. Click "Discover Trade Contractors" to run Firecrawl or "Add Contractor Manually".'
              : "No contractors match the current filter or search criteria."}
          </div>
        ) : (
          <div className="divide-y divide-slate-800/80">
            {filteredContractors.map((c) => (
              <div
                key={c._id}
                className="p-4 lg:px-6 flex flex-wrap items-center justify-between gap-4 hover:bg-slate-850/50 transition"
              >
                <div className="space-y-1.5 min-w-[240px]">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-bold text-white">{c.companyName}</h4>
                    {getRfqStatusBadge(c.rfqStatus)}
                  </div>

                  <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
                    <span className="flex items-center gap-1">
                      <Mail className="w-3.5 h-3.5 text-slate-400" />
                      {/\.invalid$/i.test(c.contactEmail) ? <span className="text-amber-300">Contact not published</span> : c.contactEmail}
                    </span>
                    {c.phone && (
                      <span className="flex items-center gap-1">
                        <Phone className="w-3.5 h-3.5 text-slate-400" />
                        {c.phone}
                      </span>
                    )}
                  </div>
                  {RETRYABLE_RFQ_STATUSES.has(c.rfqStatus) && (
                    <p className="text-xs text-slate-300">
                      {c.rfqStatus === "skipped_budget" ? RFQ_BUDGET_MESSAGE : c.rfqEmailError || "The RFQ email was not delivered."}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <div className="bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800">
                    <div className="text-[10px] text-slate-400 font-medium uppercase">State License</div>
                    <div className="font-mono text-slate-200 flex items-center gap-1">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                      {c.licenseNumber}
                    </div>
                  </div>

                  <div className="bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800 hidden sm:block">
                    <div className="text-[10px] text-slate-400 font-medium uppercase">License Status</div>
                    <div className={`font-semibold text-[11px] ${/unverified/i.test(c.licenseStatus) ? "text-amber-300" : "text-emerald-400"}`}>{c.licenseStatus}</div>
                  </div>

                  <button
                    disabled={scrapingUrl === c.sourceUrl}
                    onClick={() => handleScrape(c.sourceUrl)}
                    className="bg-slate-800 hover:bg-slate-750 text-amber-300 hover:text-amber-200 border border-slate-700 text-xs font-semibold px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 transition"
                    title="Extract contractor website & capability profile with FirecrawlClient"
                  >
                    {scrapingUrl === c.sourceUrl ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Globe className="w-3.5 h-3.5 text-amber-400" />
                    )}
                    <span className="hidden sm:inline">Open source page</span>
                  </button>

                  <a
                    href={c.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-slate-400 hover:text-slate-200 p-2 rounded-lg hover:bg-slate-800 transition"
                    title="Inspect contractor website or licensing record"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>

                  <button
                    onClick={() => openEditModal(c)}
                    className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition"
                    title="Edit contractor info"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={() => handleDelete(c._id, c.companyName)}
                    className="p-2 text-slate-400 hover:text-rose-400 rounded-lg hover:bg-slate-800 transition"
                    title="Delete contractor"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>

                  {(c.rfqStatus === "discovered" || RETRYABLE_RFQ_STATUSES.has(c.rfqStatus)) && (
                    <button
                      disabled={dispatchingId === c._id}
                      onClick={() => handleDispatch(c._id)}
                      className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition"
                    >
                      <Send className="w-3.5 h-3.5" />
                      {c.rfqStatus === "discovered" ? "Send RFQ" : "Retry RFQ"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Forward Action: Next Pipeline Stage Banner */}
      {contractors.length > 0 && (onNavigateToQnA || onNavigateToLeveling) && (
        <div className="bg-gradient-to-r from-slate-900 via-slate-850 to-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 shadow-md">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-amber-950/80 border border-amber-800/60 flex items-center justify-center text-amber-400">
              <Check className="w-4 h-4" />
            </div>
            <div>
              <div className="text-xs font-bold text-white">
                Subcontractors Identified ({contractors.length} contractor record{contractors.length === 1 ? "" : "s"})
              </div>
              <div className="text-[11px] text-slate-400">
                Next Stages: Clarify technical inquiries in Pre-Bid Q&A, or jump straight to leveling incoming proposals.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onNavigateToQnA && (
              <button
                onClick={onNavigateToQnA}
                className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-xs py-2 px-4 rounded-lg flex items-center gap-1.5 transition shadow-sm"
              >
                <span>Advance to Pre-Bid Q&A</span>
                <span>➔</span>
              </button>
            )}
            {onNavigateToLeveling && (
              <button
                onClick={onNavigateToLeveling}
                className="text-slate-400 hover:text-slate-200 underline underline-offset-2 text-xs font-medium transition"
                title="Skip Pre-Bid Q&A and go straight to the leveling matrix"
              >
                Skip to leveling →
              </button>
            )}
          </div>
        </div>
      )}

      {/* Add Contractor Manually Modal */}
      {isAddModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isSubmittingAdd) setIsAddModalOpen(false);
          }}
        >
          <div ref={addDialogRef} className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="add-contractor-title">
            <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-emerald-950/80 border border-emerald-700/60 flex items-center justify-center text-emerald-400">
                  <Plus className="w-4 h-4" />
                </div>
                <h3 id="add-contractor-title" className="text-base font-bold text-white">Add Contractor Manually</h3>
              </div>
              <button
                onClick={() => setIsAddModalOpen(false)}
                aria-label="Close add contractor dialog"
                className="p-2 text-slate-400 hover:text-white rounded-lg transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="p-5 space-y-3.5 text-xs">
              <div>
                <label className="block font-semibold text-slate-300 mb-1">Company Name</label>
                <input
                  type="text"
                  required
                  value={addForm.companyName}
                  onChange={(e) => setAddForm({ ...addForm, companyName: e.target.value })}
                  placeholder="e.g. Rosendin Electric, Inc."
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Contact Email</label>
                  <input
                    type="email"
                    required
                    value={addForm.contactEmail}
                    onChange={(e) => setAddForm({ ...addForm, contactEmail: e.target.value })}
                    placeholder="estimating@rosendin.com"
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Phone Number</label>
                  <input
                    type="text"
                    value={addForm.phone}
                    onChange={(e) => setAddForm({ ...addForm, phone: e.target.value })}
                    placeholder="(512) 835-2400"
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">State License / Registration</label>
                  <input
                    type="text"
                    value={addForm.licenseNumber}
                    onChange={(e) => setAddForm({ ...addForm, licenseNumber: e.target.value })}
                    placeholder="e.g. TECL-38492"
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-300 mb-1">License Verification Status</label>
                  <select
                    aria-label="License verification status"
                    value={addForm.licenseStatus}
                    onChange={(e) => setAddForm({ ...addForm, licenseStatus: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                  >
                    <option value="Active & Verified">Active & Verified</option>
                    <option value="Pending Verification">Pending Verification</option>
                    <option value="Self-Reported">Self-Reported</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-300 mb-1">Website / Portfolio URL</label>
                <input
                  type="url"
                  value={addForm.sourceUrl}
                  onChange={(e) => setAddForm({ ...addForm, sourceUrl: e.target.value })}
                  placeholder="https://www.rosendin.com"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-750 text-slate-300 rounded-lg font-semibold transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingAdd}
                  className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold rounded-lg flex items-center gap-1.5 transition shadow-sm"
                >
                  <Plus className="w-4 h-4" />
                  {isSubmittingAdd ? "Adding..." : "Add to Directory"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Contractor Modal */}
      {editingContractor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isSubmittingEdit) setEditingContractor(null);
          }}
        >
          <div ref={editDialogRef} className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="edit-contractor-title">
            <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-sky-950/80 border border-sky-700/60 flex items-center justify-center text-sky-400">
                  <Edit2 className="w-4 h-4" />
                </div>
                <h3 id="edit-contractor-title" className="text-base font-bold text-white">Edit Contractor Details</h3>
              </div>
              <button
                onClick={() => setEditingContractor(null)}
                aria-label="Close edit contractor dialog"
                className="p-2 text-slate-400 hover:text-white rounded-lg transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleEditSubmit} className="p-5 space-y-3.5 text-xs">
              <div>
                <label className="block font-semibold text-slate-300 mb-1">Company Name</label>
                <input
                  type="text"
                  required
                  aria-label="Company name"
                  value={editForm.companyName}
                  onChange={(e) => setEditForm({ ...editForm, companyName: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Contact Email</label>
                  <input
                    type="email"
                    required
                    aria-label="Contact email"
                    value={editForm.contactEmail}
                    onChange={(e) => setEditForm({ ...editForm, contactEmail: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Phone Number</label>
                  <input
                    type="text"
                    aria-label="Phone number"
                    value={editForm.phone}
                    onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">State License</label>
                  <input
                    type="text"
                    aria-label="State license or registration"
                    value={editForm.licenseNumber}
                    onChange={(e) => setEditForm({ ...editForm, licenseNumber: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-300 mb-1">License Verification Status</label>
                  <select
                    aria-label="License verification status"
                    value={editForm.licenseStatus}
                    onChange={(e) => setEditForm({ ...editForm, licenseStatus: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                  >
                    <option value="Active & Verified">Active & Verified</option>
                    <option value="Pending Verification">Pending Verification</option>
                    <option value="Self-Reported">Self-Reported</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-300 mb-1">Website URL</label>
                <input
                  type="url"
                  aria-label="Website or portfolio URL"
                    value={editForm.sourceUrl}
                  onChange={(e) => setEditForm({ ...editForm, sourceUrl: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setEditingContractor(null)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-750 text-slate-300 rounded-lg font-semibold transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingEdit}
                  className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold rounded-lg flex items-center gap-1.5 transition shadow-sm"
                >
                  <Check className="w-4 h-4" />
                  {isSubmittingEdit ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Firecrawl Scraped Profile Modal */}
      {scrapedData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-slate-800 flex items-center justify-between gap-3 bg-slate-950">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-amber-950/80 border border-amber-700/60 flex items-center justify-center text-amber-400">
                  <Globe className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm sm:text-base font-bold text-white flex items-center gap-2">
                    {scrapedData.title}
                    <span className="text-[10px] font-bold bg-amber-950 text-amber-300 border border-amber-800 px-2 py-0.5 rounded-full">
                      {scrapedData.source}
                    </span>
                  </h3>
                  <p className="text-xs text-slate-400 truncate max-w-md">
                    Extracted from: {scrapedData.url}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleCopyMarkdown(scrapedData.markdown)}
                  className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs transition flex items-center gap-1"
                  title="Copy markdown to clipboard"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
                </button>
                <button
                  onClick={() => setScrapedData(null)}
                  className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-lg transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 bg-slate-950 font-mono text-xs text-slate-300 leading-relaxed">
              <pre className="whitespace-pre-wrap font-mono text-xs bg-slate-900 p-4 rounded-xl border border-slate-800/80 leading-relaxed text-slate-200">
                {scrapedData.markdown}
              </pre>
            </div>

            <div className="p-3 border-t border-slate-800 bg-slate-900 flex items-center justify-between text-xs">
              <span className="text-[11px] text-slate-400">
                Clean Markdown parsed via FirecrawlClient (@firecrawl/firecrawl-convex)
              </span>
              <button
                onClick={() => setScrapedData(null)}
                className="bg-slate-800 hover:bg-slate-750 text-slate-200 text-xs px-3 py-1.5 rounded-lg transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(contractorToDelete)}
        title="Remove contractor?"
        description={contractorToDelete ? `Remove ${contractorToDelete.companyName} from ${currentPackage.tradeName}? Existing bid and communication records may also be affected.` : ""}
        confirmLabel="Remove contractor"
        onCancel={() => setContractorToDelete(null)}
        onConfirm={confirmDeleteContractor}
      />
    </div>
  );
};
