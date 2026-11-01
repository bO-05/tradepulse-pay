/**
 * Plain-data inputs of the document builders. Loaders (inputs.ts) fill them from the database in
 * integer cents; the builders only lay them out, so a document can never drift from stored figures.
 */

export type G702Figures = {
  originalContractSumCents: number;
  netChangeOrdersCents: number;
  contractSumToDateCents: number;
  completedAndStoredCents: number;
  retainageCents: number;
  retainageWorkCents: number;
  retainageStoredCents: number;
  earnedLessRetainageCents: number;
  previousCertificatesCents: number;
  currentPaymentDueCents: number;
  balanceToFinishInclRetainageCents: number;
};

export type SheetLine = {
  item: string;
  description: string;
  scheduledValueCents: number;
  previousCents: number;
  thisPeriodCents: number;
  storedCents: number;
  totalCents: number;
  percentText: string;
  balanceCents: number;
  retainageCents: number;
};

export type SheetTotals = Omit<SheetLine, "item" | "description">;

export type SubPayAppInput = {
  gcName: string;
  subName: string;
  ownerName: string | null;
  projectTitle: string;
  projectAddress: string;
  agreementNumber: string;
  applicationNo: number | null;
  periodLabel: string;
  periodStart: string | null;
  periodEnd: string | null;
  dueDate: string | null;
  statusLabel: string;
  basisLabel: string;
  retainageBps: number;
  figures: G702Figures;
  lines: SheetLine[];
  totals: SheetTotals;
  changeOrders: { label: string; title: string; amountCents: number; approvedOn: string | null }[];
  approvedBy: string | null;
  approvedOn: string | null;
};

export type OwnerPayAppInput = {
  gcName: string;
  ownerName: string;
  projectTitle: string;
  projectAddress: string;
  applicationNo: number;
  periodStart: string;
  periodEnd: string;
  statusLabel: string;
  retainageBps: number;
  figures: G702Figures;
  lines: SheetLine[];
  totals: SheetTotals;
  submittedOn: string | null;
  approvedBy: string | null;
  approvedOn: string | null;
};

export type ChangeOrderInput = {
  scope: "subcontract" | "prime";
  number: number;
  label: string;
  title: string;
  description: string;
  amountCents: number;
  scheduleDays: number | null;
  statusLabel: string;
  projectTitle: string;
  projectAddress: string;
  /** Subcontract: GC and sub. Prime: owner and GC. */
  partyFrom: { role: string; name: string };
  partyTo: { role: string; name: string };
  contractRef: string;
  originalContractSumCents: number;
  previousContractSumCents: number;
  newContractSumCents: number;
  approved: boolean;
  approvedBy: string | null;
  approvedOn: string | null;
  requestedOn: string | null;
};

export type SubcontractInput = {
  agreementNumber: string;
  gcName: string;
  subName: string;
  projectTitle: string;
  projectAddress: string;
  trade: string;
  contractSumCents: number;
  retainageText: string;
  paymentTermsText: string;
  governingLaw: string | null;
  statusLabel: string;
  executedOn: string | null;
  contractText: string;
};

export type SovCsvInput = { lines: { lineNo: number; description: string; csiCode: string; scheduledValueCents: number }[] };

export type PayAppLinesCsvInput = { lines: SheetLine[]; totals: SheetTotals };

export type RetainageCsvInput = {
  rows: { date: string; reference: string; description: string; amountCents: number }[];
};

export type DocumentInput =
  | { kind: "sub_pay_app_pdf"; data: SubPayAppInput }
  | { kind: "owner_pay_app_pdf"; data: OwnerPayAppInput }
  | { kind: "change_order_pdf"; data: ChangeOrderInput }
  | { kind: "subcontract_pdf"; data: SubcontractInput }
  | { kind: "sov_csv"; data: SovCsvInput }
  | { kind: "pay_app_lines_csv"; data: PayAppLinesCsvInput }
  | { kind: "retainage_ledger_csv"; data: RetainageCsvInput };

/** A loaded input plus where it belongs and what to call the file. `asOf` fixes the PDF metadata dates. */
export type LoadedDocument = {
  projectId: string;
  fileName: string;
  asOf: number;
  input: DocumentInput;
};
