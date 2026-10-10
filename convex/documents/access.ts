import type { Doc } from "../_generated/dataModel";
import { visibleToParty } from "../billing/changeOrderView";
import { notFound, type ProjectAccess } from "../lib/tenancy";
import type { DocumentKind } from "./kinds";

/**
 * Visibility rules a document adds on top of requireDocScope on its related record (which already
 * limits subs to their own vendor's records and keeps owners off subcontract detail): sub pay app
 * drafts stay with the sub, owner pay app drafts with the GC, and change-order drafts with the party
 * drafting them. Every refusal is the same "Not found.".
 */
export function assertDocumentVisible(
  kind: DocumentKind,
  scope: ProjectAccess & { doc: Doc<"payApplications"> | Doc<"ownerPayApps"> | Doc<"changeOrders"> | Doc<"agreements"> },
): void {
  const party = scope.partyRole;
  if (kind === "sub_pay_app_pdf" || kind === "pay_app_lines_csv") {
    if ((scope.doc as Doc<"payApplications">).status === "draft" && party !== "sub") throw notFound();
  } else if (kind === "owner_pay_app_pdf") {
    if (party !== "gc" && party !== "owner") throw notFound();
    if ((scope.doc as Doc<"ownerPayApps">).status === "draft" && party !== "gc") throw notFound();
  } else if (kind === "change_order_pdf") {
    if (!visibleToParty(scope.doc as Doc<"changeOrders">, party)) throw notFound();
  } else if (party === "owner") {
    throw notFound();
  }
}
