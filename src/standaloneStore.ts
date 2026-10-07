import type {
  Project,
  TradePackage,
  Contractor,
  Conversation,
  Bid,
  Agreement,
  ProjectFile,
  AuditLog,
  DoubleBuyClash,
  ScopeVoidClash,
} from "./types.ts";
import { getRealDocumentText } from "../convex/realDocuments.ts";
import { inflate } from "pako";
import { roundDollarsToCents } from "../convex/lib/money.ts";

export interface StandaloneData {
  projects: Project[];
  tradePackages: TradePackage[];
  contractors: Contractor[];
  conversations: Conversation[];
  bids: Bid[];
  agreements: Agreement[];
  projectFiles: ProjectFile[];
  auditLogs: AuditLog[];
  doubleBuys: DoubleBuyClash[];
  scopeVoids: ScopeVoidClash[];
}

const STORAGE_KEY = "tradepulse_standalone_v3";

export function getInitialStandaloneData(): StandaloneData {
  const now = Date.now();
  const projId = "proj_domain_tower_b";
  const elecPkgId = "pkg_elec_26";
  const hvacPkgId = "pkg_hvac_23";
  const plumbPkgId = "pkg_plumb_22";

  const cElec1 = "ctr_elec_01";
  const cElec2 = "ctr_elec_02";
  const cElec3 = "ctr_elec_03";

  const cHvac1 = "ctr_hvac_01";
  const cHvac2 = "ctr_hvac_02";
  const cHvac3 = "ctr_hvac_03";

  const cPlumb1 = "ctr_plumb_01";
  const cPlumb2 = "ctr_plumb_02";

  return {
    projects: [
      {
        _id: projId,
        title: "The Domain Tower B - Commercial MEP",
        location: "Austin, TX",
        projectType: "Class-A Commercial Mixed-Use",
        estBudget: 4250000,
        targetCompletionWeeks: 48,
        specDocumentText: `PROJECT SPECIFICATION SUMMARY
Section 01 00 00 - General Requirements:
All trade subcontractors shall provide continuous jobsite cleanup, hoist their own equipment to designated roof pads, coordinate seismic bracing according to IBC Section 1613, and provide temporary power distribution boards from main utility tie-in.

Section 26 00 00 - Electrical Systems:
Furnish and install 1600A main service switchboard, 480/277V step-down distribution dry transformers, lighting control panels, emergency battery backup inverters, and branch conduit routing. Subcontractor is strictly responsible for crane rigging and hoisting up to 14th-floor penthouse plant room. All firestop floor/wall penetration penetrations must comply with UL 1479.

Section 23 00 00 - HVAC Systems:
Furnish and install 4x packaged rooftop chilled water air handling units (AHU-1 through AHU-4), 110x VAV terminal units with electric reheat coils, galvanized supply/return ductwork, and native BACnet MS/TP integration gateway to base building automation system. Subcontractor is strictly responsible for rooftop crane hoisting and certified TAB balancing.`,
        isDemoProject: true,
        createdAt: now - 86400000 * 3,
      },
    ],
    tradePackages: [
      {
        _id: elecPkgId,
        projectId: projId,
        csiDivision: "26 00 00",
        tradeName: "Electrical & Lighting Systems",
        budgetEstimate: 1250000,
        agentMailbox: "cleverneed464@agentmail.to",
        agentMailboxId: "cleverneed464@agentmail.to",
        scopeSummary: "Complete commercial electrical distribution, 1600A switchgear, penthouse crane hoisting, emergency lighting, and seismic bracing.",
        mandatoryInclusions: [
          "Crane hoisting to 14th-floor mechanical room",
          "Seismic bracing (IBC Section 1613)",
          "Temporary 400A jobsite power distribution",
          "UL 1479 floor/wall firestopping",
        ],
        bidDeadline: "2026-09-25",
        status: "leveling",
      },
      {
        _id: hvacPkgId,
        projectId: projId,
        csiDivision: "23 00 00",
        tradeName: "Heating, Ventilating & Air Conditioning",
        budgetEstimate: 1850000,
        agentMailbox: "dullstreet57@agentmail.to",
        agentMailboxId: "dullstreet57@agentmail.to",
        scopeSummary: "Chilled water air handling units, VAV terminal boxes, rooftop cooling tower connection, and BACnet automated controls.",
        mandatoryInclusions: [
          "Rooftop crane pick and rigging",
          "BACnet MS/TP integration gateway",
          "Vibration isolation spring hangers",
          "Testing, Adjusting, and Balancing (TAB) certification",
        ],
        bidDeadline: "2026-09-28",
        status: "rfqs_dispatched",
      },
      {
        _id: plumbPkgId,
        projectId: projId,
        csiDivision: "22 00 00",
        tradeName: "Plumbing & Domestic Water Systems",
        budgetEstimate: 950000,
        agentMailbox: "boldlevel182@agentmail.to",
        agentMailboxId: "boldlevel182@agentmail.to",
        scopeSummary:
          "Domestic hot/cold copper supply, cast iron sanitary waste, roof drainage overflow, and triplex water booster pump skid.",
        mandatoryInclusions: [
          "Triplex booster pump startup and testing",
          "Core drilling and sleeve penetrations",
          "Backflow preventer city inspection certificate",
        ],
        bidDeadline: "2026-10-02",
        status: "draft",
      },
    ],
    contractors: [
      {
        _id: cElec1,
        tradePackageId: elecPkgId,
        companyName: "Rosendin Electric, Inc.",
        contactEmail: "estimating@rosendin.com",
        phone: "+1 (512) 835-2400",
        licenseNumber: "TX-TECL-18042",
        licenseStatus: "Active / Verified (TDLR)",
        sourceUrl: "https://www.rosendin.com",
        rfqStatus: "bid_received",
        dispatchedAt: now - 86400000 * 2,
      },
      {
        _id: cElec2,
        tradePackageId: elecPkgId,
        companyName: "Alterman, Inc.",
        contactEmail: "estimating@goalterman.com",
        phone: "+1 (512) 454-0326",
        licenseNumber: "TX-TECL-19204",
        licenseStatus: "Active / Verified (TDLR)",
        sourceUrl: "https://goalterman.com",
        rfqStatus: "bid_received",
        dispatchedAt: now - 86400000 * 2,
      },
      {
        _id: cElec3,
        tradePackageId: elecPkgId,
        companyName: "Prism Electric, Inc.",
        contactEmail: "estimating@prismelectric.com",
        phone: "+1 (512) 419-7476",
        licenseNumber: "TX-TECL-33109",
        licenseStatus: "Active / Verified (TDLR)",
        sourceUrl: "https://prismelectric.com",
        rfqStatus: "invited",
        dispatchedAt: now - 86400000 * 2,
      },
      {
        _id: cHvac1,
        tradePackageId: hvacPkgId,
        companyName: "TDIndustries, Inc.",
        contactEmail: "estimating@tdindustries.com",
        phone: "+1 (512) 310-5300",
        licenseNumber: "TX-TACLA-11842E",
        licenseStatus: "Active / Verified (TDLR)",
        sourceUrl: "https://www.tdindustries.com",
        rfqStatus: "bid_received",
        dispatchedAt: now - 86400000 * 2,
      },
      {
        _id: cHvac2,
        tradePackageId: hvacPkgId,
        companyName: "The Brandt Companies, LLC",
        contactEmail: "estimating@brandt.us",
        phone: "+1 (512) 491-9100",
        licenseNumber: "TX-TACLA-01048C",
        licenseStatus: "Active / Verified (TDLR)",
        sourceUrl: "https://brandt.us",
        rfqStatus: "bid_received",
        dispatchedAt: now - 86400000 * 2,
      },
      {
        _id: cHvac3,
        tradePackageId: hvacPkgId,
        companyName: "Southland Industries",
        contactEmail: "estimating@southlandind.com",
        phone: "+1 (512) 443-1566",
        licenseNumber: "TX-TACLA-00192C",
        licenseStatus: "Active / Verified (TDLR)",
        sourceUrl: "https://southlandind.com",
        rfqStatus: "invited",
        dispatchedAt: now - 86400000 * 2,
      },
      {
        _id: cPlumb1,
        tradePackageId: plumbPkgId,
        companyName: "Clarke Kent Plumbing",
        contactEmail: "dispatch@clarkekentplumbing.com",
        phone: "+1 (512) 282-7000",
        licenseNumber: "TX-RMP-39182",
        licenseStatus: "Active / Verified (TSBPE)",
        sourceUrl: "https://clarkekentplumbing.com",
        rfqStatus: "bid_received",
        dispatchedAt: now - 86400000 * 2,
      },
      {
        _id: cPlumb2,
        tradePackageId: plumbPkgId,
        companyName: "Limbach Facility Services LLC",
        contactEmail: "estimating@limbachinc.com",
        phone: "+1 (512) 456-3570",
        licenseNumber: "TX-RMP-41029",
        licenseStatus: "Active / Verified (TSBPE)",
        sourceUrl: "https://limbachinc.com",
        rfqStatus: "bid_received",
        dispatchedAt: now - 86400000 * 2,
      },
    ],
    conversations: [
      {
        _id: "conv_elec_01",
        tradePackageId: elecPkgId,
        contractorId: cElec1,
        threadId: "th_rfq_elec_rosendin_01",
        inboundSubject: "RFI #1: Division 26 Temporary Power Responsibility",
        inboundQuestion:
          "Does the base electrical package include furnishing the temporary 400A jobsite distribution board, or does GC provide temporary power at the perimeter trailer?",
        autonomousReply:
          "Per TradePulse Spec Analysis (Section 01 00 00 & Div 26 Scope Summary): Subcontractor is responsible for furnishing and maintaining the 400A jobsite power distribution board from the utility tap. GC will only coordinate with Austin Energy for initial utility meter drop.",
        confidenceScore: 0.96,
        status: "clarified",
        timestamp: now - 86400000,
      },
      {
        _id: "conv_elec_02",
        tradePackageId: elecPkgId,
        contractorId: cElec2,
        threadId: "th_rfq_elec_alterman_02",
        inboundSubject: "RFI #2: Switchgear Hoisting Clearance",
        inboundQuestion:
          "Is the penthouse freight elevator rated for the 1600A switchgear sections, or is rooftop crane mobilization required?",
        autonomousReply:
          "Per TradePulse Spec Analysis (Section 26 00 00): Penthouse freight elevator capacity is capped at 3,500 lbs; the 1600A switchgear weighs 7,200 lbs. Rooftop crane rigging and hoisting must be included in Division 26 scope.",
        confidenceScore: 0.94,
        status: "clarified",
        timestamp: now - 43200000,
      },
      {
        _id: "conv_elec_03",
        tradePackageId: elecPkgId,
        contractorId: cElec2,
        threadId: "th_rfq_elec_alterman_03",
        inboundSubject: "RFI #3: Switchboard Bus Duct vs Conduit Feeders",
        inboundQuestion:
          "Spec Section 26 24 13 indicates copper bus duct from vault to 14th floor, but drawing E-101 shows parallel 4-inch rigid conduits. Please clarify governing document.",
        autonomousReply:
          "TradePulse AI Draft Clarification: Specification Section 26 24 13 Article 2.1 designates copper sandwich busway as primary feeder; drawings show alternate conduit pathway. Citing Document Priority clause: specifications govern over drawings. Flagged for Project Manager / Electrical Engineer confirmation before addendum issuance.",
        confidenceScore: 0.88,
        status: "escalated_to_pm",
        timestamp: now - 21600000,
      },
      {
        _id: "conv_hvac_01",
        tradePackageId: hvacPkgId,
        contractorId: cHvac1,
        threadId: "th_rfq_hvac_tdindustries_01",
        inboundSubject: "RFI #1: Division 23 BACnet MS/TP Gateway Interface Protocol",
        inboundQuestion:
          "Does Division 23 HVAC include furnishing and programming the BACnet MS/TP integration gateway to the base building automation system (BAS), or is the controls vendor providing the hardware gateway?",
        autonomousReply:
          "Per TradePulse Spec Analysis (Section 23 09 00 & Div 23 Scope): Division 23 Subcontractor must furnish the native BACnet MS/TP integration gateway hardware and coordinate protocol points with the Master Building Automation System (BAS) contractor.",
        confidenceScore: 0.97,
        status: "clarified",
        timestamp: now - 72000000,
      },
    ],
    bids: [
      {
        _id: "bid_elec_rosendin",
        tradePackageId: elecPkgId,
        contractorId: cElec1,
        subcontractorName: "Rosendin Electric, Inc.",
        baseBidAmount: 1225000,
        lineItems: [
          { item: "1600A Main Switchboard & Transformers", unit: "LS", quantity: 1, unitCost: 450000, totalCost: 450000 },
          { item: "Emergency Lighting & Inverters", unit: "LS", quantity: 1, unitCost: 185000, totalCost: 185000 },
          { item: "Branch Conduit & Wire Feeder Runs", unit: "LF", quantity: 24000, unitCost: 18, totalCost: 432000 },
          { item: "Crane Hoisting to Penthouse Switchgear Room", unit: "LS", quantity: 1, unitCost: 38000, totalCost: 38000 },
          { item: "UL 1479 Rated Firestopping Penetrations", unit: "LS", quantity: 1, unitCost: 20000, totalCost: 20000 },
          { item: "Seismic Bracing System & Engineering", unit: "LS", quantity: 1, unitCost: 100000, totalCost: 100000 },
        ],
        identifiedExclusions: [],
        valueEngineeringAlternates: [
          {
            description: "VE-01: Feeder cable optimization (Aluminum MC cable in lieu of copper conduit)",
            costDeduct: 35000,
            isAccepted: false,
          },
        ],
        longLeadEquipmentWeeks: 10,
        leadTimePenalty: 0,
        coiComplianceStatus: "compliant",
        coiPenalty: 0,
        leveledTotalCost: 1225000,
        isAwarded: false,
        receivedAt: now - 3600000 * 18,
      },
      {
        _id: "bid_elec_alterman",
        tradePackageId: elecPkgId,
        contractorId: cElec2,
        subcontractorName: "Alterman, Inc.",
        baseBidAmount: 1100000,
        lineItems: [
          { item: "1600A Main Switchboard (Furnish Only)", unit: "LS", quantity: 1, unitCost: 420000, totalCost: 420000 },
          { item: "Emergency Lighting & Inverters", unit: "LS", quantity: 1, unitCost: 170000, totalCost: 170000 },
          { item: "Branch Conduit & Wire Feeder Runs", unit: "LF", quantity: 24000, unitCost: 17, totalCost: 408000 },
          { item: "Site Distribution & Temporary Hookups", unit: "LS", quantity: 1, unitCost: 102000, totalCost: 102000 },
        ],
        identifiedExclusions: [
          {
            description: "Crane hoisting & rigging to penthouse mechanical floor excluded (GC to furnish)",
            costImpact: 45000,
            severity: "critical",
            isWaived: false,
          },
          {
            description: "UL 1479 firestop floor penetrations excluded (By drywall trade)",
            costImpact: 22000,
            severity: "critical",
            isWaived: false,
          },
          {
            description: "Seismic engineered structural bracing excluded (By others)",
            costImpact: 55000,
            severity: "critical",
            isWaived: false,
          },
          {
            description: "Overtime/weekend acceleration excluded from base rate",
            costImpact: 25000,
            severity: "moderate",
            isWaived: false,
          },
        ],
        valueEngineeringAlternates: [],
        longLeadEquipmentWeeks: 16,
        leadTimePenalty: 24000,
        coiComplianceStatus: "deficiency_detected",
        coiPenalty: 15000,
        leveledTotalCost: 1286000,
        isAwarded: false,
        receivedAt: now - 3600000 * 12,
      },
      {
        _id: "bid_hvac_tdindustries",
        tradePackageId: hvacPkgId,
        contractorId: cHvac1,
        subcontractorName: "TDIndustries, Inc.",
        baseBidAmount: 1820000,
        lineItems: [
          { item: "Chilled Water AHU Units & Piping", unit: "LS", quantity: 1, unitCost: 820000, totalCost: 820000 },
          { item: "VAV Terminal Units & Electric Reheat", unit: "EA", quantity: 110, unitCost: 3500, totalCost: 385000 },
          { item: "Galvanized Ductwork Distribution", unit: "LF", quantity: 18000, unitCost: 22, totalCost: 396000 },
          { item: "Rooftop Crane Hoisting to Cooling Tower Pad", unit: "LS", quantity: 1, unitCost: 48000, totalCost: 48000 },
          { item: "Certified TAB Air/Hydronic Balance Report", unit: "LS", quantity: 1, unitCost: 28000, totalCost: 28000 },
          { item: "BACnet MS/TP Automation Gateway Card", unit: "LS", quantity: 1, unitCost: 18000, totalCost: 18000 },
          { item: "Spring Vibration Isolator Hangers", unit: "LS", quantity: 1, unitCost: 14000, totalCost: 14000 },
          { item: "Testing, Startup & 1-Yr Warranty", unit: "LS", quantity: 1, unitCost: 111000, totalCost: 111000 },
        ],
        identifiedExclusions: [],
        longLeadEquipmentWeeks: 12,
        leadTimePenalty: 0,
        coiComplianceStatus: "compliant",
        coiPenalty: 0,
        leveledTotalCost: 1820000,
        isAwarded: false,
        receivedAt: now - 3600000 * 16,
      },
      {
        _id: "bid_hvac_brandt",
        tradePackageId: hvacPkgId,
        contractorId: cHvac2,
        subcontractorName: "The Brandt Companies, LLC",
        baseBidAmount: 1650000,
        lineItems: [
          { item: "Chilled Water AHU Units & Piping", unit: "LS", quantity: 1, unitCost: 780000, totalCost: 780000 },
          { item: "VAV Terminal Units & Electric Reheat", unit: "EA", quantity: 110, unitCost: 3200, totalCost: 352000 },
          { item: "Galvanized Ductwork Distribution", unit: "LF", quantity: 18000, unitCost: 20, totalCost: 360000 },
          { item: "General Testing & Start-up", unit: "LS", quantity: 1, unitCost: 158000, totalCost: 158000 },
        ],
        identifiedExclusions: [
          {
            description: "Rooftop crane hoisting to cooling tower deck excluded (GC to furnish crane)",
            costImpact: 48000,
            severity: "critical",
            isWaived: false,
          },
          {
            description: "Testing, Adjusting, and Balancing (TAB) certified report excluded",
            costImpact: 28000,
            severity: "critical",
            isWaived: false,
          },
          {
            description: "BACnet MS/TP automation integration gateway excluded",
            costImpact: 18000,
            severity: "moderate",
            isWaived: false,
          },
          {
            description: "Spring vibration isolation hangers excluded (Un-isolated provided)",
            costImpact: 14000,
            severity: "moderate",
            isWaived: false,
          },
        ],
        valueEngineeringAlternates: [],
        longLeadEquipmentWeeks: 18,
        leadTimePenalty: 12000,
        coiComplianceStatus: "deficiency_detected",
        coiPenalty: 15000,
        leveledTotalCost: 1785000,
        isAwarded: false,
        receivedAt: now - 3600000 * 10,
      },
      {
        _id: "bid_plumb_clarke",
        tradePackageId: plumbPkgId,
        contractorId: cPlumb1,
        subcontractorName: "Clarke Kent Plumbing",
        baseBidAmount: 920000,
        lineItems: [
          { item: "Domestic Copper Piping Distribution", unit: "LS", quantity: 1, unitCost: 340000, totalCost: 340000 },
          { item: "Cast Iron Sanitary Waste & Vent Stack", unit: "LS", quantity: 1, unitCost: 285000, totalCost: 285000 },
          { item: "Triplex Booster Pump Skid Assembly", unit: "LS", quantity: 1, unitCost: 145000, totalCost: 145000 },
          { item: "Plumbing Fixtures & Flush Valves", unit: "LS", quantity: 1, unitCost: 150000, totalCost: 150000 },
        ],
        identifiedExclusions: [],
        longLeadEquipmentWeeks: 10,
        leadTimePenalty: 0,
        coiComplianceStatus: "compliant",
        coiPenalty: 0,
        leveledTotalCost: 920000,
        isAwarded: false,
        receivedAt: now - 3600000 * 14,
      },
      {
        _id: "bid_plumb_limbach",
        tradePackageId: plumbPkgId,
        contractorId: cPlumb2,
        subcontractorName: "Limbach Facility Services LLC",
        baseBidAmount: 820000,
        lineItems: [
          { item: "Domestic Copper Piping Distribution", unit: "LS", quantity: 1, unitCost: 310000, totalCost: 310000 },
          { item: "Cast Iron Sanitary Waste & Vent Stack", unit: "LS", quantity: 1, unitCost: 260000, totalCost: 260000 },
          { item: "Triplex Booster Pump Skid Assembly", unit: "LS", quantity: 1, unitCost: 130000, totalCost: 130000 },
          { item: "Plumbing Fixtures & Trim", unit: "LS", quantity: 1, unitCost: 120000, totalCost: 120000 },
        ],
        identifiedExclusions: [
          {
            description: "Core drilling and floor/wall penetration sleeves excluded",
            costImpact: 16000,
            severity: "critical",
          },
          {
            description: "City of Austin backflow preventer inspection certification excluded",
            costImpact: 8500,
            severity: "minor",
          },
          {
            description: "Triplex booster pump factory certified technician startup excluded",
            costImpact: 12000,
            severity: "moderate",
          },
          {
            description: "Crane hoisting & rigging to penthouse mechanical floor excluded (GC to furnish crane)",
            costImpact: 25000,
            severity: "critical",
          },
        ],
        longLeadEquipmentWeeks: 18,
        leadTimePenalty: 12000,
        coiComplianceStatus: "deficiency_detected",
        coiPenalty: 15000,
        leveledTotalCost: 908500,
        isAwarded: false,
        receivedAt: now - 3600000 * 8,
      },
    ],
    agreements: [
      {
        _id: "agr_sample_01",
        projectId: projId,
        tradePackageId: elecPkgId,
        bidId: "bid_elec_rosendin",
        contractorId: cElec1,
        agreementNumber: "AIA-A401-2026-001",
        documentTitle: "Standard Form of Agreement Between Contractor and Subcontractor",
        subcontractorName: "Rosendin Electric, Inc.",
        generalContractorName: "Austin Commercial, LP",
        projectTitle: "The Domain Tower B - Commercial MEP",
        projectLocation: "Austin, TX",
        csiDivision: "26 00 00",
        tradeName: "Electrical & Lighting Systems",
        contractSum: 1225000,
        retainagePercent: 10,
        liquidatedDamagesDaily: 1200,
        scopeSummary:
          "Complete commercial electrical distribution, 1600A switchgear, penthouse crane hoisting, emergency lighting, and seismic bracing.",
        mandatoryInclusions: [
          "Crane hoisting to 14th-floor mechanical room",
          "Seismic bracing (IBC Section 1613)",
          "Temporary 400A jobsite power distribution",
          "UL 1479 floor/wall firestopping",
        ],
        status: "generated",
        contractText: `SUBCONTRACT AGREEMENT — A401-STYLE STRUCTURE (GENERATED DRAFT) — not an AIA-licensed form
AGREEMENT made as of the day of contract award in the year 2026.
BETWEEN the Contractor: Austin Commercial, LP, Austin, TX
and the Subcontractor: Rosendin Electric, Inc., TX-TECL-18042
The Project: The Domain Tower B - Commercial MEP, Austin, TX
CSI Division: 26 00 00 - Electrical & Lighting Systems

ARTICLE 1: THE SUBCONTRACT DOCUMENTS
The Subcontract Documents consist of this Agreement, Conditions of the Subcontract, Specifications, Drawings, and Addenda.

ARTICLE 4: SUBCONTRACT SUM
The Contractor shall pay the Subcontractor in current funds for the Subcontractor's performance of the Subcontract the Subcontract Sum of One Million Two Hundred Twenty-Five Thousand Dollars ($1,225,000.00), subject to additions and deductions as provided in the Subcontract Documents. Retainage of 10.0% shall be withheld from progress billings until Substantial Completion. Liquidated damages shall be assessed at $1,200.00 per calendar day for unexcused project delays.`,
        createdAt: now - 3600000 * 5,
      },
    ],
    projectFiles: [
      {
        _id: "file_spec_01",
        projectId: projId,
        tradePackageId: elecPkgId,
        storageId: "/specs/01_00_00_General_Requirements.pdf",
        fileName: "01_00_00_General_Requirements.pdf",
        fileType: "spec",
        fileSize: 774760,
        uploadedBy: "Chief Commercial Estimator",
        uploadedAt: now - 86400000 * 3,
        url: "/specs/01_00_00_General_Requirements.pdf",
        textContent: getRealDocumentText("01_00_00_General_Requirements.pdf") || undefined,
      },
      {
        _id: "file_spec_26",
        projectId: projId,
        tradePackageId: elecPkgId,
        storageId: "/specs/26_00_00_Electrical_Systems_Spec.pdf",
        fileName: "26_00_00_Electrical_Systems_Spec.pdf",
        fileType: "spec",
        fileSize: 931307,
        uploadedBy: "Lead Electrical Engineer (PE)",
        uploadedAt: now - 86400000 * 3,
        url: "/specs/26_00_00_Electrical_Systems_Spec.pdf",
        textContent: getRealDocumentText("26_00_00_Electrical_Systems_Spec.pdf") || undefined,
      },
      {
        _id: "file_spec_23",
        projectId: projId,
        tradePackageId: hvacPkgId,
        storageId: "/specs/23_00_00_HVAC_Systems_Spec.pdf",
        fileName: "23_00_00_HVAC_Systems_Spec.pdf",
        fileType: "spec",
        fileSize: 165362,
        uploadedBy: "Lead Mechanical Engineer (PE)",
        uploadedAt: now - 86400000 * 3,
        url: "/specs/23_00_00_HVAC_Systems_Spec.pdf",
        textContent: getRealDocumentText("23_00_00_HVAC_Systems_Spec.pdf") || undefined,
      },
      {
        _id: "file_spec_22",
        projectId: projId,
        tradePackageId: plumbPkgId,
        storageId: "/specs/22_00_00_Plumbing_Systems_Spec.pdf",
        fileName: "22_00_00_Plumbing_Systems_Spec.pdf",
        fileType: "spec",
        fileSize: 4391422,
        uploadedBy: "Lead Plumbing & Fire Protection Engineer (PE)",
        uploadedAt: now - 86400000 * 3,
        url: "/specs/22_00_00_Plumbing_Systems_Spec.pdf",
        textContent: getRealDocumentText("22_00_00_Plumbing_Systems_Spec.pdf") || undefined,
      },
      {
        _id: "file_dwg_e101",
        projectId: projId,
        tradePackageId: elecPkgId,
        storageId: "/drawings/E-101_Main_Switchgear_Penthouse_Plan.pdf",
        fileName: "E-101_Main_Switchgear_Penthouse_Plan.pdf",
        fileType: "blueprint",
        fileSize: 4094,
        uploadedBy: "Project Architect / BIM Coordinator",
        uploadedAt: now - 86400000 * 2,
        url: "/drawings/E-101_Main_Switchgear_Penthouse_Plan.pdf",
        textContent: getRealDocumentText("E-101_Main_Switchgear_Penthouse_Plan.pdf") || undefined,
      },
      {
        _id: "file_quote_rosendin",
        projectId: projId,
        tradePackageId: elecPkgId,
        storageId: "/quotes/Rosendin_Electric_Proposal_AIA.pdf",
        fileName: "Rosendin_Electric_Proposal_AIA.pdf",
        fileType: "quote_pdf",
        fileSize: 6066,
        uploadedBy: "Rosendin Electric, Inc.",
        uploadedAt: now - 3600000 * 18,
        url: "/quotes/Rosendin_Electric_Proposal_AIA.pdf",
        textContent: getRealDocumentText("Rosendin_Electric_Proposal_AIA.pdf") || undefined,
      },
      {
        _id: "file_quote_alterman",
        projectId: projId,
        tradePackageId: elecPkgId,
        storageId: "/quotes/Alterman_Power_Quote_Proposal.pdf",
        fileName: "Alterman_Power_Quote_Proposal.pdf",
        fileType: "quote_pdf",
        fileSize: 5270,
        uploadedBy: "Alterman, Inc.",
        uploadedAt: now - 3600000 * 12,
        url: "/quotes/Alterman_Power_Quote_Proposal.pdf",
        textContent: getRealDocumentText("Alterman_Power_Quote_Proposal.pdf") || undefined,
      },
      {
        _id: "file_coi_rosendin",
        projectId: projId,
        tradePackageId: elecPkgId,
        storageId: "/insurance/Rosendin_Electric_ACORD25_COI.pdf",
        fileName: "Rosendin_Electric_ACORD25_COI.pdf",
        fileType: "coi_certificate",
        fileSize: 4160,
        uploadedBy: "Rosendin Risk Management / Travelers",
        uploadedAt: now - 3600000 * 10,
        url: "/insurance/Rosendin_Electric_ACORD25_COI.pdf",
        textContent: getRealDocumentText("Rosendin_Electric_ACORD25_COI.pdf") || undefined,
      },
    ],
    auditLogs: [
      {
        _id: "log_01",
        projectId: projId,
        tradePackageId: elecPkgId,
        eventType: "rfq_dispatched",
        title: "RFQs Dispatched for Division 26 Electrical",
        description:
          "Dispatched invitations to bid with mandatory scope inclusions via AgentMail to 3 verified commercial contractors.",
        actor: "Lead Project Manager",
        timestamp: now - 86400000 * 2,
      },
      {
        _id: "log_02",
        projectId: projId,
        tradePackageId: elecPkgId,
        eventType: "rfi_clarified",
        title: "Pre-Bid RFI #1 Clarified by TradePulse AI",
        description:
          "Answered temporary power query for Rosendin Electric, Inc. citing Section 01 00 00 with 96% model confidence.",
        actor: "TradePulse AI Spec Agent",
        timestamp: now - 86400000,
      },
      {
        _id: "log_03",
        projectId: projId,
        tradePackageId: elecPkgId,
        eventType: "bid_leveled",
        title: "Forensic Bid Leveling Matrix Generated",
        description:
          "Normalized proposals from Rosendin Electric, Inc. ($1,225,000) and Alterman, Inc. ($1,286,000 normalized with $186,000 in scope adjustments).",
        actor: "Forensic Leveling Engine (ADR-0003)",
        timestamp: now - 3600000 * 12,
      },
      {
        _id: "log_04",
        projectId: projId,
        eventType: "compliance_audit",
        title: "Cross-Trade Coordination Scan Completed",
        description:
          "Automated audit scanned Division 26 and Division 23 proposals. Detected 2 Double-Buys ($50,500) and 2 Scope Voids ($46,500).",
        actor: "TradePulse Coordination Engine",
        timestamp: now - 3600000 * 6,
      },
    ],
    doubleBuys: [
      {
        id: "clash-vfd-01",
        projectId: projId,
        title: "Variable Frequency Drives (VFDs) for AHUs & Pumps",
        primaryTradeDivision: "26 00 00",
        primaryTradeName: "Electrical & Lighting Systems",
        primaryCost: 42000,
        primaryLineItem: "12x Packaged VFD Starters with bypass & line reactors",
        secondaryTradeDivision: "23 00 00",
        secondaryTradeName: "Heating, Ventilating & Air Conditioning",
        secondaryCost: 38500,
        secondaryLineItem: "Factory-Mounted VFD units on Chilled Water AHUs",
        redundantAmount: 38500,
        description:
          "Both Division 26 Electrical and Division 23 HVAC proposals included furnishing and installing Variable Frequency Drives for air handling units. GC is at risk of paying twice for 12 identical drives.",
        status: "detected",
      },
      {
        id: "clash-disconnect-02",
        projectId: projId,
        title: "Rooftop Mechanical Equipment Disconnect Switches",
        primaryTradeDivision: "26 00 00",
        primaryTradeName: "Electrical & Lighting Systems",
        primaryCost: 14500,
        primaryLineItem: "NEMA 3R outdoor fused disconnects at penthouse chiller pad",
        secondaryTradeDivision: "23 00 00",
        secondaryTradeName: "Heating, Ventilating & Air Conditioning",
        secondaryCost: 12000,
        secondaryLineItem: "Unit-mounted weatherproof disconnect switches",
        redundantAmount: 12000,
        description:
          "Both electrical and HVAC trades priced local disconnect switches for chiller and cooling tower motors. Standard trade practice assigns this to Electrical.",
        status: "detected",
      },
    ],
    scopeVoids: [
      {
        id: "void-bas-wiring-01",
        projectId: projId,
        title: "Low-Voltage 24V BAS Control & Interlock Wiring",
        omittedByDivisions: ["26 00 00", "23 00 00"],
        omittedByTrades: ["Division 26 Electrical", "Division 23 HVAC"],
        division26Exclusion:
          "Section 26 00 00 Qualification: 'Excludes all low-voltage HVAC control wiring, DDC sensors, and thermostat interlocks (by Mechanical).'",
        division23Exclusion:
          "Section 23 00 00 Qualification: 'Excludes all field electrical wiring, conduit raceways, 120V power, and interlock runs (by Electrical).'",
        estimatedVoidCost: 28000,
        riskLevel: "critical",
        description:
          "Critical cross-trade void: neither contractor included 24V wiring between VAV terminal boxes, actuators, and DDC panels. If unassigned, GC absorbs $28,000+ field change order.",
        status: "open",
      },
      {
        id: "void-smoke-detectors-02",
        projectId: projId,
        title: "Duct Smoke Detector Installation & FACP Tie-In",
        omittedByDivisions: ["26 00 00", "23 00 00"],
        omittedByTrades: ["Division 26 Electrical", "Division 23 HVAC"],
        division26Exclusion:
          "Division 26 Note: 'Duct smoke detector sampling tube installation in ductwork by Sheet Metal trade.'",
        division23Exclusion:
          "Division 23 Note: 'Life-safety fire alarm conduit, detector wiring, and auxiliary shutdown relays by Electrical.'",
        estimatedVoidCost: 18500,
        riskLevel: "high",
        description:
          "Life-safety code requirement: Duct smoke detectors require mechanical duct penetration + electrical circuit shutdown wiring. Omitted in gap between trades.",
        status: "open",
      },
    ],
  };
}

