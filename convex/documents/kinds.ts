import { v, type Infer } from "convex/values";

/**
 * Generated billing documents (architecture §16): what each kind is generated from and which
 * parties of the project may download it. Every kind here is billing data, so it is stored as
 * `restricted` and served only through the authenticated download route.
 */

export const documentKindValidator = v.union(
  v.literal("sub_pay_app_pdf"),
  v.literal("owner_pay_app_pdf"),
  v.literal("change_order_pdf"),
  v.literal("subcontract_pdf"),
  v.literal("sov_csv"),
  v.literal("pay_app_lines_csv"),
  v.literal("retainage_ledger_csv"),
);
export type DocumentKind = Infer<typeof documentKindValidator>;

export const documentSensitivityValidator = v.union(v.literal("project"), v.literal("restricted"));

export const documentRelatedTableValidator = v.union(
  v.literal("payApplications"),
  v.literal("ownerPayApps"),
  v.literal("changeOrders"),
  v.literal("agreements"),
);
export type DocumentRelatedTable = Infer<typeof documentRelatedTableValidator>;

type Party = "gc" | "sub" | "owner";

export type KindConfig = {
  table: DocumentRelatedTable;
  roles: readonly Party[];
  contentType: "application/pdf" | "text/csv; charset=utf-8";
  label: string;
};

export const DOCUMENT_KINDS: Record<DocumentKind, KindConfig> = {
  sub_pay_app_pdf: { table: "payApplications", roles: ["gc", "sub"], contentType: "application/pdf", label: "Pay app PDF (G702/G703-style)" },
  pay_app_lines_csv: { table: "payApplications", roles: ["gc", "sub"], contentType: "text/csv; charset=utf-8", label: "Pay app lines CSV" },
  owner_pay_app_pdf: { table: "ownerPayApps", roles: ["gc", "owner"], contentType: "application/pdf", label: "Owner pay app PDF" },
  change_order_pdf: { table: "changeOrders", roles: ["gc", "sub", "owner"], contentType: "application/pdf", label: "Change order PDF" },
  subcontract_pdf: { table: "agreements", roles: ["gc", "sub"], contentType: "application/pdf", label: "Subcontract PDF" },
  sov_csv: { table: "agreements", roles: ["gc", "sub"], contentType: "text/csv; charset=utf-8", label: "Schedule of values CSV" },
  retainage_ledger_csv: { table: "agreements", roles: ["gc", "sub"], contentType: "text/csv; charset=utf-8", label: "Retainage ledger CSV" },
};

export const DOCUMENT_DOWNLOAD_PREFIX = "/api/documents/";

export function documentDownloadPath(documentId: string): string {
  return `${DOCUMENT_DOWNLOAD_PREFIX}${encodeURIComponent(documentId)}`;
}
