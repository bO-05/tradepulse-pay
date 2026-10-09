export interface Project {
  _id: string;
  title: string;
  location: string;
  projectType: string;
  estBudget: number;
  targetCompletionWeeks: number;
  specDocumentText: string;
  isDemoProject: boolean;
  generalContractorName?: string;
  createdAt: number;
}

export interface TradePackage {
  _id: string;
  projectId: string;
  csiDivision: string;
  tradeName: string;
  budgetEstimate: number;
  agentMailbox: string;
  agentMailboxId: string;
  agentMailboxShared?: boolean;
  scopeSummary: string;
  mandatoryInclusions: string[];
  bidDeadline: string;
  status: "draft" | "rfqs_dispatched" | "leveling" | "awarded";
}

export interface Contractor {
  _id: string;
  tradePackageId: string;
  companyName: string;
  contactEmail: string;
  phone?: string;
  licenseNumber: string;
  licenseStatus: string;
  sourceUrl: string;
  rfqStatus:
    | "discovered"
    | "invited"
    | "rfi_submitted"
    | "bid_received"
    | "sent"
    | "failed"
    | "skipped_budget"
    | "blocked_recipient"
    | "bounced"
    | "replied";
  rfqEmailStatus?: "sent" | "failed" | "skipped_budget" | "blocked_recipient" | "bounced" | "replied" | "not_sent";
  rfqEmailError?: string;
  rfqSentAt?: number;
  dispatchedAt?: number;
  updatedAt?: number;
}

export interface Conversation {
  _id: string;
  tradePackageId: string;
  contractorId: string;
  threadId: string;
  inboundSubject: string;
  inboundQuestion: string;
  autonomousReply: string;
  confidenceScore: number;
  status: "clarified" | "escalated_to_pm" | "rejected" | "pending_analysis" | "failed_analysis" | "autonomous_replied" | string;
  timestamp: number;
  csiDivision?: string;
  tradeName?: string;
  reviewNote?: string;
  analysisError?: string;
  pmCertifiedAt?: number;
  pmCertifiedBy?: string;
}

export interface BidLineItem {
  item: string;
  unit: string;
  quantity: number;
  unitCostCents: number;
  totalCostCents: number;
}

export interface ScopeExclusion {
  description: string;
  costImpactCents: number;
  severity: "critical" | "moderate" | "minor";
  isWaived?: boolean;
  source?: "gc" | "bidder";
}

export interface ValueEngineeringAlternate {
  description: string;
  costDeductCents: number;
  isAccepted: boolean;
}

export interface Bid {
  _id: string;
  tradePackageId: string;
  contractorId: string;
  subcontractorName: string;
  baseAmountCents: number;
  lineItems: BidLineItem[];
  identifiedExclusions: ScopeExclusion[];
  valueEngineeringAlternates?: ValueEngineeringAlternate[];
  longLeadEquipmentWeeks: number;
  leadTimePenaltyCents: number;
  /** GC-owned baseline the penalty was computed against (12 Div 26 / 16 Div 22-23). */
  leadTimeTargetWeeks?: number;
  coiComplianceStatus: "compliant" | "deficiency_detected";
  coiPenaltyCents: number;
  leveledTotalCents: number;
  isAwarded: boolean;
  sourceFileId?: string;
  revisionNumber?: number;
  lastRevisedAt?: number;
  receivedAt: number;
  alternates?: BidAlternate[];
  exclusions?: string[];
  inclusions?: string[];
  unitPrices?: BidUnitPrice[];
  qualifications?: string;
  validUntil?: string;
  source?: BidSource;
  sourceInboundEmailId?: string;
  submittedByName?: string;
  confirmedByName?: string;
  confirmedAt?: number;
}

/** A bidder's priced alternate; a negative amount is a deduct. */
export interface BidAlternate {
  description: string;
  amountCents: number;
}

export interface BidUnitPrice {
  item: string;
  unit: string;
  unitPriceCents: number;
}

export type BidSource = "portal" | "gc_entered" | "email_ai" | "document_ai" | "seed" | "legacy";

export interface Agreement {
  _id: string;
  projectId: string;
  tradePackageId: string;
  bidId: string;
  contractorId: string;
  agreementNumber: string;
  documentTitle: string;
  subcontractorName: string;
  subcontractorEmail?: string;
  generalContractorName: string;
  projectTitle: string;
  projectLocation: string;
  csiDivision: string;
  tradeName: string;
  contractSum: number;
  retainagePercent: number;
  liquidatedDamagesDaily: number;
  scopeSummary: string;
  mandatoryInclusions: string[];
  status: "generated" | "executed" | "superseded";
  contractText: string;
  executedAt?: number;
  createdAt: number;
}

export interface ProjectFile {
  _id: string;
  projectId: string;
  tradePackageId?: string;
  storageId: string;
  fileName: string;
  fileType: "blueprint" | "spec" | "quote_pdf" | "coi_certificate" | "addendum" | string;
  fileSize: number;
  uploadedBy: string;
  uploadedAt: number;
  url?: string | null;
  /** Authenticated download route for uploaded bytes (never a raw storage URL). */
  downloadPath?: string | null;
  textContent?: string;
}

export interface AuditLog {
  _id: string;
  projectId: string;
  tradePackageId?: string;
  eventType: "rfq_dispatched" | "rfi_clarified" | "quote_received" | "bid_leveled" | "contract_awarded" | "file_uploaded" | "compliance_audit" | "cron_executed" | string;
  title: string;
  description: string;
  actor: string;
  timestamp: number;
}

export interface DoubleBuyClash {
  id: string;
  projectId?: string;
  title: string;
  primaryTradeDivision: string;
  primaryTradeName: string;
  primaryCost: number;
  primaryLineItem: string;
  secondaryTradeDivision: string;
  secondaryTradeName: string;
  secondaryCost: number;
  secondaryLineItem: string;
  redundantAmount: number;
  /** Actual amount credited by the persisted clash resolution, when one exists. */
  deductedAmount?: number;
  /** A persisted credit exists but no proposal currently carries it. */
  staleResolution?: boolean;
  description: string;
  status: "detected" | "deducted";
  resolution?: string;
}

export interface ScopeVoidClash {
  id: string;
  projectId?: string;
  title: string;
  omittedByDivisions: string[];
  omittedByTrades: string[];
  division26Exclusion: string;
  division23Exclusion: string;
  estimatedVoidCost: number;
  riskLevel: "critical" | "high";
  description: string;
  status: "open" | "assigned";
  assignedToDivision?: string;
  assignedToTradeName?: string;
}