export function loadStandaloneData(): StandaloneData {
  try {
    // Proactively purge old legacy caches if present
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem("tradepulse_standalone_v1");
      localStorage.removeItem("tradepulse_standalone_v2");
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.projects) && parsed.projects.length > 0) {
          return parsed;
        }
      }
    }
  } catch (e) {
    console.warn("Could not load stored standalone data:", e);
  }
  const initial = getInitialStandaloneData();
  saveStandaloneData(initial);
  return initial;
}

export function saveStandaloneData(data: StandaloneData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("Could not save standalone data:", e);
  }
}

export function extractTextFromPdfStream(rawInput: string | Uint8Array): string {
  if (!rawInput) return "";
  let buf: Uint8Array;
  let rawStr = "";

  if (typeof rawInput === "string") {
    rawStr = rawInput;
    const trimmedLeading = rawStr.replace(/^\uFEFF/, "").trimStart();
    if (!trimmedLeading.startsWith("%PDF") && !rawStr.includes("%PDF-") && !/[\x00-\x08\x0E-\x1F]/.test(rawStr.slice(0, 200))) {
      return rawStr;
    }
    buf = new Uint8Array(rawStr.length);
    for (let i = 0; i < rawStr.length; i++) {
      buf[i] = rawStr.charCodeAt(i) & 0xff;
    }
  } else if (rawInput instanceof Uint8Array) {
    buf = rawInput;
    let s = "";
    const len = Math.min(buf.length, 500);
    for (let i = 0; i < len; i++) s += String.fromCharCode(buf[i]);
    rawStr = s;
    const trimmedLeading = rawStr.replace(/^\uFEFF/, "").trimStart();
    if (!trimmedLeading.startsWith("%PDF") && !rawStr.includes("%PDF-") && !/[\x00-\x08\x0E-\x1F]/.test(rawStr.slice(0, 200))) {
      let fullStr = "";
      for (let i = 0; i < buf.length; i++) fullStr += String.fromCharCode(buf[i]);
      return fullStr;
    }
    let fullS = "";
    for (let i = 0; i < buf.length; i++) fullS += String.fromCharCode(buf[i]);
    rawStr = fullS;
  } else {
    return "";
  }

  // Detect encrypted / password-protected PDF streams
  if (rawStr.includes("/Encrypt") && (/\/Encrypt\s+\d+\s+\d+\s+R/i.test(rawStr) || /\/Filter\s*\/Standard/i.test(rawStr))) {
    return "[PDF_ENCRYPTED] Password-protected or encrypted PDF proposal detected. Please export an unencrypted copy.";
  }

  // Detect corrupted or truncated PDF stream
  if ((rawStr.startsWith("%PDF") && !rawStr.includes("%%EOF") && rawStr.length < 150) ||
      (rawStr.startsWith("%PDF") && !rawStr.includes("obj") && !rawStr.includes("stream") && rawStr.length < 200)) {
    return "[PDF_CORRUPTED] Corrupted or incomplete PDF file structure.";
  }

  const extractedPieces: string[] = [];

  // Helper to decode PDF literal escape sequences including octal codes
  const decodePdfLiteral = (str: string): string => {
    return str
      .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\b/g, "\b")
      .replace(/\\f/g, "\f")
      .replace(/\\([()\\])/g, "$1");
  };

  // Helper to decode PDF hex strings <48656c6c6f>
  const decodePdfHex = (hex: string): string => {
    const cleanHex = hex.replace(/\s+/g, "");
    let out = "";
    for (let i = 0; i < cleanHex.length; i += 2) {
      const byte = parseInt(cleanHex.slice(i, i + 2), 16);
      if (!isNaN(byte) && byte >= 32 && byte <= 126) {
        out += String.fromCharCode(byte);
      } else if (byte === 10 || byte === 13 || byte === 9) {
        out += " ";
      }
    }
    return out;
  };

  const parseContentStream = (streamText: string) => {
    // 1. Extract from kerning arrays: [(item1) 20 (item2)] TJ
    const tjArrays = Array.from(streamText.matchAll(/\[([\s\S]*?)\]\s*TJ/g));
    for (const arr of tjArrays as any[]) {
      const innerParts: string[] = [];
      const tokens = Array.from(arr[1].matchAll(/\(([^)]+)\)|<([0-9a-fA-F]+)>/g));
      for (const token of tokens as any[]) {
        if (token[1] !== undefined) {
          innerParts.push(decodePdfLiteral(token[1]));
        } else if (token[2] !== undefined) {
          innerParts.push(decodePdfHex(token[2]));
        }
      }
      if (innerParts.length > 0) {
        extractedPieces.push(innerParts.join(""));
      }
    }

    // 2. Extract single literal text strings: (text string) Tj or '
    const simpleTj = Array.from(streamText.matchAll(/\(([^)]{1,})\)\s*(?:Tj|'|")/g)).map((m: any) =>
      decodePdfLiteral(m[1])
    );
    extractedPieces.push(...simpleTj);

    // 3. Extract standalone hex strings: <48656c6c6f> Tj
    const hexTj = Array.from(streamText.matchAll(/<([0-9a-fA-F]{2,})>\s*(?:Tj|'|")/g)).map((m: any) =>
      decodePdfHex(m[1])
    );
    extractedPieces.push(...hexTj);
  };

  // Find all streams in binary buffer
  let pos = 0;
  while (pos < buf.length) {
    // Search for "stream" (115, 116, 114, 101, 97, 109)
    let streamIdx = -1;
    for (let i = pos; i <= buf.length - 6; i++) {
      if (
        buf[i] === 115 &&
        buf[i + 1] === 116 &&
        buf[i + 2] === 114 &&
        buf[i + 3] === 101 &&
        buf[i + 4] === 97 &&
        buf[i + 5] === 109
      ) {
        streamIdx = i;
        break;
      }
    }
    if (streamIdx === -1) break;

    let startData = streamIdx + 6;
    if (buf[startData] === 0x0d && buf[startData + 1] === 0x0a) startData += 2;
    else if (buf[startData] === 0x0a) startData += 1;
    else if (buf[startData] === 0x0d) startData += 1;

    // Search for "endstream" (101, 110, 100, 115, 116, 114, 101, 97, 109)
    let endIdx = -1;
    for (let i = startData; i <= buf.length - 9; i++) {
      if (
        buf[i] === 101 &&
        buf[i + 1] === 110 &&
        buf[i + 2] === 100 &&
        buf[i + 3] === 115 &&
        buf[i + 4] === 116 &&
        buf[i + 5] === 114 &&
        buf[i + 6] === 101 &&
        buf[i + 7] === 97 &&
        buf[i + 8] === 109
      ) {
        endIdx = i;
        break;
      }
    }
    if (endIdx === -1) break;

    const streamBytes = buf.subarray(startData, endIdx);
    // Inspect preceding 300 bytes for /FlateDecode filter
    const prevStart = Math.max(0, streamIdx - 300);
    let prevHeader = "";
    for (let k = prevStart; k < streamIdx; k++) {
      prevHeader += String.fromCharCode(buf[k]);
    }

    if (prevHeader.includes("FlateDecode")) {
      try {
        const decompressed = inflate(streamBytes);
        let decStr = "";
        for (let d = 0; d < decompressed.length; d++) {
          decStr += String.fromCharCode(decompressed[d]);
        }
        parseContentStream(decStr);
      } catch {
        // Fallback if inflate fails
      }
    } else {
      let uncompStr = "";
      for (let u = 0; u < streamBytes.length; u++) {
        uncompStr += String.fromCharCode(streamBytes[u]);
      }
      parseContentStream(uncompStr);
    }
    pos = endIdx + 9;
  }

  // If no stream text extracted, check raw uncompressed text outside streams
  if (extractedPieces.length === 0) {
    parseContentStream(rawStr);
  }

  const extracted = extractedPieces.join("\n").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ").trim();

  // If we already extracted valid text (> 15 chars), return it directly to avoid binary contamination
  if (extracted.length > 15) {
    return extracted.slice(0, 32000);
  }

  // 3. Fallback token extraction: Strip binary stream contents first
  const textWithoutBinary = rawStr.replace(/stream[\r\n][\s\S]*?endstream/gi, "");
  const segments = textWithoutBinary.match(/[A-Za-z0-9\s.,;:$%/\\()\-–—@&+=#'"_[\]*!?]{4,}/g) || [];
  const cleanTokens = segments
    .filter((s: string) => {
      const trimmed = s.trim();
      return (
        !trimmed.startsWith("/") &&
        !trimmed.startsWith("obj") &&
        !trimmed.startsWith("endobj") &&
        !trimmed.startsWith("<<") &&
        !trimmed.startsWith(">>") &&
        !trimmed.includes("/Font") &&
        !trimmed.includes("/Type") &&
        !trimmed.includes("/Filter") &&
        !trimmed.includes("/FlateDecode") &&
        !trimmed.includes("/Length") &&
        !trimmed.includes("/XObject") &&
        !trimmed.includes("/Subtype") &&
        !trimmed.includes("/Image") &&
        !trimmed.includes("/Width") &&
        !trimmed.includes("/Height") &&
        !trimmed.includes("/ColorSpace") &&
        !trimmed.includes("/BitsPerComponent") &&
        !trimmed.includes("/Catalog") &&
        !trimmed.includes("/Pages") &&
        !trimmed.includes("/MediaBox") &&
        !/^(?:xref|trailer|startxref|stream|endstream|EOF|%%EOF|JFIF)$/i.test(trimmed)
      );
    })
    .join(" ")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    .trim();

  // Only consider cleanTokens if it contains actual words, not just dictionary numbers/tokens
  const hasRealWords = /[a-zA-Z]{3,}\s+[a-zA-Z]{3,}/.test(cleanTokens);
  const candidateText = extracted.length > 15 ? extracted : (hasRealWords && cleanTokens.length > 30 ? cleanTokens : extracted);
  return candidateText.slice(0, 32000);
}

export function cleanNumber(val: any, fallback = 0): number {
  if (typeof val === "number") {
    return Number.isFinite(val) ? val : fallback;
  }
  if (!val) return fallback;
  if (typeof val !== "string") return fallback;

  // 1. Normalize unicode spaces & dashes
  let str = val
    .replace(/[\u00A0\u202F\u200B\u3000]/g, " ")
    .replace(/[\u2013\u2014]/g, "-")
    .trim();
  if (!str) return fallback;

  // 2. Check for range e.g. '$1,200,000 - $1,350,000' or '$1.2M to $1.4M' or 'between $1.2M and $1.4M'
  const withoutBetween = str.replace(/^between\s+/i, "");
  const rangeMatch = withoutBetween.match(/^(.+?)\s*(?:(?<=\S)\s*[-–—]\s*(?=\S)|\bto\b|\band\b)\s*(.+)$/i);
  if (rangeMatch) {
    let p1 = rangeMatch[1].trim();
    let p2 = rangeMatch[2].trim();
    if (/\d/.test(p1) && /\d/.test(p2) && !/^[+\-]/.test(p1.trim())) {
      const multRegex = /(k|kilo|thousand|m|mil|million|b|bil|billion)$/i;
      const p2Mult = p2.match(multRegex);
      if (p2Mult && !multRegex.test(p1)) {
        p1 = p1 + p2Mult[1];
      }
      const p2Curr = p2.match(/(USD|CAD|EUR|GBP|AUD|CHF|MXN|NZD|SGD)$/i);
      if (p2Curr && !new RegExp(p2Curr[1] + "$", "i").test(p1)) {
        p1 = p1 + " " + p2Curr[1];
      }
      const v1 = cleanNumber(p1, null as any);
      const v2 = cleanNumber(p2, null as any);
      if (v1 !== null && v2 !== null && v1 > 0 && v2 > 0) {
        return Math.round((v1 + v2) / 2);
      }
    }
  }

  // 3. Detect negative / deduct indicators
  const isDeductWord = /\b(?:deduct|deduction|credit|discount|savings|refund|rebate|less)\b/i.test(str);
  let isNegative =
    isDeductWord ||
    (str.startsWith("(") && str.endsWith(")")) ||
    str.startsWith("-") ||
    str.endsWith("-") ||
    /[-]\s*[$€£¥₹]/.test(str) ||
    /[$€£¥₹]\s*[-]/.test(str) ||
    /[-]\s*(?:USD|CAD|EUR|GBP|AUD|CHF|MXN|NZD|SGD)\b/i.test(str) ||
    /\b(?:USD|CAD|EUR|GBP|AUD|CHF|MXN|NZD|SGD)\s*[-]/i.test(str) ||
    /[-]\s*(?:USD|CAD|EUR|GBP|AUD|CHF|MXN|NZD|SGD)$/i.test(str);

  // 4. Strip common conversational / construction estimation prefixes
  str = str
    .replace(/^(?:[~≈*]|approx\.?|est\.?|estimated|budget:?|total:?|sum:?|quote:?|price:?|cost:?|amount:?)\s*/i, "")
    .replace(/^(?:addendum|alternate|option|item|ve|phase)?\s*#?\d*[:\s-]*(?:deduct(?:ion)?|credit|discount|savings|rebate|less):?\s*/i, "")
    .replace(/^(?:deduct(?:ion)?|credit|discount|savings|rebate|less)\s*(?:alternate|option|item|ve|phase)?\s*#?\d*[:\s-]*/i, "")
    .replace(/^(?:addendum|alternate|option|item|ve|phase)\s*#?\d*[:\s-]*/i, "")
    .replace(/^f\.?o\.?b\.?(?:\s*jobsite|\s*site)?:?\s*/i, "")
    .trim();

  // 5. Strip common commercial trailing qualifiers, taxes, and trade notations
  str = str
    .replace(/\s*(?:\+|\/|\bplus\b)?\s*(?:\d+(?:\.\d+)?%?\s*)?(?:sales\s*)?tax(?:es)?(?:\s*(?:extra|excluded|included|exempt|applicable|not\s+included))?/gi, "")
    .replace(/\s*\([^)]*(?:tax|phase|option|addendum|scope)[^)]*\)/gi, "")
    .replace(/\s*(?:\/|\bper\b)?\s*\b(?:lump\s*sum|ls|f\.?o\.?b\.?(?:\s*jobsite|\s*site)?|net\s*\d*|gross|delivered|installed|complete)\b/gi, "")
    .trim();

  // Strip trailing parenthetical notes EXCEPT if whole string is an accounting paren like ($35,000), ($25k), or (USD 50,000)
  const isWrappedInParens = str.startsWith("(") && str.endsWith(")");
  if (isWrappedInParens && /\d/.test(str) && !/\b(?:tax|phase|option|addendum|scope|exempt)\b/i.test(str)) {
    // Keep accounting negative intact
  } else {
    str = str.replace(/\s*\([^)]*\)$/, "").trim();
  }

  // 6. Remove wrapping parens, brackets, and signs
  str = str.replace(/^[(\[]+|[)\]]+$/g, "").replace(/^[-+]|[-+]$/g, "").trim();

  // 7. Strip currency symbols and ISO codes
  str = str
    .replace(/^(?:[$€£¥₹]|USD|CAD|EUR|GBP|AUD|CHF|MXN|NZD|SGD|\s)+/gi, "")
    .replace(/(?:[$€£¥₹]|USD|CAD|EUR|GBP|AUD|CHF|MXN|NZD|SGD|\s)+$/gi, "")
    .trim();

  // Re-check minus after currency strip (e.g. '$-25,000' -> '-25,000' or '25,000- USD' -> '25,000-')
  if (str.startsWith("-")) {
    isNegative = true;
    str = str.replace(/^-\s*/, "");
  }
  if (str.endsWith("-")) {
    isNegative = true;
    str = str.replace(/\s*-$/, "");
  }

  // 8. Check abbreviated multipliers (M, K, B, million, thousand, etc.)
  const multMatch = str.match(/^([0-9\s.,]+)\s*([kmbt]|mil|million|kilo|thousand|bil|billion)\b/i);
  if (multMatch) {
    let numPart = multMatch[1].trim().replace(/\s+/g, "");
    const unit = multMatch[2].toLowerCase();
    if (numPart.includes(",") && !numPart.includes(".")) {
      numPart = numPart.replace(",", ".");
    } else {
      numPart = numPart.replace(/,/g, "");
    }
    const base = parseFloat(numPart);
    if (Number.isFinite(base)) {
      const multiplier =
        unit.startsWith("k") || unit.startsWith("t")
          ? 1e3
          : unit.startsWith("m")
          ? 1e6
          : 1e9;
      const res = Math.round(base * multiplier);
      return isNegative ? -res : res;
    }
    return fallback;
  }

  // 9. Clean thousand separators and parse standard numbers
  str = str.replace(/\s+/g, "");
  const hasDot = str.includes(".");
  const hasComma = str.includes(",");

  if (hasDot && hasComma) {
    const lastDot = str.lastIndexOf(".");
    const lastComma = str.lastIndexOf(",");
    if (lastComma > lastDot) {
      str = str.replace(/\./g, "").replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    const lastComma = str.lastIndexOf(",");
    const digitsAfter = str.length - lastComma - 1;
    const commaCount = (str.match(/,/g) || []).length;
    if (commaCount > 1 || digitsAfter === 3) {
      str = str.replace(/,/g, "");
    } else {
      str = str.replace(",", ".");
    }
  } else if (hasDot && !hasComma) {
    const dotCount = (str.match(/\./g) || []).length;
    if (dotCount > 1) {
      str = str.replace(/\./g, "");
    }
  }

  // 10. Parse primary numeric token
  const numMatch = str.match(/^[-+]?[0-9]+(?:\.[0-9]+)?/);
  if (numMatch) {
    const num = parseFloat(numMatch[0]);
    if (Number.isFinite(num)) {
      const finalVal = roundDollarsToCents(num);
      return isNegative ? -finalVal : finalVal;
    }
  }
  return fallback;
}

export function numberToWords(num: number): string {
  num = Math.round(num);
  const units = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  if (num >= 1000000) {
    const millions = Math.floor(num / 1000000);
    const rem = num % 1000000;
    return `${numberToWords(millions)} Million` + (rem ? ` ${numberToWords(rem)}` : "");
  }
  if (num >= 1000) {
    const thousands = Math.floor(num / 1000);
    const rem = num % 1000;
    return `${numberToWords(thousands)} Thousand` + (rem ? ` ${numberToWords(rem)}` : "");
  }
  if (num >= 100) {
    const hundreds = Math.floor(num / 100);
    const rem = num % 100;
    return `${units[hundreds]} Hundred` + (rem ? ` ${numberToWords(rem)}` : "");
  }
  if (num >= 20) {
    const t = Math.floor(num / 10);
    const rem = num % 10;
    return tens[t] + (rem ? `-${units[rem]}` : "");
  }
  if (num > 0) return units[num];
  return "Zero";
}

const STATE_FULL_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  // Canadian Provinces & Territories
  ON: "Ontario", BC: "British Columbia", AB: "Alberta", QC: "Quebec",
  MB: "Manitoba", SK: "Saskatchewan", NS: "Nova Scotia", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", PE: "Prince Edward Island",
  NT: "Northwest Territories", YT: "Yukon", NU: "Nunavut",
  // International Regions
  UK: "United Kingdom", ENG: "England", SCT: "Scotland", WLS: "Wales",
  AU: "Australia", NSW: "New South Wales", VIC: "Victoria", QLD: "Queensland",
};

export function getStateAbbreviation(stateInput?: string): string {
  if (!stateInput) return "TX";
  const cleaned = stateInput
    .replace(/\b(?:USA|US|UNITED STATES|CANADA|CAN)\b/gi, "")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, "")
    .replace(/\b[A-Z]\d[A-Z]\s*\d[A-Z]\d\b/gi, "")
    .replace(/[^a-zA-Z\s]/g, " ")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");

  if (!cleaned) return "TX";

  const map: Record<string, string> = {
    ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA",
    COLORADO: "CO", CONNECTICUT: "CT", DELAWARE: "DE", "DISTRICT OF COLUMBIA": "DC", FLORIDA: "FL", GEORGIA: "GA",
    HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA",
    KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD",
    MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO",
    MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ",
    "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH",
    OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC",
    "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT",
    VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY",
    // Canadian Provinces & Territories
    ONTARIO: "ON", "BRITISH COLUMBIA": "BC", ALBERTA: "AB", QUEBEC: "QC",
    MANITOBA: "MB", SASKATCHEWAN: "SK", "NOVA SCOTIA": "NS", "NEW BRUNSWICK": "NB",
    "NEWFOUNDLAND AND LABRADOR": "NL", NEWFOUNDLAND: "NL", "PRINCE EDWARD ISLAND": "PE",
    "NORTHWEST TERRITORIES": "NT", YUKON: "YT", NUNAVUT: "NU",
    // International Regions
    "UNITED KINGDOM": "UK", UK: "UK", ENGLAND: "ENG", SCOTLAND: "SCT", WALES: "WLS",
    AUSTRALIA: "AU", "NEW SOUTH WALES": "NSW", VICTORIA: "VIC", QUEENSLAND: "QLD",
  };

  const validCodes = new Set(Object.values(map));
  if ((cleaned.length === 2 || cleaned.length === 3) && validCodes.has(cleaned)) {
    return cleaned;
  }

  if (map[cleaned]) return map[cleaned];

  const tokens = cleaned.split(" ");
  for (const t of tokens) {
    if ((t.length === 2 || t.length === 3) && validCodes.has(t)) {
      return t;
    }
  }

  for (const [name, abbr] of Object.entries(map)) {
    if (cleaned.startsWith(name) || cleaned.includes(name)) {
      return abbr;
    }
  }

  return (cleaned.length === 2 || cleaned.length === 3) ? cleaned : (map[cleaned] || "TX");
}

export function parseCityAndState(location?: string): { city: string; state: string; stateAbbr: string } {
  if (!location || !location.trim()) {
    return { city: "Austin", state: "Texas", stateAbbr: "TX" };
  }

  const trimmed = location.trim();

  // If comma separated, e.g. "Austin, Texas", "Seattle, WA 98101", "Toronto, ON, Canada"
  if (trimmed.includes(",")) {
    const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    const city = parts[0] || "Austin";
    const statePart = parts[1] || "";
    const stateAbbr = getStateAbbreviation(statePart);
    const state = STATE_FULL_NAMES[stateAbbr] || statePart || "Texas";
    return { city, state, stateAbbr };
  }

  // No comma, e.g. "Denver CO", "Denver CO 80202", "Vancouver BC", "Austin Texas"
  const tokens = trimmed.split(/\s+/);
  let foundStateAbbr: string | null = null;
  let splitIndex = tokens.length;

  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i].toUpperCase().replace(/[^A-Z]/g, "");
    if ((token.length === 2 || token.length === 3) && STATE_FULL_NAMES[token]) {
      foundStateAbbr = token;
      splitIndex = i;
      break;
    }
  }

  if (!foundStateAbbr) {
    const abbr = getStateAbbreviation(trimmed);
    if (abbr && abbr !== "TX") {
      foundStateAbbr = abbr;
      for (let i = 0; i < tokens.length; i++) {
        if (getStateAbbreviation(tokens.slice(i).join(" ")) === abbr) {
          splitIndex = i;
          break;
        }
      }
    }
  }

  const stateAbbr = foundStateAbbr || "TX";
  const state = STATE_FULL_NAMES[stateAbbr] || "Texas";
  const city = tokens.slice(0, Math.max(1, splitIndex)).join(" ").trim() || "Austin";

  return { city, state, stateAbbr };
}

