import { getErrorMessage } from "../lib/errors.ts";
import { buildCsv } from "../lib/csv.ts";
import React, { useState, useRef, useEffect } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ShieldAlert,
  Award,
  ChevronDown,
  ChevronUp,
  TrendingDown,
  Download,
  Printer,
  FileText,
  Copy,
  Check,
  X,
  Plus,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Table as TableIcon,
  LayoutGrid,
  FileUp,
  Split,
  Upload,
  Zap,
} from "lucide-react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel";
import { Bid, TradePackage, Agreement, Contractor, ScopeExclusion, ValueEngineeringAlternate } from "../types.ts";
import { extractTextFromPdfStream } from "../lib/documentText.ts";
import { getDeceptiveBidIds, getSuspiciouslyLowBidIds, leadPenaltyArithmetic, leadTargetWeeksFor } from "../leveling.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { ConfirmDialog as UiConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { AWARD_SUM_RULE, LevelingAwardPanel, PLUGS_NOT_INCLUDED } from "../bids/LevelingAwardPanel.tsx";
import { awardConfirmation } from "../bids/awardConfirm.ts";
import { centsToDollarsForDisplay, formatCents, fromDollars, toDollarString } from "../../convex/lib/money.ts";

// The adjustment modal edits dollars in number inputs; blank or invalid input counts as $0.
const LEGACY_ACCEPTED_ALTERNATES: readonly number[] = [];

const inputDollarsToCents = (dollars: number): number =>
  Number.isFinite(dollars) ? fromDollars(dollars) : 0;
import { AgreementTermsPanel } from "../contracts/AgreementTermsPanel.tsx";
import { useDialogFocus, useEscapeToClose } from "../lib/useDialogFocus.ts";
import { printContractText } from "../lib/printContract.ts";

interface BidLevelingMatrixViewProps {
  currentPackage: TradePackage | null;
  tradePackages?: TradePackage[];
  onSelectPackage?: (id: string) => void;
  bids: Bid[];
  onAwardContract: (bidId: string, tradePackageId: string, acceptedAlternateIndexes: number[]) => Promise<void>;
  /** Demo companies only; real companies get no simulation controls or copy. */
  onOpenSimulation?: () => void;
  contractors?: Contractor[];
  onNavigateToCoordination?: () => void;
  agreements?: Agreement[];
  onUpdateAdjustments?: (
    bidId: string,
    exclusions: ScopeExclusion[],
    alternates: ValueEngineeringAlternate[],
    leadPenaltyCents: number,
    coiPenaltyCents: number
  ) => Promise<void>;
  onUnawardContract?: (bidId: string, tradePackageId: string) => Promise<void>;
  onDeleteBid?: (bidId: string, tradePackageId?: string) => Promise<void>;
  onExecuteAgreement?: (agreementId: string) => Promise<void>;
  onIngestQuote?: (data: {
    contractorId: string;
    quoteText: string;
    fileName?: string;
    newContractorName?: string;
  }) => Promise<void>;
  onNavigateToContracts?: () => void;
  onNavigateToPackages?: () => void;
}

