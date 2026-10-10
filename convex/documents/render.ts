import { buildPayAppLinesCsv, buildRetainageCsv, buildSovCsv } from "./csvExports";
import type { LoadedDocument } from "./inputTypes";
import { DOCUMENT_KINDS } from "./kinds";
import { buildChangeOrderPdf, buildOwnerPayAppPdf, buildSubPayAppPdf, buildSubcontractPdf } from "./pdfs";

/** The file bytes of a loaded document (pure: same input, same bytes). */
export async function renderDocumentBytes(doc: LoadedDocument): Promise<{ bytes: Uint8Array; contentType: string }> {
  const contentType = DOCUMENT_KINDS[doc.input.kind].contentType;
  const text = (s: string) => ({ bytes: new TextEncoder().encode(s), contentType });
  const input = doc.input;
  switch (input.kind) {
    case "sub_pay_app_pdf":
      return { bytes: await buildSubPayAppPdf(input.data, doc.asOf), contentType };
    case "owner_pay_app_pdf":
      return { bytes: await buildOwnerPayAppPdf(input.data, doc.asOf), contentType };
    case "change_order_pdf":
      return { bytes: await buildChangeOrderPdf(input.data, doc.asOf), contentType };
    case "subcontract_pdf":
      return { bytes: await buildSubcontractPdf(input.data, doc.asOf), contentType };
    case "sov_csv":
      return text(buildSovCsv(input.data));
    case "pay_app_lines_csv":
      return text(buildPayAppLinesCsv(input.data));
    case "retainage_ledger_csv":
      return text(buildRetainageCsv(input.data));
  }
}