export function generateAiaA401AgreementText(params: {
  agreementNumber: string;
  formattedDate: string;
  generalContractor: string;
  gcCity: string;
  gcState: string;
  stateAbbr: string;
  subName: string;
  contactEmail: string;
  licenseNumber: string;
  licenseStatus: string;
  projectTitle: string;
  projectLocation: string;
  projectType: string;
  csiDivision: string;
  tradeName: string;
  scopeSummary: string;
  mandatoryInclusions: string[];
  contractSum: number;
  baseBidAmount: number;
  acceptedVeTotal: number;
  leveledTotalCost: number;
  retainagePercent: number;
  liquidatedDamagesDaily: number;
  bidDeadline: string;
}): string {
  return `================================================================================
SUBCONTRACT AGREEMENT — A401-STYLE STRUCTURE (GENERATED DRAFT)
AGREEMENT NO: ${params.agreementNumber}
================================================================================

NOTICE: This is a TradePulse-generated draft that follows the A401 article
structure. It is not an official AIA document or a licensed AIA form, and the
parties, addresses, license numbers and dates marked [from the Prime Agreement]
must be completed from the executed Prime Agreement before use. TradePulse does
not provide a signature service.

AGREEMENT made as of the ${params.formattedDate}.

BETWEEN the Contractor:
  ${params.generalContractor}
  Address & license: [from the Prime Agreement — verify before execution]

and the Subcontractor:
  ${params.subName}
  Contact: ${params.contactEmail}
  License No: ${params.licenseNumber} (${params.licenseStatus})

The Prime Project:
  ${params.projectTitle}
  Location: ${params.projectLocation}
  Type: ${params.projectType}
  Owner: [Owner from the Prime Agreement]

The Prime Agreement between Contractor and Owner is dated: [Prime Agreement date]
The Architect / Owner Representative: [from the Prime Agreement]

--------------------------------------------------------------------------------
TABLE OF ARTICLES
--------------------------------------------------------------------------------
ARTICLE 1   THE SUBCONTRACT DOCUMENTS & CSI MASTERFORMAT SPECIFICATIONS
ARTICLE 2   MUTUAL RIGHTS AND RESPONSIBILITIES
ARTICLE 3   CONTRACTOR OBLIGATIONS & SITE LOGISTICS
ARTICLE 4   SUBCONTRACTOR WORK & MANDATORY SCOPE INCLUSIONS
ARTICLE 5   CHANGES IN THE WORK & CHANGE ORDER PROTOCOL
ARTICLE 6   SUBCONTRACT SUM, SCHEDULE OF VALUES & PROGRESS PAYMENTS
ARTICLE 7   INSURANCE, ACORD 25 COI & INDEMNIFICATION
ARTICLE 8   SAFETY, QUALITY ASSURANCE & STATUTORY WARRANTIES
ARTICLE 9   DISPUTE RESOLUTION & BINDING ARBITRATION
ARTICLE 10  ATTESTATION & FORMAL EXECUTION

--------------------------------------------------------------------------------
ARTICLE 1 - THE SUBCONTRACT DOCUMENTS
--------------------------------------------------------------------------------
§ 1.1 The Subcontract Documents consist of:
  (1) this Subcontract Agreement (A401-style structure);
  (2) the Prime Agreement between Contractor and Owner;
  (3) the Conditions of the Subcontract (General, Supplementary, and Special);
  (4) CSI MasterFormat Division ${params.csiDivision} (${params.tradeName}) Drawings and Specifications;
  (5) Addenda issued prior to execution; and
  (6) Written Pre-Bid Clarifications and Modifications recorded in TradePulse Pro.

--------------------------------------------------------------------------------
ARTICLE 2 - MUTUAL RIGHTS AND RESPONSIBILITIES
--------------------------------------------------------------------------------
§ 2.1 The Contractor and Subcontractor shall be mutually bound by the terms of this
Agreement and, to the extent that the provisions of the Prime Agreement apply to
the Work of the Subcontractor, the Contractor shall assume toward the Subcontractor
all obligations and responsibilities that the Owner assumes toward the Contractor.

--------------------------------------------------------------------------------
ARTICLE 3 - CONTRACTOR OBLIGATIONS & SITE LOGISTICS
--------------------------------------------------------------------------------
§ 3.1 Contractor shall coordinate utility hookup points, establish perimeter benchmarks,
and administer the TradePulse Pro project procurement portal for RFI clarifications.
All hoisting logistics, floor loading capacities, and crane pick zones shall be
coordinated through Contractor's field superintendent.

--------------------------------------------------------------------------------
ARTICLE 4 - SUBCONTRACTOR WORK & MANDATORY SCOPE INCLUSIONS
--------------------------------------------------------------------------------
§ 4.1 Scope of Work: The Subcontractor shall furnish all labor, materials, equipment,
services, hoisting, and supervision necessary to complete Division ${params.csiDivision}:
${params.tradeName}.

Summary of Scope:
${params.scopeSummary}

§ 4.2 MANDATORY SCOPE INCLUSIONS:
The Subcontractor explicitly certifies and agrees that the Subcontract Sum includes
complete and unabridged fulfillment of the following mandatory trade obligations:
${params.mandatoryInclusions.map((inc) => `  [✓] ${inc}`).join("\n")}

§ 4.3 No fine-print exclusions, unauthorized substitutions, or scope gap carve-outs
shall be recognized or allowed unless approved in an executed Change Order.

--------------------------------------------------------------------------------
ARTICLE 5 - CHANGES IN THE WORK
--------------------------------------------------------------------------------
§ 5.1 The Contractor may, without invalidating the Subcontract, order Changes in the Work
within the general scope of this Subcontract. Such changes shall be authorized by
written Change Order prior to commencement of extra work. Overhead and profit
on approved change orders shall not exceed 10% overhead and 5% profit.

--------------------------------------------------------------------------------
ARTICLE 6 - SUBCONTRACT SUM & PROGRESS PAYMENTS
--------------------------------------------------------------------------------
§ 6.1 The Contractor shall pay the Subcontractor in current funds for the Subcontractor's
performance of the Subcontract the Subcontract Sum of:
  $${params.contractSum.toLocaleString("en-US")} (${numberToWords(params.contractSum)} Dollars).
  (Accounting Reconciliation: Base Bid $${params.baseBidAmount.toLocaleString("en-US")} less Accepted VE Deducts $${params.acceptedVeTotal.toLocaleString("en-US")}. Baseline Leveled Cost: $${params.leveledTotalCost.toLocaleString("en-US")}).

§ 6.2 Progress Payments: Contractor shall pay Subcontractor monthly based on approved
Schedule of Values minus ${params.retainagePercent}% retainage.
Payment terms: Net 30 days following Owner funding.
Liquidated Damages: $${params.liquidatedDamagesDaily.toLocaleString("en-US")} per calendar day for unexcused project delays past Substantial Completion (see the Project Schedule / Prime Agreement).

--------------------------------------------------------------------------------
ARTICLE 7 - INSURANCE & INDEMNIFICATION
--------------------------------------------------------------------------------
§ 7.1 Prior to commencing Work, Subcontractor shall furnish Contractor with an official
ACORD 25 Certificate of Liability Insurance evidencing:
  - Commercial General Liability: $1,000,000 per occurrence / $2,000,000 general aggregate
  - Commercial Umbrella / Excess Liability: $5,000,000 each occurrence
  - Workers' Compensation & Employer's Liability: Statutory limits
  - Contractor and Owner named as Additional Insureds on Primary & Non-Contributory basis
  - 30-Day Written Notice of Cancellation

--------------------------------------------------------------------------------
ARTICLE 8 - SAFETY & STATUTORY WARRANTIES
--------------------------------------------------------------------------------
§ 8.1 Subcontractor warrants that all materials and equipment furnished under this
Subcontract will be new and of recent manufacture, and that Work will be free from
defects and conform strictly to CSI MasterFormat Division ${params.csiDivision} specs.
Warranty period: One (1) full year from Substantial Completion.

--------------------------------------------------------------------------------
ARTICLE 9 - DISPUTE RESOLUTION
--------------------------------------------------------------------------------
§ 9.1 Any claim arising out of or related to this Subcontract Agreement shall be
subject to mediation as a condition precedent to binding dispute resolution administered
by the American Arbitration Association (AAA) in ${params.gcCity}, ${params.gcState}.

--------------------------------------------------------------------------------
ARTICLE 10 - ATTESTATION & FORMAL EXECUTION
--------------------------------------------------------------------------------
IN WITNESS WHEREOF, the parties hereto have executed this Subcontract Agreement
(A401-style structure) as of the day and year first written above.

CONTRACTOR: ${params.generalContractor}
By: ___________________________________       Date: ${params.formattedDate}
    Authorized Executive Officer

SUBCONTRACTOR: ${params.subName}
By: ___________________________________       Date: ${params.formattedDate}
    Authorized Corporate Principal

================================================================================
Generated autonomously via TradePulse Pro Procurement Platform
Generated draft based on the A401 article structure — not an AIA-licensed form
================================================================================`;
}