export const BidLevelingMatrixView: React.FC<BidLevelingMatrixViewProps> = ({
  currentPackage,
  tradePackages = [],
  onSelectPackage,
  bids,
  contractors = [],
  agreements = [],
  onAwardContract,
  onOpenSimulation,
  onNavigateToCoordination,
  onUpdateAdjustments,
  onUnawardContract,
  onDeleteBid,
  onExecuteAgreement,
  onIngestQuote,
  onNavigateToContracts,
  onNavigateToPackages,
}) => {
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const [expandedBidId, setExpandedBidId] = useState<string | null>(null);
  const [awardingId, setAwardingId] = useState<string | null>(null);
  const [viewingAgreementBidId, setViewingAgreementBidId] = useState<string | null>(null);
  const agreementDialogRef = useDialogFocus<HTMLDivElement>(Boolean(viewingAgreementBidId));
  useEscapeToClose(Boolean(viewingAgreementBidId), () => setViewingAgreementBidId(null));
  const [copied, setCopied] = useState(false);
  const [showWhyCare, setShowWhyCare] = useState(false);

  // Quote Ingestion Modal state
  const [isIngestModalOpen, setIsIngestModalOpen] = useState(false);
  const [ingestContractorId, setIngestContractorId] = useState("");
  const [newContractorName, setNewContractorName] = useState("");
  const [ingestQuoteText, setIngestQuoteText] = useState("");
  const [ingestFileName, setIngestFileName] = useState("");
  const [isIngesting, setIsIngesting] = useState(false);
  const [isModalDraggingOver, setIsModalDraggingOver] = useState(false);
  const [isEmptyDraggingOver, setIsEmptyDraggingOver] = useState(false);
const [scannedPdfWarning, setScannedPdfWarning] = useState<string | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const modalFileInputRef = useRef<HTMLInputElement>(null);
  const ingestDialogRef = useDialogFocus<HTMLDivElement>(isIngestModalOpen);
  // A18-01: opening the ingest modal always starts a clean draft, so a cancelled
  // quote (or one from another package) can never leak into the next ingestion.
  useEffect(() => {
    if (!isIngestModalOpen) return;
    setIngestQuoteText("");
    setIngestFileName("");
    setNewContractorName("");
    setIngestError(null);
    setScannedPdfWarning(null);
    ingestSelectionTouchedRef.current = false;
    setIngestContractorId(contractors.length > 0 ? contractors[0]._id : "");
  }, [isIngestModalOpen]);
  useEscapeToClose(
    isIngestModalOpen,
    () => {
      if (!isIngesting) setIsIngestModalOpen(false);
    },
    !isIngesting
  );
  // A1-01: once a human picks a contractor (or loads a sample), auto-detection
  // must never silently override that choice or overwrite the typed name.
  const ingestSelectionTouchedRef = useRef(false);

  const autoDetectContractorFromText = (text: string, fileName?: string) => {
    if (ingestSelectionTouchedRef.current) return;
    const match = text.match(
      /(?:Subcontractor|Sub-contractor|Sub|Bidder|Vendor|Company|Prepared\s*By|Submitted\s*By|Contractor):\s*([A-Za-z0-9\s&.,'-]+?)(?:\r?\n|$)/i
    );
    let detectedName = match?.[1]?.trim();
    if (!detectedName && fileName) {
      detectedName = fileName.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ").trim();
    }
    // Require a plausible full name; single-keystroke fragments ("A", "Re") must not stick.
    if (detectedName && detectedName.length < 4) return;
    if (detectedName) {
      const existing = contractors.find(
        (c) => c.companyName.toLowerCase() === detectedName!.toLowerCase()
      );
      if (existing) {
        setIngestContractorId(existing._id);
      } else if (!newContractorName.trim()) {
        setIngestContractorId("new_contractor");
        setNewContractorName(detectedName);
      }
    }
  };

  const handleProposalFileDrop = (file: File) => {
    const extension = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
    if (!extension || ![".pdf", ".txt"].includes(extension)) {
      setIngestError("Quote uploads must be PDF or TXT files. Paste proposal text for other source formats.");
      return;
    }
    if (file.size <= 0 || file.size > 50 * 1024 * 1024) {
      setIngestError("Quote files must be greater than zero and no more than 50 MB.");
      return;
    }
    setIngestError(null);
    setIngestFileName(file.name);
    if (extension === ".pdf") {
      file.arrayBuffer().then((buffer) => {
        const extracted = extractTextFromPdfStream(new Uint8Array(buffer));
        if (extracted.startsWith("[PDF_ENCRYPTED]")) {
          setScannedPdfWarning("This PDF is password-protected or encrypted. Please export an unencrypted copy or paste the proposal text below.");
          setIngestQuoteText("");
          autoDetectContractorFromText("", file.name);
        } else if (extracted.startsWith("[PDF_CORRUPTED]")) {
          setScannedPdfWarning("This PDF appears to be corrupted or incomplete. Please check the file or enter quote details manually.");
          setIngestQuoteText("");
          autoDetectContractorFromText("", file.name);
        } else if (extracted.trim().length < 15) {
          setScannedPdfWarning("This PDF appears to be a scanned document or flattened raster image without selectable text streams. Please enter quote details manually or paste the proposal text below.");
          setIngestQuoteText("");
          autoDetectContractorFromText("", file.name);
        } else {
          setScannedPdfWarning(null);
          setIngestQuoteText(extracted);
          autoDetectContractorFromText(extracted, file.name);
        }
      }).catch(() => setScannedPdfWarning("Failed to read the PDF from disk. Please paste the proposal text below."));
      return;
    }
    const isImage = file.type.startsWith("image/") || /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(file.name);
    if (isImage) {
      setScannedPdfWarning(
        "Scanned image detected. Image files do not contain selectable text streams. Please enter quote numbers manually below or paste proposal text."
      );
      setIngestQuoteText("");
      autoDetectContractorFromText("", file.name);
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const rawText = (event.target?.result as string) || "";
      const isPdf = file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf" || rawText.startsWith("%PDF");
      if (isPdf) {
        const extracted = extractTextFromPdfStream(rawText);
        if (extracted.startsWith("[PDF_ENCRYPTED]")) {
          setScannedPdfWarning(
            "This PDF is password-protected or encrypted. Please export an unencrypted copy or paste the proposal text below."
          );
          setIngestQuoteText("");
          autoDetectContractorFromText("", file.name);
        } else if (extracted.startsWith("[PDF_CORRUPTED]")) {
          setScannedPdfWarning(
            "This PDF appears to be corrupted or incomplete. Please check the file or enter quote details manually."
          );
          setIngestQuoteText("");
          autoDetectContractorFromText("", file.name);
        } else if (extracted.trim().length < 15) {
          setScannedPdfWarning(
            "This PDF appears to be a scanned document or flattened raster image without selectable text streams. Please enter quote details manually or paste the proposal text below."
          );
          setIngestQuoteText("");
          autoDetectContractorFromText("", file.name);
        } else {
          setScannedPdfWarning(null);
          setIngestQuoteText(extracted);
          autoDetectContractorFromText(extracted, file.name);
        }
      } else {
        setScannedPdfWarning(null);
        setIngestQuoteText(rawText);
        autoDetectContractorFromText(rawText, file.name);
      }
    };
    reader.onerror = () => {
      setScannedPdfWarning("Failed to read file contents from disk. Please check file permissions or enter quote details manually.");
    };
    reader.readAsText(file);
  };

  // Adjustments Modal state
  const [adjustingBid, setAdjustingBid] = useState<Bid | null>(null);
  const [tempExclusions, setTempExclusions] = useState<ScopeExclusion[]>([]);
  const [tempAlternates, setTempAlternates] = useState<ValueEngineeringAlternate[]>([]);
  const [tempLeadPenalty, setTempLeadPenalty] = useState<number>(0);
  const [tempCoiPenalty, setTempCoiPenalty] = useState<number>(0);
  const [newVeDesc, setNewVeDesc] = useState("");
  const [newVeDeduct, setNewVeDeduct] = useState<number>(15000);
  const [newExcDesc, setNewExcDesc] = useState("");
  const [newExcCost, setNewExcCost] = useState<number>(25000);
  const [isSavingAdjustments, setIsSavingAdjustments] = useState(false);
  const [adjustmentError, setAdjustmentError] = useState<string | null>(null);
  const [bidToDelete, setBidToDelete] = useState<Bid | null>(null);
  const [bidToUnaward, setBidToUnaward] = useState<Bid | null>(null);
  const [bidToAward, setBidToAward] = useState<Bid | null>(null);
  const [agreementToExecute, setAgreementToExecute] = useState<string | null>(null);

  const executeAgreementMutation = useMutation(api.agreements.executeAgreement);
  const updateAdjustmentsMutation = useMutation(api.bids.updateBidAdjustments);
  const unawardContractMutation = useMutation(api.bids.unawardContract);
  const deleteBidMutation = useMutation(api.bids.deleteBid);
  const extractBidAction = useAction(api.files.extractBidFromQuoteFile);

  // Fetch agreement for the active modal bid if any, with standalone fallback
  const agreementData = useQuery(
    api.agreements.getAgreementByBid,
    viewingAgreementBidId && !viewingAgreementBidId.startsWith("bid_") ? { bidId: viewingAgreementBidId as any } : "skip"
  );
  const activeAgreement =
    (agreementData as Agreement | null | undefined) ||
    (viewingAgreementBidId ? agreements.find((a) => a.bidId === viewingAgreementBidId) : undefined);

  if (!currentPackage) {
    return (
      <div className="p-12 text-center bg-slate-900 border border-slate-800 rounded-xl space-y-3">
        <p className="text-slate-400 text-sm">Please select a trade package to inspect the bid leveling matrix.</p>
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

  // Every award goes through the confirmation dialog; nothing awards on a single click.
  const handleAwardAndGenerate = (bidId: string) => {
    setBidToAward(bids.find((bid) => bid._id === bidId) || null);
  };

  // This dialog awards with no bid alternates; accepting alternates happens in the Leveling and award panel.
  const legacyAwardConfirm = bidToAward
    ? awardConfirmation(bidToAward, LEGACY_ACCEPTED_ALTERNATES, { noAlternatesNote: "None (accept alternates in Leveling and award above)" })
    : null;

  const confirmAward = async () => {
    if (!bidToAward) return;
    const bidId = bidToAward._id;
    setAwardingId(bidId);
    try {
      await onAwardContract(bidId, currentPackage._id, [...LEGACY_ACCEPTED_ALTERNATES]);
      setBidToAward(null);
      setViewingAgreementBidId(bidId);
    } finally {
      setAwardingId(null);
    }
  };

  const handleUnaward = async (bidId: string) => {
    setBidToUnaward(bids.find((bid) => bid._id === bidId) || null);
  };

  const confirmUnaward = async () => {
    if (!bidToUnaward) return;
    // A5-02: let the refusal reach ConfirmDialog so it can show the reason inline.
    if (onUnawardContract) {
      await onUnawardContract(bidToUnaward._id, currentPackage._id);
    } else {
      await unawardContractMutation({
        bidId: bidToUnaward._id as any,
        tradePackageId: currentPackage._id as any,
      });
    }
    setBidToUnaward(null);
  };

  const handleDeleteBid = async (bidId: string) => {
    setBidToDelete(bids.find((bid) => bid._id === bidId) || null);
  };

  const confirmDeleteBid = async () => {
    if (!bidToDelete) return;
    // A5-02: surface the refusal inline in the confirmation dialog.
    if (onDeleteBid) {
      await onDeleteBid(bidToDelete._id);
    } else {
      await deleteBidMutation({ bidId: bidToDelete._id as any });
    }
    setBidToDelete(null);
  };

  const handleExecuteAgreement = async (agreementId: string) => {
    setAgreementToExecute(agreementId);
  };

  const confirmExecuteAgreement = async () => {
    if (!agreementToExecute) return;
    try {
      if (onExecuteAgreement) {
        await onExecuteAgreement(agreementToExecute);
      } else {
        await executeAgreementMutation({ agreementId: agreementToExecute as any });
      }
      setAgreementToExecute(null);
    } catch (err: any) {
      console.warn("Execute agreement fallback:", err);
    }
  };

// Executed agreements are immutable server-side (convex/agreements.ts); lock the
  // leveling controls in the UI so users never hit a generic server error.
  const getBidAgreement = (bidId: string) =>
    agreements.find((a) => a.bidId === bidId && a.status !== "superseded");
  const isBidAgreementExecuted = (bidId: string) =>
    getBidAgreement(bidId)?.status === "executed";

  // Open adjustment modal
  const openAdjustmentModal = (bid: Bid) => {
    if (isBidAgreementExecuted(bid._id)) {
      return;
    }
    setAdjustingBid(bid);
    setAdjustmentError(null);
    setTempExclusions([...(bid.identifiedExclusions || [])]);
    setTempAlternates([...(bid.valueEngineeringAlternates || [])]);
    setTempLeadPenalty(centsToDollarsForDisplay(bid.leadTimePenaltyCents));
    setTempCoiPenalty(centsToDollarsForDisplay(bid.coiPenaltyCents));
  };

  const toggleWaiveExclusion = (index: number) => {
    const updated = [...tempExclusions];
    updated[index] = {
      ...updated[index],
      isWaived: !updated[index].isWaived,
    };
    setTempExclusions(updated);
  };

  const toggleAcceptAlternate = (index: number) => {
    const updated = [...tempAlternates];
    updated[index] = {
      ...updated[index],
      isAccepted: !updated[index].isAccepted,
    };
    setTempAlternates(updated);
  };

  const handleAddAlternate = () => {
    if (!newVeDesc.trim()) return;
    setTempAlternates([
      ...tempAlternates,
      {
        description: newVeDesc.trim(),
        costDeductCents: inputDollarsToCents(Number(newVeDeduct)),
        isAccepted: true,
      },
    ]);
    setNewVeDesc("");
    setNewVeDeduct(15000);
  };

  const handleAddExclusion = () => {
    if (!newExcDesc.trim()) return;
    setTempExclusions([
      ...tempExclusions,
      {
        description: newExcDesc.trim(),
        costImpactCents: inputDollarsToCents(Number(newExcCost)),
        severity: "moderate",
        isWaived: false,
      },
    ]);
    setNewExcDesc("");
    setNewExcCost(25000);
  };

  // Calculate live preview of leveled cost (ADR-0003 Formula)
  const calculatePreviewCost = () => {
    if (!adjustingBid) return 0;
    const activeExclusions = tempExclusions.reduce(
      (sum, exc) => (exc.isWaived ? sum : sum + (exc.costImpactCents || 0)),
      0
    );
    const acceptedVeDeduct = tempAlternates.reduce(
      (sum, ve) => (ve.isAccepted ? sum + (ve.costDeductCents || 0) : sum),
      0
    );
    return Math.max(
      0,
      adjustingBid.baseAmountCents +
      activeExclusions +
      inputDollarsToCents(tempLeadPenalty) +
      inputDollarsToCents(tempCoiPenalty) -
      acceptedVeDeduct
    );
  };

  const handleSaveAdjustments = async () => {
    if (!adjustingBid) return;
    setIsSavingAdjustments(true);
    try {
      if (onUpdateAdjustments) {
        await onUpdateAdjustments(
          adjustingBid._id,
          tempExclusions,
          tempAlternates,
          inputDollarsToCents(tempLeadPenalty),
          inputDollarsToCents(tempCoiPenalty)
        );
      } else if (!adjustingBid._id.startsWith("bid_")) {
        await updateAdjustmentsMutation({
          bidId: adjustingBid._id as any,
          identifiedExclusions: tempExclusions,
          valueEngineeringAlternates: tempAlternates,
          leadTimePenaltyCents: inputDollarsToCents(tempLeadPenalty),
          coiPenaltyCents: inputDollarsToCents(tempCoiPenalty),
        });
      }
      setAdjustingBid(null);
      setAdjustmentError(null);
    } catch (err: any) {
      const message = getErrorMessage(err) || "The adjustments could not be saved.";
      console.warn("Save adjustments failed:", err);
      setAdjustmentError(message);
    } finally {
      setIsSavingAdjustments(false);
    }
  };

  // Ingest Direct Quote Action
  const handleIngestQuoteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const effectiveContractorId = ingestContractorId || (contractors.length === 0 ? "new_contractor" : "");
    if (!effectiveContractorId || !ingestQuoteText.trim()) return;
    if (effectiveContractorId === "new_contractor" && !newContractorName.trim()) return;

    setIsIngesting(true);
    setIngestError(null);
    try {
      if (onIngestQuote) {
        await onIngestQuote({
          contractorId: effectiveContractorId,
          quoteText: ingestQuoteText,
          fileName: ingestFileName.trim() || undefined,
          newContractorName:
            effectiveContractorId === "new_contractor" ? newContractorName.trim() || undefined : undefined,
        });
      } else {
        await extractBidAction({
          projectId: currentPackage.projectId as any,
          tradePackageId: currentPackage._id as any,
          contractorId: effectiveContractorId !== "new_contractor" ? (effectiveContractorId as any) : undefined,
          contractorName: effectiveContractorId === "new_contractor" ? newContractorName.trim() : undefined,
          quoteText: ingestQuoteText,
          fileName: ingestFileName.trim() || undefined,
        });
      }
      setIsIngestModalOpen(false);
      setIngestQuoteText("");
      setIngestFileName("");
      setNewContractorName("");
    } catch (err: any) {
      setIngestError(getErrorMessage(err) || "The proposal could not be ingested.");
    } finally {
      setIsIngesting(false);
    }
  };

  const populateSampleQuote = (type: "deceptive" | "clean") => {
    ingestSelectionTouchedRef.current = true;
    setScannedPdfWarning(null);
    const csi = (currentPackage.csiDivision || "").replace(/[^0-9]/g, "");

    if (csi.startsWith("23")) {
      // Division 23 HVAC Mechanical
      if (type === "deceptive") {
        setIngestFileName("Exclusion_Heavy_HVAC_Bid.pdf");
        setIngestQuoteText(`PROPOSAL AND QUOTATION\nProject: Commercial HVAC & Mechanical Scope\nBase Bid Price: $1,320,000.00\nEXCLUSIONS:\n- Crane hoisting & rigging for 350-ton rooftop chillers excluded (GC to furnish crane & street closure permits)\n- Vibration isolation springs & seismic engineering excluded (By others)\n- NEBB certified air balancing and TAB commissioning excluded\n- Overtime and weekend premium hours excluded from base rate\nLead time on chillers: 22 weeks.\nInsurance: Standard statutory limits (Umbrella endorsement fee not included).`);
        setNewContractorName("Breeze Air Mechanical (Low Bidder)");
        setIngestContractorId("new_contractor");
      } else {
        setIngestFileName("Clean_Compliant_HVAC_Proposal.pdf");
        setIngestQuoteText(`PROPOSAL AND QUOTATION\nProject: Commercial HVAC & Mechanical Scope\nBase Bid Price: $1,460,000.00\nSCOPE INCLUSIONS (100% COMPLETE):\n- Crane hoisting, rigging, and street closure permits for all rooftop equipment INCLUDED\n- Seismic engineered vibration isolation springs INCLUDED\n- NEBB certified TAB air balancing & complete DDC controls integration INCLUDED\n- 100% turnkey Division 23 execution with factory certified startup\nLead time: 10 weeks.\nInsurance: Fully compliant ACORD 25 with $5M Umbrella.`);
        setNewContractorName("Apex Mechanical & Thermal Systems (Full Scope)");
        setIngestContractorId("new_contractor");
      }
    } else if (csi.startsWith("22")) {
      // Division 22 Plumbing
      if (type === "deceptive") {
        setIngestFileName("Exclusion_Heavy_Plumbing_Bid.pdf");
        setIngestQuoteText(`PROPOSAL AND QUOTATION\nProject: Commercial Plumbing Scope\nBase Bid Price: $660,000.00\nEXCLUSIONS:\n- Core drilling through post-tensioned concrete slab excluded (By GC/others)\n- Gas piping from meter manifold to rooftop mechanical equipment excluded\n- Grease interceptor excavation and backfill excluded\nLead time on booster pumps: 16 weeks.\nInsurance: Standard statutory limits (Umbrella endorsement fee not included).`);
        setNewContractorName("QuickFlow Plumbing (Low Bidder)");
        setIngestContractorId("new_contractor");
      } else {
        setIngestFileName("Clean_Compliant_Plumbing_Proposal.pdf");
        setIngestQuoteText(`PROPOSAL AND QUOTATION\nProject: Commercial Plumbing Scope\nBase Bid Price: $740,000.00\nSCOPE INCLUSIONS (100% COMPLETE):\n- Complete sanitary waste, vent, storm drainage, and domestic water distribution INCLUDED\n- Engineered core drilling with GPR concrete scanning INCLUDED\n- Natural gas piping to mechanical equipment and kitchen manifolds INCLUDED\n- Turnkey grease interceptor placement and testing INCLUDED\nLead time: 8 weeks.\nInsurance: Fully compliant ACORD 25 with $5M Umbrella.`);
        setNewContractorName("Falcon Commercial Plumbing Inc. (Full Scope)");
        setIngestContractorId("new_contractor");
      }
    } else if (csi.startsWith("03")) {
      // Division 03 Concrete
      if (type === "deceptive") {
        setIngestFileName("Exclusion_Heavy_Concrete_Bid.pdf");
        setIngestQuoteText(`PROPOSAL AND QUOTATION\nProject: Commercial Structural Concrete Scope\nBase Bid Price: $1,890,000.00\nEXCLUSIONS:\n- Concrete pump truck hoisting and staging excluded (GC to furnish pump)\n- Winter weather heating, blankets, and curing accelerators excluded\n- Vapor retarder barrier membrane under slab on grade excluded (By GC)\nLead time on post-tensioning steel: 14 weeks.\nInsurance: Standard statutory limits (Umbrella endorsement fee not included).`);
        setNewContractorName("Rapid Pour Concrete (Low Bidder)");
        setIngestContractorId("new_contractor");
      } else {
        setIngestFileName("Clean_Compliant_Concrete_Proposal.pdf");
        setIngestQuoteText(`PROPOSAL AND QUOTATION\nProject: Commercial Structural Concrete Scope\nBase Bid Price: $2,180,000.00\nSCOPE INCLUSIONS (100% COMPLETE):\n- Turnkey structural formwork, shoring, and stripping INCLUDED\n- Grade 60 deformed rebar reinforcing and post-tensioning tendons INCLUDED\n- Concrete pumping, laser screed placement, and hard trowel finishing INCLUDED\n- ASTM 15-mil vapor retarder membrane and taped penetrations INCLUDED\nLead time: 6 weeks.\nInsurance: Fully compliant ACORD 25 with $5M Umbrella.`);
        setNewContractorName("Keystone Concrete Contractors (Full Scope)");
        setIngestContractorId("new_contractor");
      }
    } else {
      // Division 26 Electrical or Default
      if (type === "deceptive") {
        setIngestFileName("Exclusion_Heavy_Electrical_Bid.pdf");
        setIngestQuoteText(`PROPOSAL AND QUOTATION\nProject: Commercial MEP\nBase Bid Price: $1,080,000.00\nEXCLUSIONS:\n- Crane hoisting & rigging to penthouse mechanical floor excluded (GC to furnish)\n- UL 1479 firestop floor penetrations excluded (By drywall trade)\n- Seismic engineered structural bracing excluded (By others)\n- Overtime/weekend acceleration excluded from base rate\nLead time on switchgear: 16 weeks.\nInsurance: Standard statutory limits (Umbrella endorsement fee not included).`);
        setNewContractorName("Apex Electric (Low Bidder)");
        setIngestContractorId("new_contractor");
      } else {
        setIngestFileName("Clean_Compliant_Electrical_Proposal.pdf");
        setIngestQuoteText(`PROPOSAL AND QUOTATION\nProject: Commercial MEP\nBase Bid Price: $1,210,000.00\nSCOPE INCLUSIONS (100% COMPLETE):\n- Crane hoisting to penthouse switchgear room INCLUDED\n- UL 1479 rated firestop penetrations INCLUDED\n- Seismic bracing engineering INCLUDED\n- 400A temporary power distribution INCLUDED\nLead time: 10 weeks.\nInsurance: Fully compliant ACORD 25 with $5M Umbrella.`);
        setNewContractorName("Beacon Power Systems (Full Scope)");
        setIngestContractorId("new_contractor");
      }
    }
  };

  // 1-Click CSV Leveling Export
  const handleExportCsv = () => {
    if (!sortedBids || sortedBids.length === 0) return;

    const headers = [
      "Rank",
      "Subcontractor Name",
      "CSI Division",
      "Trade Package",
      "Submitted Base Bid ($)",
      "Scope Gaps / Exclusions Count",
      "Total Scope Gap Cost ($)",
      "Value Engineering Alternates Count",
      "Accepted VE Deduct ($)",
      "Lead Time (Weeks)",
      "Lead Time Penalty ($)",
      "ACORD 25 COI Status",
      "COI Penalty ($)",
      "True Leveled Total Cost ($)",
      "Cost Variance vs Rank 1 ($)",
      "Subcontract Status",
    ];

    const packageTradeName = currentPackage?.tradeName || "Trade Scope";
    const packageCsiDivision = currentPackage?.csiDivision || "All Divisions";

    const rows = sortedBids.map((bid, index) => {
      const exclusions = bid.identifiedExclusions || [];
      const totalExclusionsCents = exclusions.reduce((s, x) => (x.isWaived ? s : s + (x.costImpactCents || 0)), 0);
      const alternates = bid.valueEngineeringAlternates || [];
      const totalVeDeductCents = alternates.reduce((s, x) => (x.isAccepted ? s + (x.costDeductCents || 0) : s), 0);
      const topCostCents = sortedBids[0]?.leveledTotalCents ?? bid.leveledTotalCents;
      const varianceCents = index === 0 ? 0 : bid.leveledTotalCents - topCostCents;
      return [
        `#${index + 1}`,
        bid.subcontractorName || "",
        packageCsiDivision,
        packageTradeName,
        toDollarString(bid.baseAmountCents),
        exclusions.length,
        toDollarString(totalExclusionsCents),
        alternates.length,
        toDollarString(totalVeDeductCents),
        bid.longLeadEquipmentWeeks,
        toDollarString(bid.leadTimePenaltyCents),
        bid.coiComplianceStatus,
        toDollarString(bid.coiPenaltyCents),
        toDollarString(bid.leveledTotalCents),
        toDollarString(varianceCents),
        bid.isAwarded ? "AWARDED" : "UNAWARDED",
      ];
    });

    const csvContent = buildCsv(headers, rows);
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    const csiSlug = packageCsiDivision.replace(/[^a-zA-Z0-9]/g, "") || "Leveling";
    link.setAttribute(
      "download",
      `TradePulse_Bid_Leveling_CSI_${csiSlug}_${new Date().toISOString().slice(0, 10)}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleCopyText = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleDownloadAgreement = (agreement: Agreement) => {
    const blob = new Blob([agreement.contractText], { type: "text/plain;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `${agreement.agreementNumber}_AIA-style_Subcontract_Draft.txt`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handlePrintAgreement = (agreement?: Agreement | null) => {
    if (agreement) printContractText(agreement.agreementNumber, agreement.contractText);
  };

  // Sort bids by leveled total cost ascending (lowest normalized cost first)
  const sortedBids = [...bids].sort((a, b) => a.leveledTotalCents - b.leveledTotalCents);
  const rank1Cost = sortedBids[0]?.leveledTotalCents ?? 0;

  // Is the apparent low (lowest base) different from the leveled low?
  const lowestBaseBid = bids.reduce<Bid | null>(
    (min, b) => (!min || b.baseAmountCents < min.baseAmountCents ? b : min),
    null
  );
  const lowestLeveledBid = sortedBids[0] || null;
const deceptiveBidIds = getDeceptiveBidIds(bids);
  const isDeceptiveGap = Boolean(lowestBaseBid && deceptiveBidIds.has(lowestBaseBid._id));
  const suspiciousLowBidIds = getSuspiciouslyLowBidIds(bids, currentPackage.budgetEstimate);
  const isSuspiciousLowWinner = Boolean(lowestLeveledBid && suspiciousLowBidIds.has(lowestLeveledBid._id));

  const awardedBid = bids.find((b) => b.isAwarded) || null;

  return (
    <div className="space-y-3">
      {/* View Header with Trade Package Switcher */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 sm:p-3.5 shadow-sm space-y-2">
        {/* Trade Package Switcher Ribbon */}
        {tradePackages && tradePackages.length > 1 && onSelectPackage && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1.5 border-b border-slate-800">
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
                  <span className={`text-[10px] px-1.5 py-0.2 rounded font-mono ${
                    pkg.status === "awarded"
                      ? "bg-emerald-950 text-emerald-300"
                      : pkg.status === "leveling"
                      ? "bg-amber-950 text-amber-300"
                      : "bg-slate-900 text-slate-400"
                  }`}>
                    {pkg.status === "awarded" ? "Awarded" : pkg.status === "leveling" ? "Leveling" : "Draft"}
                  </span>
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
                Real-Time Bid Leveling Matrix
              </h2>
            </div>
            {currentPackage.dueLabel && (
              <p className="text-xs text-slate-300 mb-1" data-testid="leveling-bid-due">
                {currentPackage.tradeName} bids due {currentPackage.dueLabel}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-slate-400">
                Normalizing contractor quotes to true "apples-to-apples" baselines using the{" "}
                <strong
                  className="text-emerald-300"
                  title="Leveled Cost = Base Bid + scope-gap exclusions + lead-time penalty + COI penalty − accepted value-engineering credits. ADR-0003 is the internal name of this normalization formula."
                >
                  Leveling Formula (ADR-0003: leveled cost = base + scope gaps + lead-time + COI − accepted VE credits)
                </strong>
                .
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

          <div className="flex items-center gap-2.5 flex-wrap">
            {/* View Mode Toggle */}
            <div className="bg-slate-850 p-1 rounded-lg border border-slate-700 flex items-center gap-1">
              <button
                onClick={() => setViewMode("cards")}
                className={`px-2.5 py-1.5 rounded text-xs font-semibold flex items-center gap-1.5 transition ${
                  viewMode === "cards"
                    ? "bg-emerald-700 text-white shadow-sm"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                Card View
              </button>
              <button
                onClick={() => setViewMode("table")}
                className={`px-2.5 py-1.5 rounded text-xs font-semibold flex items-center gap-1.5 transition ${
                  viewMode === "table"
                    ? "bg-emerald-700 text-white shadow-sm"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <TableIcon className="w-3.5 h-3.5" />
                Spread Table View
              </button>
            </div>

            {/* Ingest Quote Modal Trigger */}
            <button
              onClick={() => {
                if (contractors.length > 0 && !ingestContractorId) {
                  setIngestContractorId(contractors[0]._id);
                }
                setIsIngestModalOpen(true);
              }}
              className="bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 hover:border-slate-600 text-xs font-semibold px-3 py-2 rounded-lg flex items-center gap-1.5 transition shadow-sm"
            >
              <FileUp className="w-3.5 h-3.5 text-sky-400" />
              Ingest Quote / PDF
            </button>

            {/* Export CSV Button */}
            <button
              onClick={handleExportCsv}
              disabled={bids.length === 0}
              className="bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 hover:border-slate-600 text-xs font-semibold px-3 py-2 rounded-lg flex items-center gap-1.5 transition shadow-sm disabled:opacity-50"
              title="Export full ADR-0003 leveling matrix to CSV"
            >
              <Download className="w-3.5 h-3.5 text-emerald-400" />
              Export Leveling CSV
            </button>

            {onOpenSimulation && (
            <button
              onClick={onOpenSimulation}
              className="bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-600 hover:to-yellow-600 text-slate-950 font-bold text-xs px-3.5 py-2 rounded-lg flex items-center gap-1.5 transition shadow-sm"
              title="Opens the 60-second demo dock. Scenario B (exclusion-heavy bid) and Scenario C (compliant bid) ingest a simulated proposal for the active package."
            >
              <Zap className="w-3.5 h-3.5 fill-slate-950" />
              Open Demo Simulation…
            </button>
            )}
          </div>
        </div>

        {/* Collapsible Context */}
        {showWhyCare && (
          <div className="mt-3 pt-3 border-t border-slate-800 text-xs text-slate-300 leading-relaxed bg-slate-950/60 rounded-lg p-3 border animate-in fade-in">
            <span className="font-semibold text-emerald-400">The $186,000 Scope Exclusion Trap: </span>
            Subcontractors can submit low base prices on paper but bury exclusions for crane hoisting, UL firestopping, and seismic bracing in proposal fine print. TradePulse Pay's ADR-0003 engine parses proposal exclusions, applies lead-time delay penalties ($6,000/wk schedule-impact rate, distinct from the contract's $1,200/day liquidated damages), adds COI insurance penalties, and subtracts accepted Value Engineering (VE) alternates—to deliver apples-to-apples procurement.
          </div>
        )}
      </div>

      {bids.length > 0 && !currentPackage._id.startsWith("pkg_") && (
        <LevelingAwardPanel tradePackageId={currentPackage._id as Id<"tradePackages">} />
      )}

      {/* Post-Award Celebratory Guidance Banner */}
      {awardedBid && (
        <div className="bg-gradient-to-r from-emerald-950/90 via-slate-900 to-emerald-950/90 border-2 border-emerald-500/60 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 shadow-lg animate-in fade-in">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500 text-slate-950 flex items-center justify-center font-black shadow-md">
              <Award className="w-5 h-5 fill-slate-950" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-white">
                  Subcontract Awarded: <strong className="text-emerald-300">{awardedBid.subcontractorName}</strong>
                </span>
                <span className="text-[10px] font-mono bg-emerald-950 text-emerald-300 border border-emerald-800 px-2 py-0.5 rounded-full font-bold">
                  {formatCents(awardedBid.baseAmountCents)} Base • {formatCents(awardedBid.leveledTotalCents)} Leveled
                </span>
              </div>
              <p className="text-xs text-slate-300 mt-0.5">
                Subcontract agreement drafted with all mandatory inclusions and retainage. Ready for cross-trade clash deduction or execution.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onNavigateToCoordination && (
              <button
                onClick={onNavigateToCoordination}
                className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs py-2 px-3.5 rounded-lg flex items-center gap-1.5 transition shadow-sm"
              >
                <Split className="w-3.5 h-3.5" />
                <span>Check Scope Clashes</span>
                <span>➔</span>
              </button>
            )}
            {onNavigateToContracts && (
              <button
                onClick={onNavigateToContracts}
                className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-xs py-2 px-4 rounded-lg flex items-center gap-1.5 transition shadow-md"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>Inspect Subcontract Draft</span>
                <span>➔</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Out-of-band low bid warning: flagged for verification, not blocked */}
      {isSuspiciousLowWinner && lowestLeveledBid && (
        <div className="bg-gradient-to-r from-rose-950/70 via-slate-900 to-rose-950/70 border border-rose-500/60 rounded-xl p-2.5 sm:px-4 sm:py-2 flex flex-wrap items-center justify-between gap-3 shadow-md animate-in fade-in">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="w-7 h-7 rounded-lg bg-rose-500/20 border border-rose-500/40 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-4 h-4 text-rose-400" />
            </div>
            <div className="text-xs">
              <div className="font-bold text-rose-300 flex items-center gap-2">
                <span>Out-of-Band Low Bid — Verify Before Awarding</span>
                <span className="text-[10px] font-mono bg-rose-500/20 text-rose-300 border border-rose-500/40 px-1.5 py-0.2 rounded font-bold">
                  &lt;50% of package budget
                </span>
              </div>
              <p className="text-slate-300 text-[11px] leading-tight">
                <strong className="text-white">{lowestLeveledBid.subcontractorName}</strong>'s leveled cost of <strong className="text-rose-300">{formatCents(lowestLeveledBid.leveledTotalCents)}</strong> is far below the {formatCents(fromDollars(currentPackage.budgetEstimate))} package budget. This usually means an omitted scope, a unit error, or a mis-read document — confirm the proposal before awarding.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Apparent low vs leveled low banner */}
      {isDeceptiveGap && lowestBaseBid && lowestLeveledBid && (
        <div className="bg-gradient-to-r from-amber-950/70 via-slate-900 to-amber-950/70 border border-amber-500/60 rounded-xl p-2.5 sm:px-4 sm:py-2 flex flex-wrap items-center justify-between gap-3 shadow-md animate-in fade-in">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="w-7 h-7 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
            </div>
            <div className="text-xs">
              <div className="font-bold text-amber-300 flex items-center gap-2">
                <span>Apparent low is not the leveled low</span>
                <span className="text-[10px] font-mono bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1.5 py-0.2 rounded font-bold">
                  +{formatCents(lowestBaseBid.leveledTotalCents - lowestLeveledBid.leveledTotalCents)} leveled difference
                </span>
              </div>
              <p className="text-slate-300 text-[11px] leading-tight">
                <strong className="text-white">{lowestBaseBid.subcontractorName}</strong> ({formatCents(lowestBaseBid.baseAmountCents)} base) has a lower paper price but a higher normalized cost of <strong className="text-amber-400">{formatCents(lowestBaseBid.leveledTotalCents)}</strong> vs <strong className="text-emerald-400">{lowestLeveledBid.subcontractorName} ({formatCents(lowestLeveledBid.leveledTotalCents)})</strong>.
              </p>
            </div>
          </div>

          {!lowestLeveledBid.isAwarded && (
            <button
              disabled={awardingId === lowestLeveledBid._id}
              onClick={() => handleAwardAndGenerate(lowestLeveledBid._id)}
              className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-xs py-1.5 px-3.5 rounded-lg flex items-center justify-center gap-1.5 shadow transition shrink-0 max-w-full cursor-pointer active:scale-95"
              title={`Award the lowest leveled bidder: ${lowestLeveledBid.subcontractorName} (${formatCents(lowestLeveledBid.leveledTotalCents)} leveled)`}
            >
              <Award className="w-3.5 h-3.5 fill-slate-950 shrink-0" />
              <span className="truncate">Award Compliant Winner ({lowestLeveledBid.subcontractorName})</span>
            </button>
          )}
        </div>
      )}

      {/* View Content: Spread Table or Cards */}
      {sortedBids.length === 0 ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsEmptyDraggingOver(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsEmptyDraggingOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsEmptyDraggingOver(false);
            const files = Array.from(e.dataTransfer.files);
            if (files.length > 0) {
              handleProposalFileDrop(files[0]);
              setIsIngestModalOpen(true);
            }
          }}
          className={`border-2 border-dashed rounded-xl p-12 text-center transition-all duration-200 ${
            isEmptyDraggingOver
              ? "border-emerald-400 bg-emerald-950/40 ring-4 ring-emerald-500/20"
              : "bg-slate-900 border-slate-800"
          }`}
        >
          <div className="max-w-md mx-auto space-y-3">
            <div
              className={`w-12 h-12 mx-auto rounded-xl flex items-center justify-center transition ${
                isEmptyDraggingOver ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-800 text-slate-400"
              }`}
            >
              <Upload className={`w-6 h-6 ${isEmptyDraggingOver ? "text-emerald-400 animate-bounce" : ""}`} />
            </div>
            <div>
              <h4 className="text-white text-sm font-bold">
                {isEmptyDraggingOver ? "Drop Quote Proposal to Level Instantly" : "No Proposals Leveled in this Trade Package Yet"}
              </h4>
              <p className="text-slate-400 text-xs mt-1">
                Drag and drop a Subcontractor Quote PDF or text proposal here, or use the direct ingest action to begin ADR-0003 leveling.
              </p>
            </div>
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                onClick={() => {
                  if (contractors.length > 0 && !ingestContractorId) {
                    setIngestContractorId(contractors[0]._id);
                  }
                  setIsIngestModalOpen(true);
                }}
                className="bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-xs px-4 py-2.5 rounded-lg flex items-center gap-1.5 transition shadow-sm"
              >
                <FileUp className="w-4 h-4" />
                Ingest Direct Quote / PDF
              </button>
            </div>
            <p className="text-[11px] text-slate-400 text-center">
              Bids are also ingested by the AI from uploaded quote files on the CSI Scoping tab
              {onOpenSimulation
                ? ", or simulated from the «Open Demo Simulation…» control in the toolbar above (Scenario B or C ingests a proposal)."
                : "."}
            </p>
          </div>
        </div>
      ) : viewMode === "table" ? (
        /* Side-by-Side Spread Table View */
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse min-w-[700px]">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950">
                  <th className="px-3 py-2.5 font-bold text-slate-400 uppercase tracking-wider sticky left-0 bg-slate-950 z-10 w-64 text-[11px]">
                    Forensic Leveling Factor
                  </th>
                  {sortedBids.map((bid, idx) => (
                    <th
                      key={bid._id}
                      className={`px-3 py-2.5 min-w-[240px] font-bold border-l border-slate-800 ${
                        bid.isAwarded
                          ? "bg-emerald-950/40 text-emerald-300"
                          : idx === 0
                          ? "bg-slate-850 text-white"
                          : "text-slate-300"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="font-mono text-xs px-2 py-0.5 bg-slate-800 rounded border border-slate-700">
                          Rank #{idx + 1}
                        </span>
                        {bid.isAwarded ? (
                          <span className="text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-700 px-2 py-0.5 rounded font-bold flex items-center gap-1">
                            <Award className="w-3 h-3" /> AWARDED
                          </span>
                        ) : idx === 0 ? (
                          <span className="text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-800 px-2 py-0.5 rounded font-bold flex items-center gap-1">
                            <TrendingDown className="w-3 h-3" /> Lowest Leveled
                          </span>
                        ) : (
                          <span className="text-[10px] font-mono text-amber-400 font-semibold">
                            +{formatCents(bid.leveledTotalCents - rank1Cost)} vs #1
                          </span>
                        )}
                        {suspiciousLowBidIds.has(bid._id) && (
                          <span
                            className="text-[10px] bg-rose-950 text-rose-300 border border-rose-800 px-2 py-0.5 rounded font-bold flex items-center gap-1"
                            title="Leveled cost is below 50% of the package budget. Verify scope and line items before awarding."
                          >
                            <AlertTriangle className="w-3 h-3" /> VERIFY LOW
                          </span>
                        )}
                      </div>
                      <div className="text-sm font-bold text-white truncate">
                        {bid.subcontractorName}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {/* 1. Base Bid Amount */}
                <tr className="hover:bg-slate-850/40 transition">
                  <td className="px-3 py-2 font-semibold text-slate-300 sticky left-0 bg-slate-900 z-10 text-[11px]">
                    Submitted Base Bid Price
                  </td>
                  {sortedBids.map((bid) => (
                    <td key={bid._id} className="px-3 py-2 font-mono text-slate-200 border-l border-slate-800 text-xs font-semibold">
                      {formatCents(bid.baseAmountCents)}
                    </td>
                  ))}
                </tr>

                {/* 2. Scope Exclusions */}
                <tr className="hover:bg-slate-850/40 transition">
                  <td className="px-3 py-2 font-semibold text-slate-300 sticky left-0 bg-slate-900 z-10 text-[11px]">
                    <div>Scope Gaps & Exclusions</div>
                    <span className="text-[9px] text-slate-400 font-normal block">Cost impacts added to normalize scope</span>
                  </td>
                  {sortedBids.map((bid) => {
                    const exclusions = bid.identifiedExclusions || [];
                    const activeCost = exclusions.reduce((s, x) => (x.isWaived ? s : s + (x.costImpactCents || 0)), 0);
                    return (
                      <td key={bid._id} className="px-3 py-2 border-l border-slate-800 space-y-1 align-top">
                        {exclusions.length === 0 ? (
                          <span className="text-emerald-400 text-[11px] font-semibold flex items-center gap-1">
                            <Check className="w-3 h-3" /> 100% Complete ($0 gaps)
                          </span>
                        ) : (
                          <>
                            <div className="font-mono text-amber-400 font-semibold text-xs">
                              +{formatCents(activeCost)} ({exclusions.filter((x) => !x.isWaived).length} active)
                            </div>
                            <div className="space-y-0.5">
                              {exclusions.map((exc, i) => (
                                <div key={i} className="text-[10px] flex items-center justify-between gap-1 text-slate-400">
                                  <span className={`truncate max-w-[140px] ${exc.isWaived ? "line-through text-slate-600" : ""}`}>
                                    • {exc.description}
                                  </span>
                                  <span className={`shrink-0 font-mono ${exc.isWaived ? "text-slate-600 line-through" : "text-amber-400 font-semibold"}`}>
                                    {exc.isWaived ? "[Waived]" : `+${formatCents(exc.costImpactCents || 0)}`}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>

                {/* 3. Value Engineering Alternates */}
                <tr className="hover:bg-slate-850/40 transition">
                  <td className="px-3 py-2 font-semibold text-slate-300 sticky left-0 bg-slate-900 z-10 text-[11px]">
                    <div>Value Engineering (VE) Alternates</div>
                    <span className="text-[9px] text-slate-400 font-normal block">Accepted deducts reduce leveled total</span>
                  </td>
                  {sortedBids.map((bid) => {
                    const alternates = bid.valueEngineeringAlternates || [];
                    const acceptedDeduct = alternates.reduce((s, x) => (x.isAccepted ? s + (x.costDeductCents || 0) : s), 0);
                    return (
                      <td key={bid._id} className="px-3 py-2 border-l border-slate-800 space-y-1 align-top">
                        {alternates.length === 0 ? (
                          <span className="text-slate-400 text-[10px]">No alternates offered</span>
                        ) : (
                          <>
                            <div className="font-mono text-emerald-400 font-semibold text-xs">
                              -{formatCents(acceptedDeduct)} ({alternates.filter((x) => x.isAccepted).length} accepted)
                            </div>
                            <div className="space-y-0.5">
                              {alternates.map((alt, i) => (
                                <div key={i} className="text-[10px] flex items-center justify-between gap-1 text-slate-400">
                                  <span className={`truncate max-w-[140px] ${!alt.isAccepted ? "line-through text-slate-600" : ""}`}>
                                    • {alt.description}
                                  </span>
                                  <span className={`shrink-0 font-mono font-semibold ${alt.isAccepted ? "text-emerald-400" : "text-slate-600"}`}>
                                    {alt.isAccepted ? `-${formatCents(alt.costDeductCents || 0)}` : `${formatCents(alt.costDeductCents || 0)} (declined)`}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>

                {/* 4. Lead Time Penalty */}
                <tr className="hover:bg-slate-850/40 transition">
                  <td className="px-3 py-2 font-semibold text-slate-300 sticky left-0 bg-slate-900 z-10 text-[11px]">
                    <div>Equipment Lead Time</div>
                    <span className="text-[9px] text-slate-400 font-normal block">Schedule impact / liquidated damages</span>
                  </td>
                  {sortedBids.map((bid) => (
                    <td key={bid._id} className="px-3 py-2 border-l border-slate-800 align-top">
                      <div className="text-slate-200 font-medium text-xs">
                        {bid.longLeadEquipmentWeeks} weeks
                        <span className="text-slate-400 font-normal"> vs {leadTargetWeeksFor(bid, currentPackage?.csiDivision)}-wk baseline</span>
                      </div>
                      <div className={`font-mono text-[10px] font-semibold mt-0.5 ${bid.leadTimePenaltyCents > 0 ? "text-amber-400" : "text-emerald-400"}`}>
                        {bid.leadTimePenaltyCents > 0
                          ? leadPenaltyArithmetic(bid, currentPackage?.csiDivision)
                          : `$0 (${leadPenaltyArithmetic(bid, currentPackage?.csiDivision)})`}
                      </div>
                    </td>
                  ))}
                </tr>

                {/* 5. COI Insurance Penalty */}
                <tr className="hover:bg-slate-850/40 transition">
                  <td className="px-3 py-2 font-semibold text-slate-300 sticky left-0 bg-slate-900 z-10 text-[11px]">
                    <div>ACORD 25 COI Insurance</div>
                    <span className="text-[9px] text-slate-400 font-normal block">Broker endorsement / deficiency buffer</span>
                  </td>
                  {sortedBids.map((bid) => (
                    <td key={bid._id} className="px-3 py-2 border-l border-slate-800 align-top">
                      <div className="text-slate-200 capitalize font-medium text-xs">{bid.coiComplianceStatus}</div>
                      <div className={`font-mono text-[10px] font-semibold mt-0.5 ${bid.coiPenaltyCents > 0 ? "text-rose-400" : "text-emerald-400"}`}>
                        {bid.coiPenaltyCents > 0 ? `+${formatCents(bid.coiPenaltyCents)} penalty` : "$0 (Fully Compliant)"}
                      </div>
                    </td>
                  ))}
                </tr>

                {/* 6. True Leveled Total Cost (ADR-0003) */}
                <tr className="bg-slate-950 font-bold border-t-2 border-slate-700">
                  <td className="px-3 py-2.5 text-emerald-400 sticky left-0 bg-slate-950 z-10 uppercase tracking-wider text-[11px]">
                    True Leveled Total Cost
                  </td>
                  {sortedBids.map((bid, idx) => (
                    <td key={bid._id} className="px-3 py-2.5 border-l border-slate-800 font-mono text-white align-top">
                      <div className={idx === 0 ? "text-emerald-400 font-black text-base sm:text-lg" : "text-white font-black text-base sm:text-lg"}>
                        {formatCents(bid.leveledTotalCents)}
                      </div>
                      <div className="text-[10px] font-normal text-slate-400 mt-0.5">
                        {idx === 0 ? (
                          <span className="text-emerald-400 font-bold flex items-center gap-1">
                            <TrendingDown className="w-3 h-3" /> Lowest Leveled ($0)
                          </span>
                        ) : (
                          <span className="text-amber-400 font-semibold font-mono">
                            +{formatCents(bid.leveledTotalCents - rank1Cost)} vs Rank #1
                          </span>
                        )}
                      </div>
                    </td>
                  ))}
                </tr>

                {/* 7. Action Buttons */}
                <tr className="bg-slate-900/90">
                  <td className="px-3 py-2.5 font-semibold text-slate-400 sticky left-0 bg-slate-900 z-10 text-[11px]">
                    Procurement Actions
                  </td>
                  {sortedBids.map((bid) => (
                    <td key={bid._id} className="px-3 py-2.5 border-l border-slate-800 space-y-1.5 align-top">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <button
                          onClick={() => openAdjustmentModal(bid)}
                          disabled={isBidAgreementExecuted(bid._id)}
                          className="bg-slate-800 hover:bg-slate-750 text-slate-300 text-[10px] font-semibold px-2 py-1 rounded flex items-center gap-1 border border-slate-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
                          title={
                            isBidAgreementExecuted(bid._id)
                              ? "Leveling locked: the subcontract agreement is executed and immutable."
                              : "Adjust Scope Exclusions, VE Alternates, and Penalties"
                          }
                        >
                          <SlidersHorizontal className="w-3 h-3 text-sky-400" />
                          Adjust
                        </button>
                        <button
                          onClick={() => handleDeleteBid(bid._id)}
                          className="bg-slate-800 hover:bg-rose-950/60 text-slate-400 hover:text-rose-300 text-[10px] p-1 rounded border border-slate-700 transition"
                          title="Delete Bid Proposal"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      {bid.isAwarded ? (
                        <div className="space-y-1">
                          <button
                            onClick={() => setViewingAgreementBidId(bid._id)}
                            className="w-full bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 text-[10px] font-semibold py-1 px-2 rounded flex items-center justify-center gap-1 transition"
                          >
                            <FileText className="w-3 h-3 text-emerald-400" />
                            Inspect Draft
                          </button>
                          <button
                            onClick={() => handleUnaward(bid._id)}
                            className="w-full bg-slate-850 hover:bg-rose-950/40 text-slate-400 hover:text-rose-300 border border-slate-800 text-[9px] py-0.5 px-1.5 rounded flex items-center justify-center gap-1 transition"
                          >
                            <Undo2 className="w-3 h-3" />
                            Unaward
                          </button>
                        </div>
                      ) : (
                        <button
                          disabled={awardingId === bid._id}
                          onClick={() => handleAwardAndGenerate(bid._id)}
                          className="w-full bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold text-[10px] py-1.5 px-2 rounded flex items-center justify-center gap-1 transition shadow-sm cursor-pointer active:scale-95"
                        >
                          <Award className="w-3 h-3" />
                          Award & Draft
                        </button>
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* Side-by-Side Leveling Matrix Cards */
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sortedBids.map((bid, index) => {
            const isWinner = index === 0;
            const isExpanded = expandedBidId === bid._id;
            const exclusions = bid.identifiedExclusions || [];
            const activeGapsCost = exclusions.reduce((sum, exc) => (exc.isWaived ? sum : sum + (exc.costImpactCents || 0)), 0);
            const alternates = bid.valueEngineeringAlternates || [];
            const varianceVsRank1 = bid.leveledTotalCents - rank1Cost;

            return (
              <div
                key={bid._id}
                className={`rounded-xl border p-3 sm:p-3.5 flex flex-col justify-between transition ${
                  bid.isAwarded
                    ? "bg-emerald-950/20 border-emerald-500 ring-2 ring-emerald-500/30"
                    : isWinner
                    ? "bg-slate-850/90 border-emerald-500/60 shadow-lg shadow-emerald-950/10"
                    : "bg-slate-900 border-slate-800"
                }`}
              >
                <div>
                  {/* Card Header */}
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono font-bold px-2 py-0.5 bg-slate-800 text-slate-200 rounded border border-slate-700">
                        Rank #{index + 1}
                      </span>
                      {isWinner ? (
                        <span className="text-[11px] font-bold bg-emerald-950 text-emerald-400 border border-emerald-800 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <TrendingDown className="w-3 h-3" /> Best Leveled Value
                        </span>
                      ) : (
                        <span className="text-[11px] font-mono font-bold text-amber-400 bg-amber-950/60 border border-amber-800/80 px-2 py-0.5 rounded-full">
                          +{formatCents(varianceVsRank1)} vs Rank #1
                        </span>
                      )}
                      {suspiciousLowBidIds.has(bid._id) && (
                        <span
                          className="text-[10px] font-bold bg-rose-950 text-rose-300 border border-rose-800 px-2 py-0.5 rounded-full flex items-center gap-1"
                          title="Leveled cost is below 50% of the package budget. Verify scope and line items before awarding."
                        >
                          <AlertTriangle className="w-3 h-3" /> Verify — unusually low
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {bid.isAwarded ? (
                        <span className="text-xs font-bold text-emerald-400 bg-emerald-950 border border-emerald-700 px-2.5 py-1 rounded-lg flex items-center gap-1.5 shadow-sm">
                          <Award className="w-4 h-4" /> Awarded
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-400 font-mono">
                          Received {new Date(bid.receivedAt).toLocaleDateString()}
                        </span>
                      )}
                      <button
                        onClick={() => handleDeleteBid(bid._id)}
                        className="p-1 text-slate-400 hover:text-rose-400 transition"
                        title="Delete proposal"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Subcontractor Name */}
                  <h3 className="text-sm sm:text-base font-bold text-white mb-1.5 flex items-center gap-2 flex-wrap">
                    <span>{bid.subcontractorName?.trim() || "Subcontractor (pending name)"}</span>
                    {typeof bid.revisionNumber === "number" && bid.revisionNumber > 1 && (
                      <span
                        className="text-[9px] font-mono font-bold bg-amber-950/80 text-amber-300 border border-amber-800/60 px-1.5 py-0.5 rounded"
                        title={bid.lastRevisedAt ? `Revised ${new Date(bid.lastRevisedAt).toLocaleString()}` : "Revised proposal"}
                      >
                        Rev {bid.revisionNumber}
                      </span>
                    )}
                    {bid.sourceFileId && (
                      <span
                        className="text-[9px] font-mono bg-sky-950/70 text-sky-300 border border-sky-800/60 px-1.5 py-0.5 rounded"
                        title={`Normalized from project file ${bid.sourceFileId}`}
                      >
                        source file
                      </span>
                    )}
                  </h3>

                  {/* Cost Comparison Summary */}
                  <div className="grid grid-cols-2 gap-2 mb-2 bg-slate-950 p-2 rounded-lg border border-slate-800">
                    <div>
                      <span className="text-[10px] text-slate-400 block mb-0.5 uppercase tracking-wide">Submitted Base Bid</span>
                      <span className="text-sm sm:text-base font-bold text-slate-300 font-mono">
                        {formatCents(bid.baseAmountCents)}
                      </span>
                    </div>

                    <div>
                      <span className="text-[10px] text-emerald-400 font-semibold block mb-0.5 uppercase tracking-wide">
                        True Leveled Cost
                      </span>
                      <span className="text-base sm:text-lg font-black text-white font-mono flex items-center gap-1">
                        {formatCents(bid.leveledTotalCents)}
                      </span>
                    </div>
                  </div>

                  {/* Forensic Normalization Adjustments */}
                  <div className="space-y-1 mb-2 text-xs border-t border-slate-800/80 pt-1.5">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                        Forensic Scope Normalization
                      </span>
                      <button
                        onClick={() => openAdjustmentModal(bid)}
                        disabled={isBidAgreementExecuted(bid._id)}
                        className="text-[10px] text-sky-400 hover:text-sky-300 flex items-center gap-1 transition disabled:text-slate-400 disabled:cursor-not-allowed"
                        title={
                          isBidAgreementExecuted(bid._id)
                            ? "Leveling locked: the subcontract agreement is executed and immutable."
                            : "Adjust Scope Exclusions, VE Alternates, and Penalties"
                        }
                      >
                        <SlidersHorizontal className="w-3 h-3" />
                        {isBidAgreementExecuted(bid._id) ? "Leveling Locked" : "Adjust Leveling"}
                      </button>
                    </div>

                    {/* Identified Exclusions */}
                    <div className="flex items-center justify-between text-slate-300 text-[11px]">
                      <span className="flex items-center gap-1.5 text-slate-400">
                        <AlertTriangle className={`w-3.5 h-3.5 ${exclusions.length > 0 ? "text-amber-400" : "text-emerald-400"}`} />
                        Scope Exclusions ({exclusions.length}):
                      </span>
                      <span className={`font-mono font-semibold ${activeGapsCost > 0 ? "text-amber-400" : "text-emerald-400"}`}>
                        {activeGapsCost > 0 ? `+${formatCents(activeGapsCost)}` : "$0 (Complete)"}
                      </span>
                    </div>

                    {/* Value Engineering Alternates */}
                    {alternates.length > 0 && (
                      <div className="flex items-center justify-between text-slate-300 text-[11px]">
                        <span className="flex items-center gap-1.5 text-slate-400">
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          VE Alternates ({alternates.length}):
                        </span>
                        <span className="font-mono font-semibold text-emerald-400">
                          -{formatCents(alternates.reduce((s, x) => (x.isAccepted ? s + (x.costDeductCents || 0) : s), 0))} (Accepted)
                        </span>
                      </div>
                    )}

                    {/* Lead Time */}
                    <div className="flex items-center justify-between text-slate-300 text-[11px]">
                      <span className="flex items-center gap-1.5 text-slate-400">
                        <Clock className="w-3.5 h-3.5 text-sky-400" />
                        Lead Time ({bid.longLeadEquipmentWeeks} wks vs {leadTargetWeeksFor(bid, currentPackage?.csiDivision)}-wk baseline):
                      </span>
                      <span className={`font-mono font-semibold ${bid.leadTimePenaltyCents > 0 ? "text-amber-400" : "text-emerald-400"}`}>
                        {bid.leadTimePenaltyCents > 0 ? leadPenaltyArithmetic(bid, currentPackage?.csiDivision) : `$0 (${leadPenaltyArithmetic(bid, currentPackage?.csiDivision)})`}
                      </span>
                    </div>

                    {/* COI Compliance */}
                    <div className="flex items-center justify-between text-slate-300 text-[11px]">
                      <span className="flex items-center gap-1.5 text-slate-400">
                        <ShieldAlert className={`w-3.5 h-3.5 ${bid.coiPenaltyCents > 0 ? "text-rose-400" : "text-emerald-400"}`} />
                        ACORD 25 COI:
                      </span>
                      <span className={`font-mono font-semibold ${bid.coiPenaltyCents > 0 ? "text-rose-400" : "text-emerald-400"}`}>
                        {bid.coiPenaltyCents > 0 ? `+${formatCents(bid.coiPenaltyCents)} (Deficient)` : "$0 (Compliant)"}
                      </span>
                    </div>
                  </div>

                  {/* Exclusions Breakdown List */}
                  {exclusions.length > 0 && (
                    <div className="bg-amber-950/20 border border-amber-900/40 rounded-lg p-1.5 mb-1.5 space-y-0.5 text-xs">
                      <span className="font-semibold text-amber-300 text-[10px] uppercase tracking-wide block">
                        Identified Scope Exclusions (Priced into Normalized Total):
                      </span>
                      {exclusions.map((exc, i) => (
                        <div key={i} className="flex items-start justify-between gap-2 text-slate-300 text-[11px]">
                          <span className={`line-clamp-1 ${exc.isWaived ? "line-through text-slate-400" : "text-slate-400"}`}>
                            • {exc.description} {exc.isWaived && <span className="text-emerald-400 ml-1 font-semibold">[Waived by GC]</span>}
                          </span>
                          <span className={`font-mono shrink-0 font-semibold ${exc.isWaived ? "text-slate-400 line-through" : "text-amber-400"}`}>
                            {exc.isWaived ? "$0" : `+${formatCents(exc.costImpactCents || 0)}`}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Value Engineering Alternates Breakdown List */}
                  {alternates.length > 0 && (
                    <div className="bg-emerald-950/20 border border-emerald-900/40 rounded-lg p-1.5 mb-1.5 space-y-0.5 text-xs">
                      <span className="font-semibold text-emerald-300 text-[10px] uppercase tracking-wide block">
                        Value Engineering Alternates:
                      </span>
                      {alternates.map((alt, i) => (
                        <div key={i} className="flex items-start justify-between gap-2 text-slate-300 text-[11px]">
                          <span className={`line-clamp-1 ${!alt.isAccepted ? "line-through text-slate-400" : "text-slate-400"}`}>
                            • {alt.description}
                          </span>
                          <span className={`font-mono shrink-0 font-semibold ${alt.isAccepted ? "text-emerald-400" : "text-slate-400"}`}>
                            {alt.isAccepted ? `-${formatCents(alt.costDeductCents || 0)} (Accepted)` : `${formatCents(alt.costDeductCents || 0)} (Declined)`}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Expandable Line Items */}
                  <button
                    onClick={() => setExpandedBidId(isExpanded ? null : bid._id)}
                    className="w-full text-left text-[11px] font-semibold text-slate-400 hover:text-slate-200 flex items-center justify-between py-1 border-t border-slate-800/80"
                  >
                    <span>Line Item Breakdown ({bid.lineItems?.length || 0} items)</span>
                    {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>

                  {isExpanded && (
                    <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800 mt-1.5 space-y-1.5 text-xs">
                      {(bid.lineItems || []).map((item, i) => (
                        <div key={i} className="flex items-center justify-between text-slate-300 text-[11px]">
                          <span className="truncate max-w-[200px]">{item.item}</span>
                          <span className="font-mono text-slate-400">
                            {item.quantity} {item.unit} @ {formatCents(item.unitCostCents || 0)} = <strong className="text-white">{formatCents(item.totalCostCents || 0)}</strong>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Award Contract or View Agreement Button */}
                <div className="mt-2.5 pt-1.5 border-t border-slate-800/80 flex flex-col gap-1.5">
                  {bid.isAwarded ? (
                    <div className="space-y-1.5">
                      <div className="w-full bg-emerald-950/60 border border-emerald-800 text-emerald-400 font-bold text-xs py-1.5 px-3 rounded-lg flex items-center justify-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4" />
                         <span>Contract Awarded • Draft Generated</span>
                         <span className="text-[10px] font-normal text-emerald-300/80">External signature required</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => setViewingAgreementBidId(bid._id)}
                          className="w-full bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 text-xs font-semibold py-1.5 px-2.5 rounded flex items-center justify-center gap-1 transition"
                        >
                          <FileText className="w-3.5 h-3.5 text-emerald-400" />
                          Inspect Draft
                        </button>
                        <button
                          onClick={() => handleUnaward(bid._id)}
                          className="w-full bg-slate-850 hover:bg-rose-950/40 text-slate-400 hover:text-rose-300 border border-slate-800 text-xs font-semibold py-1.5 px-2.5 rounded flex items-center justify-center gap-1 transition"
                          title="Unaward and return package to leveling"
                        >
                          <Undo2 className="w-3.5 h-3.5" />
                          Unaward
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      disabled={awardingId === bid._id}
                      onClick={() => handleAwardAndGenerate(bid._id)}
                      className="w-full bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold text-xs py-2 px-3 rounded-lg flex items-center justify-center gap-1.5 transition shadow-lg shadow-emerald-950/20 active:scale-95"
                    >
                      <Award className="w-4 h-4" />
                      {awardingId === bid._id
                        ? "Executing Award..."
                        : isWinner
                        ? "🏆 Award Compliant Winner & Draft Subcontract"
                        : "Award Subcontract & Draft Agreement"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Bottom Pipeline Progression Card (Next Stage Handoff) */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4 mt-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-white uppercase tracking-wider">Next Pipeline Steps</span>
            <span className="text-[10px] bg-slate-800 text-slate-300 border border-slate-700 px-2 py-0.5 rounded-full font-mono">
              Stage 04 Handoff
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1 max-w-xl">
            {awardedBid
              ? `Subcontract awarded to ${awardedBid.subcontractorName}. Proceed to cross-trade scope clash detection or inspect the generated AIA-style subcontract draft.`
              : "ADR-0003 leveling normalized base bids against exclusions and penalties. Advance to cross-trade clash coordination or contractual registers."}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {onNavigateToCoordination && (
            <button
              onClick={onNavigateToCoordination}
              className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs py-2 px-3.5 rounded-lg flex items-center gap-1.5 transition shadow-sm"
            >
              <Split className="w-3.5 h-3.5" />
              Advance to Scope Clash Engine ➔
            </button>
          )}
          {onNavigateToContracts && (
            <button
              onClick={onNavigateToContracts}
              className="text-slate-400 hover:text-slate-200 underline underline-offset-2 text-xs font-medium transition"
              title="Skip the Scope Clash stage and go straight to the subcontract register"
            >
              Skip ahead: Contracts Register →
            </button>
          )}
        </div>
      </div>

      {/* Direct Quote / PDF Bid Ingestion Modal */}
      {isIngestModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isIngesting) setIsIngestModalOpen(false);
          }}
        >
          <div
            ref={ingestDialogRef}
            className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ingest-quote-title"
          >
            <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-sky-950/80 border border-sky-700/60 flex items-center justify-center text-sky-400">
                  <FileUp className="w-5 h-5" />
                </div>
                <div>
                  <h3 id="ingest-quote-title" className="text-base font-bold text-white">Direct Quote / PDF Bid Ingestion</h3>
                  <p className="text-xs text-slate-400">
                    Extract proposal line items, exclusions, lead times, and COI limits using AI extraction
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsIngestModalOpen(false)}
                aria-label="Close quote ingestion dialog"
                className="p-2 text-slate-400 hover:text-white rounded-lg transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleIngestQuoteSubmit} className="p-5 space-y-4 text-xs">
              {/* Select Contractor */}
              <div>
                <label className="block font-semibold text-slate-300 mb-1">
                  Subcontractor / Bidder *
                </label>
                {contractors.length > 0 ? (
                  <select
                    id="ingest-contractor-select"
                    name="ingestContractorId"
                    aria-label="Subcontractor or bidder for this proposal"
                    value={ingestContractorId}
                    onChange={(e) => {
                      ingestSelectionTouchedRef.current = true;
                      setIngestContractorId(e.target.value);
                    }}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white font-medium focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                    required={contractors.length > 0 && ingestContractorId !== "new_contractor"}
                  >
                    <option value="">-- Select Registered Contractor --</option>
                    {contractors.map((c) => (
                      <option key={c._id} value={c._id}>
                        {c.companyName} ({c.contactEmail})
                      </option>
                    ))}
                    <option value="new_contractor">+ Enter Custom / New Subcontractor Name</option>
                  </select>
                ) : (
                  <div className="text-[11px] text-amber-400 bg-amber-950/30 border border-amber-800/40 p-2 rounded mb-2">
                    No contractors pre-registered for this package. Enter contractor company name below:
                  </div>
                )}
                {(contractors.length === 0 || ingestContractorId === "new_contractor") && (
                  <input
                    id="ingest-new-contractor-name"
                    name="newContractorName"
                    type="text"
                    value={newContractorName}
                    aria-label="New subcontractor company name"
                    onChange={(e) => setNewContractorName(e.target.value)}
                    placeholder="Enter Subcontractor Company Name (e.g. Apex Mechanical Systems)..."
                    className="w-full mt-2 bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white font-medium focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                    required
                  />
                )}
              </div>

              {/* Quick Proposal File Dropzone / Picker */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsModalDraggingOver(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsModalDraggingOver(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsModalDraggingOver(false);
                  const files = Array.from(e.dataTransfer.files);
                  if (files.length > 0) {
                    handleProposalFileDrop(files[0]);
                  }
                }}
                onClick={() => modalFileInputRef.current?.click()}
                className={`border border-dashed rounded-lg p-3 text-center cursor-pointer transition flex items-center justify-center gap-2.5 ${
                  isModalDraggingOver
                    ? "border-emerald-400 bg-emerald-950/40 text-emerald-300 ring-2 ring-emerald-500/20"
                    : "border-slate-700 bg-slate-950/60 hover:bg-slate-950 text-slate-400 hover:text-slate-300"
                }`}
              >
                <input
                  id="ingest-proposal-file"
                  name="proposalFile"
                  type="file"
                  aria-label="Proposal file (PDF or TXT)"
                  ref={modalFileInputRef}
                  onChange={(e) => {
                    const files = e.target.files;
                    if (files && files.length > 0) {
                      handleProposalFileDrop(files[0]);
                    }
                  }}
                  className="hidden"
                   accept=".pdf,.txt"
                />
                <Upload className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="text-[11px] font-medium">
                  {ingestFileName
                    ? `Loaded Document: ${ingestFileName} (click or drop new file to replace)`
                    : "Drop Subcontractor Quote File here or click to browse (PDF / TXT)"}
                </span>
              </div>

              {/* Sample Shortcuts */}
              <div>
                <span className="block text-slate-400 mb-1.5 font-semibold">Quick Sample Proposals:</span>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => populateSampleQuote("deceptive")}
                    className="bg-amber-950/40 hover:bg-amber-950/80 text-amber-300 border border-amber-800/80 px-2.5 py-1.5 rounded text-[11px] font-semibold transition"
                  >
                    Load exclusion-heavy bid sample
                  </button>
                  <button
                    type="button"
                    onClick={() => populateSampleQuote("clean")}
                    className="bg-emerald-950/40 hover:bg-emerald-950/80 text-emerald-300 border border-emerald-800/80 px-2.5 py-1.5 rounded text-[11px] font-semibold transition"
                  >
                    ✓ Load Clean Compliant Proposal Sample
                  </button>
                </div>
              </div>

              {/* File Name */}
              <div>
                <label className="block font-semibold text-slate-300 mb-1">
                  Document / Proposal Filename (PDF)
                </label>
                <input
                  id="ingest-document-filename"
                  name="ingestFileName"
                  type="text"
                  aria-label="Document or proposal filename"
                  value={ingestFileName}
                  onChange={(e) => setIngestFileName(e.target.value)}
                  placeholder="e.g. Acme_Electrical_Final_Bid_Revision_2.pdf"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              {/* Scanned / Raster Document Warning Banner */}
              {scannedPdfWarning && (
                <div className="bg-amber-950/40 border border-amber-800/80 rounded-lg p-3 text-amber-300 text-xs flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="font-semibold text-amber-200">Scanned / Raster Document Notice</p>
                    <p className="text-amber-300/90 mt-0.5">{scannedPdfWarning}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setScannedPdfWarning(null)}
                    className="text-amber-400 hover:text-amber-200 p-0.5"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}
              {ingestError && (
                <div className="rounded-lg border border-rose-800 bg-rose-950/60 p-3 text-xs text-rose-300" role="alert">
                  Bid ingestion failed: {ingestError}
                </div>
              )}

              {/* Quote OCR / Text Content */}
              <div>
                <label className="block font-semibold text-slate-300 mb-1">
                  Proposal OCR Text / Paste Direct Quote
                </label>
                <textarea
                  id="ingest-quote-text"
                  name="ingestQuoteText"
                  rows={6}
                  aria-label="Proposal OCR text or pasted quote"
                  value={ingestQuoteText}
                  onChange={(e) => {
                    const val = e.target.value;
                    setIngestQuoteText(val);
                  }}
                  onBlur={(e) => {
                    // Detect only after the paste/typing settles, and never when a
                    // contractor was explicitly chosen.
                    autoDetectContractorFromText(e.target.value);
                  }}
                  placeholder="Paste raw text or PDF transcript of vendor quote with base price, exclusions, lead time, and insurance details..."
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 font-mono text-slate-200 text-xs focus:ring-1 focus:ring-emerald-500 focus:outline-none leading-relaxed"
                  required
                />
              </div>

              {/* Modal Footer */}
              <div className="pt-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2.5">
                <div className="text-[11px]">
                  {!ingestQuoteText.trim() ? (
                    <span className="text-slate-400">Paste quote text or drop a proposal file above</span>
                  ) : (contractors.length > 0 && !ingestContractorId) ||
                    ((contractors.length === 0 || ingestContractorId === "new_contractor") && !newContractorName.trim()) ? (
                    <span className="text-amber-400 font-medium flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5" /> Please select or enter subcontractor company name
                    </span>
                  ) : (
                    <span className="text-emerald-400 font-medium flex items-center gap-1">
                      <Check className="w-3.5 h-3.5" /> Ready for AI leveling & forensic audit
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsIngestModalOpen(false)}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-750 text-slate-300 rounded-lg font-semibold transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={
                      isIngesting ||
                      !ingestQuoteText.trim() ||
                      (contractors.length > 0 && !ingestContractorId) ||
                      ((contractors.length === 0 || ingestContractorId === "new_contractor") && !newContractorName.trim())
                    }
                    className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold rounded-lg flex items-center gap-1.5 transition shadow-sm"
                  >
                    <FileUp className="w-4 h-4" />
                    {isIngesting ? "Extracting & Normalizing via AI..." : "Extract & Level Bid"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Forensic Bid Leveling Adjustment Modal (ADR-0003) */}
      {adjustingBid && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-emerald-950/80 border border-emerald-700/60 flex items-center justify-center text-emerald-400">
                  <SlidersHorizontal className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">
                    Forensic Leveling Adjustments • {adjustingBid.subcontractorName}
                  </h3>
                  <p className="text-xs text-slate-400">
                    Apply ADR-0003 normalization overrides: waive exclusions, accept VE alternates, or adjust penalties
                  </p>
                </div>
              </div>
              <button
                onClick={() => setAdjustingBid(null)}
                className="p-2 text-slate-400 hover:text-white rounded-lg transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
              {/* Formula & Live Preview Banner */}
              <div className="bg-slate-950 border border-emerald-800/60 rounded-xl p-4">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    ADR-0003 Recalculated Leveled Cost Preview
                  </span>
                  <span className="text-lg font-black text-emerald-400 font-mono">
                    {formatCents(calculatePreviewCost())}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-slate-400 flex items-center gap-1.5 flex-wrap">
                  <span>Base: {formatCents(adjustingBid.baseAmountCents)}</span>
                  <span>+</span>
                  <span className="text-amber-400">
                    Active Gaps: {formatCents(tempExclusions.reduce((s, x) => (x.isWaived ? s : s + (x.costImpactCents || 0)), 0))}
                  </span>
                  <span>+</span>
                  <span className="text-sky-400">Lead: {formatCents(inputDollarsToCents(tempLeadPenalty))}</span>
                  <span>+</span>
                  <span className="text-rose-400">COI: {formatCents(inputDollarsToCents(tempCoiPenalty))}</span>
                  <span>-</span>
                  <span className="text-emerald-400 font-bold">
                    VE Deducts: {formatCents(tempAlternates.reduce((s, x) => (x.isAccepted ? s + (x.costDeductCents || 0) : s), 0))}
                  </span>
                </div>
              </div>

              {/* Scope Exclusions (Waive / Unwaive) */}
              <div>
                <h4 className="font-bold text-white mb-2 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                  Scope Exclusions Management ({tempExclusions.length})
                </h4>
                <p className="text-slate-400 text-[11px] mb-2.5">
                  Waiving an exclusion removes its cost penalty from the leveled total (e.g. if covered under another subcontract).
                </p>
                {tempExclusions.length === 0 ? (
                  <p className="text-slate-400 italic">No exclusions identified for this proposal.</p>
                ) : (
                  <div className="space-y-2">
                    {tempExclusions.map((exc, idx) => (
                      <div
                        key={idx}
                        className={`p-3 rounded-lg border flex items-center justify-between gap-3 transition ${
                          exc.isWaived
                            ? "bg-slate-950/60 border-slate-800 text-slate-400"
                            : "bg-slate-850 border-slate-700 text-slate-200"
                        }`}
                      >
                        <div className="flex-1">
                          <div className={`font-semibold ${exc.isWaived ? "line-through text-slate-400" : "text-white"}`}>
                            {exc.description}
                          </div>
                          <div className="font-mono text-[11px] text-amber-400 mt-0.5">
                            Estimated Scope Gap Impact: +{formatCents(exc.costImpactCents || 0)}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => toggleWaiveExclusion(idx)}
                          className={`px-3 py-1.5 rounded text-xs font-bold transition flex items-center gap-1 ${
                            exc.isWaived
                              ? "bg-emerald-950 text-emerald-400 border border-emerald-800 hover:bg-emerald-900"
                              : "bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-600"
                          }`}
                        >
                          {exc.isWaived ? "✓ Waived ($0 Penalty)" : "Waive Exclusion"}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add Custom Scope Exclusion Form */}
                <div className="mt-3 bg-slate-950 p-3 rounded-xl border border-slate-800 flex items-center gap-2 flex-wrap">
                  <input
                    type="text"
                    value={newExcDesc}
                    onChange={(e) => setNewExcDesc(e.target.value)}
                    placeholder="Add un-captured scope exclusion (e.g. Crane rigging to penthouse excluded)..."
                    className="flex-1 min-w-[200px] bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-white text-xs focus:ring-1 focus:ring-amber-500 focus:outline-none"
                  />
                  <div className="flex items-center gap-1">
                    <span className="text-slate-400 font-mono">+$</span>
                    <input
                      type="number"
                      value={newExcCost}
                      onChange={(e) => setNewExcCost(Number(e.target.value))}
                      className="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-white text-xs font-mono focus:ring-1 focus:ring-amber-500 focus:outline-none"
                      placeholder="Impact $"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleAddExclusion}
                    className="bg-amber-700 hover:bg-amber-600 text-white font-bold px-3 py-1.5 rounded text-xs flex items-center gap-1 transition"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Exclusion
                  </button>
                </div>
              </div>

              {/* Value Engineering Alternates */}
              <div>
                <h4 className="font-bold text-white mb-2 flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  Value Engineering (VE) Alternates ({tempAlternates.length})
                </h4>
                <p className="text-slate-400 text-[11px] mb-2.5">
                  Accepting an alternate deducts its cost savings from the subcontractor's true leveled total.
                </p>
                <div className="space-y-2 mb-3">
                  {tempAlternates.map((alt, idx) => (
                    <div
                      key={idx}
                      className={`p-3 rounded-lg border flex items-center justify-between gap-3 transition ${
                        alt.isAccepted
                          ? "bg-emerald-950/30 border-emerald-700/60 text-emerald-300"
                          : "bg-slate-950 border-slate-800 text-slate-400"
                      }`}
                    >
                      <div className="flex-1">
                        <div className={`font-semibold ${alt.isAccepted ? "text-white" : "line-through text-slate-400"}`}>
                          {alt.description}
                        </div>
                        <div className="font-mono text-[11px] text-emerald-400 mt-0.5">
                          Cost Deduct Savings: -{formatCents(alt.costDeductCents || 0)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleAcceptAlternate(idx)}
                        className={`px-3 py-1.5 rounded text-xs font-bold transition flex items-center gap-1 ${
                          alt.isAccepted
                            ? "bg-emerald-700 text-white hover:bg-emerald-600"
                            : "bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700"
                        }`}
                      >
                        {alt.isAccepted ? "✓ Accepted (-" + formatCents(alt.costDeductCents || 0) + ")" : "Accept Alternate"}
                      </button>
                    </div>
                  ))}
                </div>

                {/* Add Custom VE Alternate Form */}
                <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 flex items-center gap-2 flex-wrap">
                  <input
                    type="text"
                    value={newVeDesc}
                    onChange={(e) => setNewVeDesc(e.target.value)}
                    placeholder="Add new VE alternate proposal (e.g. Alternate luminaire manufacturer package)..."
                    className="flex-1 min-w-[200px] bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-white text-xs focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                  />
                  <div className="flex items-center gap-1">
                    <span className="text-slate-400 font-mono">-$</span>
                    <input
                      type="number"
                      value={newVeDeduct}
                      onChange={(e) => setNewVeDeduct(Number(e.target.value))}
                      className="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-white text-xs font-mono focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                      placeholder="Deduct $"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleAddAlternate}
                    className="bg-emerald-700 hover:bg-emerald-600 text-white font-bold px-3 py-1.5 rounded text-xs flex items-center gap-1 transition"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Alternate
                  </button>
                </div>
              </div>

              {/* Penalty Adjustments */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-slate-800 pt-4">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">
                    Lead Time Schedule Penalty ($)
                  </label>
                  <input
                    type="number"
                    value={tempLeadPenalty}
                    onChange={(e) => setTempLeadPenalty(Number(e.target.value))}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white font-mono text-xs focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                  />
                  <span className="text-[10px] text-slate-400 mt-0.5 block">
                    Liquidated damages buffer for schedule slippage
                  </span>
                </div>

                <div>
                  <label className="block font-semibold text-slate-300 mb-1">
                    ACORD 25 COI Insurance Penalty ($)
                  </label>
                  <input
                    type="number"
                    value={tempCoiPenalty}
                    onChange={(e) => setTempCoiPenalty(Number(e.target.value))}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white font-mono text-xs focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                  />
                  <span className="text-[10px] text-slate-400 mt-0.5 block">
                    Cost buffer to purchase broker umbrella/endorsements
                  </span>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-800 bg-slate-950 flex items-center justify-between gap-3 text-xs">
              <div className="text-slate-400 font-mono text-[11px]">
                {adjustmentError ? (
                  <span className="text-rose-400">{adjustmentError}</span>
                ) : (
                  <>Updated Total: <strong className="text-emerald-400">{formatCents(calculatePreviewCost())}</strong></>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAdjustingBid(null)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-750 text-slate-300 rounded-lg font-semibold transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isSavingAdjustments}
                  onClick={handleSaveAdjustments}
                  className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold rounded-lg flex items-center gap-1.5 transition shadow-sm"
                >
                  <Check className="w-4 h-4" />
                  {isSavingAdjustments ? "Saving Adjustments..." : "Save Leveling Adjustments"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Subcontract agreement viewer modal */}
      {viewingAgreementBidId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setViewingAgreementBidId(null);
          }}
        >
          <div ref={agreementDialogRef} className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="leveling-agreement-title">
            {/* Modal Header */}
            <div className="p-4 sm:p-5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-950">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-emerald-950/80 border border-emerald-700/60 flex items-center justify-center text-emerald-400">
                  <FileText className="w-5 h-5" />
                </div>
                <div>
                  <h3 id="leveling-agreement-title" className="text-sm sm:text-base font-bold text-white flex items-center gap-2">
                    AIA-style Subcontract Draft
                    {activeAgreement?.status === "executed" ? (
                      <span className="text-[10px] font-bold bg-emerald-950 text-emerald-400 border border-emerald-800 px-2 py-0.5 rounded-full">
                        Execution status recorded • external signature required
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold bg-amber-950 text-amber-400 border border-amber-800 px-2 py-0.5 rounded-full">
                        Generated / Pending Execution
                      </span>
                    )}
                  </h3>
                  <p className="text-xs text-slate-400">
                    Generated AIA-style draft — not an AIA form • {activeAgreement?.agreementNumber ?? "Loading..."}
                  </p>
                </div>
              </div>

              {/* Action Toolbar */}
              <div className="flex items-center gap-2">
                {activeAgreement && (
                  <>
                    <button
                      onClick={() => handleCopyText(activeAgreement.contractText)}
                      className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs transition flex items-center gap-1"
                      title="Copy contract text to clipboard"
                    >
                      {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                      <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
                    </button>

                    <button
                      onClick={() => handleDownloadAgreement(activeAgreement)}
                      className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs transition flex items-center gap-1"
                      title="Download subcontract agreement text file"
                    >
                      <Download className="w-4 h-4 text-sky-400" />
                      <span className="hidden sm:inline">Download</span>
                    </button>

                    <button
                      onClick={() => handlePrintAgreement(activeAgreement)}
                      className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs transition flex items-center gap-1"
                      title="Print subcontract agreement or save as PDF"
                    >
                      <Printer className="w-4 h-4 text-emerald-400" />
                      <span className="hidden sm:inline">Print / PDF</span>
                    </button>
                  </>
                )}

                <button
                  onClick={() => setViewingAgreementBidId(null)}
                  aria-label="Close subcontract draft viewer"
                  className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-lg transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Document Body */}
            <div className="flex-1 overflow-y-auto p-5 sm:p-8 bg-slate-950 font-mono text-xs text-slate-300 leading-relaxed print:bg-white print:text-black print:p-0">
              {activeAgreement ? (
                <div className="max-w-3xl mx-auto space-y-4">
                  <div className="border border-slate-800 bg-slate-900/80 p-4 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs not-italic print:hidden">
                    <div>
                      <span className="text-slate-400 block text-[10px] uppercase">Awarded Subcontractor</span>
                      <span className="font-bold text-white text-sm">{activeAgreement.subcontractorName}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[10px] uppercase">Subcontract Sum</span>
                      <span className="font-bold text-emerald-400 text-sm font-mono">
                        ${activeAgreement.contractSum.toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[10px] uppercase">Retainage</span>
                      <span className="font-bold text-slate-300">{activeAgreement.retainagePercent}%</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[10px] uppercase">Liquidated Damages</span>
                      <span className="font-bold text-slate-300">{activeAgreement.liquidatedDamagesDaily > 0 ? `${formatCents(fromDollars(activeAgreement.liquidatedDamagesDaily))}/day` : "None"}</span>
                    </div>
                  </div>

                  {activeAgreement.status === "executed" && (
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
                            Audit record: {activeAgreement.agreementNumber}-EXE • External signature verification required
                          </div>
                        </div>
                      </div>
                      <span className="text-[10px] font-mono font-bold px-2 py-0.5 bg-emerald-900/80 border border-emerald-600 rounded text-emerald-200 uppercase tracking-wider">
                         RECORDED • SIGNATURE REQUIRED
                      </span>
                    </div>
                  )}

                  <div className="font-sans not-italic print:hidden">
                    <AgreementTermsPanel agreementId={activeAgreement._id} />
                  </div>

                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 font-sans print:hidden">Subcontract preview</h4>
                  <pre aria-label="Subcontract preview" className="whitespace-pre-wrap font-mono text-xs bg-slate-900 p-6 rounded-xl border border-slate-800/80 leading-relaxed text-slate-200 print:border-none print:p-0 print:text-black">
                    {activeAgreement.contractText}
                  </pre>
                </div>
              ) : (
                <div className="p-12 text-center text-slate-400 flex items-center justify-center gap-2">
                  <Clock className="w-4 h-4 animate-spin text-emerald-400" />
                  Generating AIA-style Subcontract Draft...
                </div>
              )}
            </div>

            {/* Modal Footer */}
            {activeAgreement && (
              <div className="p-4 border-t border-slate-800 bg-slate-900 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="text-slate-400 text-[11px] flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                  Generated AIA-style draft — not an AIA form • CSI Division {activeAgreement.csiDivision}
                </div>

                <div className="flex items-center gap-2">
                  {activeAgreement.status !== "executed" && (
                    <button
                      onClick={() => handleExecuteAgreement(activeAgreement._id)}
                      className="bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-xs px-4 py-2 rounded-lg flex items-center gap-1.5 transition shadow-sm"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                       Record External Execution
                    </button>
                  )}
                  <button
                    onClick={() => setViewingAgreementBidId(null)}
                    className="bg-slate-800 hover:bg-slate-750 text-slate-300 text-xs px-4 py-2 rounded-lg transition"
                  >
                    Close Viewer
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(bidToDelete)}
        title="Delete proposal?"
        description={bidToDelete ? `Remove ${bidToDelete.subcontractorName}'s proposal from the ${currentPackage?.tradeName || "active"} leveling matrix?` : ""}
        confirmLabel="Delete proposal"
        onCancel={() => setBidToDelete(null)}
        onConfirm={confirmDeleteBid}
      />
      <ConfirmDialog
        open={Boolean(bidToUnaward)}
        title="Unaward proposal?"
        description={bidToUnaward ? `Reopen ${bidToUnaward.subcontractorName}'s package and supersede its active agreement?` : ""}
        confirmLabel="Unaward proposal"
        onCancel={() => setBidToUnaward(null)}
        onConfirm={confirmUnaward}
      />
      <ConfirmDialog
        open={Boolean(agreementToExecute)}
        title="Record external execution?"
        description="This records that external signatures were completed; TradePulse does not provide a signature service."
        confirmLabel="Record execution"
        onCancel={() => setAgreementToExecute(null)}
        onConfirm={confirmExecuteAgreement}
      />
      <UiConfirmDialog
        open={Boolean(bidToAward)}
        title={bidToAward ? `Award to ${bidToAward.subcontractorName}?` : "Award"}
        payee={bidToAward?.subcontractorName}
        payeeLabel="Bidder"
        amountCents={legacyAwardConfirm?.contractSumCents}
        amountLabel="Contract sum"
        details={legacyAwardConfirm?.details}
        effect={
          <>
            {PLUGS_NOT_INCLUDED} {AWARD_SUM_RULE} Awarding generates the subcontract draft and marks the other bidders as
            not awarded.
            {legacyAwardConfirm?.error && (
              <span role="alert" className="mt-2 block text-rose-300">
                {legacyAwardConfirm.error}
              </span>
            )}
          </>
        }
        confirmLabel="Award and generate subcontract"
        onCancel={() => setBidToAward(null)}
        onConfirm={confirmAward}
      />
    </div>
  );
};
