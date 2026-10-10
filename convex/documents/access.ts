import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { visibleToParty } from "../billing/changeOrderView";
import { notFound, type ProjectAccess } from "../lib/tenancy";
import { sovIsApproved } from "../payments/sov";
import { inputsHashOf, loadDocument } from "./inputs";
import type { DocumentKind } from "./kinds";

type RelatedScope = ProjectAccess & { doc: Doc<"payApplications"> | Doc<"ownerPayApps"> | Doc<"changeOrders"> | Doc<"agreements"> };

/**
 * Visibility rules a document adds on top of requireDocScope on its related record (which already
 * limits subs to their own vendor's records and keeps owners off subcontract detail): sub pay app
 * drafts stay with the sub, owner pay app drafts with the GC, change-order drafts with the party
 * drafting them, and a draft SOV with the GC (subs read the SOV only once it is approved, as in
 * getSov). Every refusal is the same "Not found.".
 */
export function assertDocumentVisible(kind: DocumentKind, scope: RelatedScope): void {
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
  } else if (kind === "sov_csv" && party !== "gc" && !sovIsApproved(scope.doc as Doc<"agreements">)) {
    throw notFound();
  }
}

/**
 * assertDocumentVisible for an already-stored file. A sub may hold an SOV CSV only when it shows the
 * approved schedule as it stands now, so a file the GC exported from an earlier draft stays with the GC
 * even after a later approval.
 */
export async function assertStoredDocumentVisible(ctx: QueryCtx, doc: Doc<"documents">, scope: RelatedScope): Promise<void> {
  assertDocumentVisible(doc.kind, scope);
  if (doc.kind === "sov_csv" && scope.partyRole !== "gc") {
    const current = await inputsHashOf(await loadDocument(ctx, doc.kind, scope.doc));
    if (doc.inputsHash !== current) throw notFound();
  }
}
