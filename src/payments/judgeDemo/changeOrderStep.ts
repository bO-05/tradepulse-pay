/** The demo's prime change order as the driver needs it (the run's change order). */
export type DriverChangeOrder = { _id: string; status: string; payerViewUrl: string | null };

/** The change order is invoiced only when PayPal sent (or the Owner paid) the invoice and a payer URL exists. */
export function changeOrderInvoiced(co: Pick<DriverChangeOrder, "status" | "payerViewUrl"> | null): boolean {
  return co !== null && (co.status === "invoiced" || co.status === "paid") && co.payerViewUrl !== null;
}

export type ChangeOrderStepDeps<Id extends string> = {
  /** Resolves to the current change order (null when none exists yet), read from the backend. */
  current: () => Promise<(DriverChangeOrder & { _id: Id }) | null>;
  create: () => Promise<unknown>;
  resume: (changeOrderId: Id) => Promise<unknown>;
  /** Waits until the backend shows the change order invoiced; rejects on timeout. */
  waitInvoiced: () => Promise<void>;
  onPhase?: (phase: string) => void;
};

/**
 * Ensures the demo's change-order invoice is sent. `create` records the prime change order approved for
 * the demo owner and then invoices it, so an interrupted run can leave an approved change order without
 * an invoice; that one is resumed through sendChangeOrderInvoice (whose request ids prevent a second
 * invoice), never counted as done.
 */
export async function ensureChangeOrderInvoiced<Id extends string>(deps: ChangeOrderStepDeps<Id>): Promise<"created" | "resumed" | "already"> {
  const co = await deps.current();
  if (changeOrderInvoiced(co)) return "already";
  let outcome: "created" | "resumed";
  if (co === null) {
    deps.onPhase?.("Invoicing a change order to the Owner…");
    await deps.create();
    outcome = "created";
  } else if (co.status === "approved") {
    deps.onPhase?.("Resuming the change-order invoice to the Owner…");
    await deps.resume(co._id);
    outcome = "resumed";
  } else {
    throw new Error(`The demo change order is ${co.status} without a payer link, so it cannot be invoiced.`);
  }
  await deps.waitInvoiced();
  return outcome;
}
