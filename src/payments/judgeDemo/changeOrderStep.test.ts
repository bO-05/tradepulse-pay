import { describe, expect, test, vi } from "vitest";
import { changeOrderInvoiced, ensureChangeOrderInvoiced, type DriverChangeOrder } from "./changeOrderStep";
import { deriveSteps, type DemoState } from "./steps";

/** A fake backend that mirrors prepareDemoChangeOrder + sendChangeOrderInvoice: the approved row is committed before the PayPal invoice call. */
function fakeBackend() {
  const state: { co: DriverChangeOrder | null; failInvoice: boolean } = { co: null, failInvoice: false };
  const invoice = async () => {
    if (state.failInvoice) throw new Error("Invoice not sent: network error");
    state.co = { ...state.co!, status: "invoiced", payerViewUrl: "https://www.sandbox.paypal.com/invoice/p/#INV2-TEST" };
  };
  const create = vi.fn(async () => {
    state.co = { _id: "co1", status: "approved", payerViewUrl: null };
    await invoice();
  });
  const resume = vi.fn(async (id: string) => {
    expect(id).toBe("co1");
    await invoice();
  });
  const deps = {
    current: async () => state.co,
    create,
    resume,
    waitInvoiced: async () => {
      if (!changeOrderInvoiced(state.co)) throw new Error("Timed out waiting for the sent change-order invoice.");
    },
  };
  return { state, deps, create, resume };
}

const demoState = (co: DriverChangeOrder | null): DemoState => ({
  agreementStatus: "executed",
  ledger: null,
  honest: null,
  agent: null,
  honestFiled: true,
  agentFiled: true,
  changeOrder: co ? { ...co, label: "CO-001", amountCents: 250_000, error: null } : null,
});
const coStep = (co: DriverChangeOrder | null) => deriveSteps(demoState(co)).find((s) => s.id === "change_order")!;

describe("judge demo change-order step", () => {
  test("an interrupted invoice creation leaves an approved change order that continuation resumes instead of reporting Done", async () => {
    const b = fakeBackend();
    b.state.failInvoice = true;
    await expect(ensureChangeOrderInvoiced(b.deps)).rejects.toThrow(/Invoice not sent/);
    expect(b.state.co).toMatchObject({ status: "approved", payerViewUrl: null });
    expect(coStep(b.state.co).status).not.toBe("done");

    b.state.failInvoice = false;
    expect(await ensureChangeOrderInvoiced(b.deps)).toBe("resumed");
    expect(b.create).toHaveBeenCalledTimes(1);
    expect(b.resume).toHaveBeenCalledTimes(1);
    expect(b.state.co).toMatchObject({ status: "invoiced" });
    expect(coStep(b.state.co).status).toBe("done");
  });

  test("continuation does not finish while the resumed invoice is still unsent", async () => {
    const b = fakeBackend();
    b.state.co = { _id: "co1", status: "approved", payerViewUrl: null };
    b.resume.mockImplementationOnce(async () => undefined);
    await expect(ensureChangeOrderInvoiced(b.deps)).rejects.toThrow(/Timed out/);
    expect(b.create).not.toHaveBeenCalled();
  });

  test("creates the change order when none exists and skips work once invoiced", async () => {
    const b = fakeBackend();
    expect(await ensureChangeOrderInvoiced(b.deps)).toBe("created");
    expect(await ensureChangeOrderInvoiced(b.deps)).toBe("already");
    expect(b.create).toHaveBeenCalledTimes(1);
    expect(b.resume).not.toHaveBeenCalled();
  });

  test("Done needs a sent or paid invoice and a payer URL", () => {
    expect(changeOrderInvoiced({ status: "draft", payerViewUrl: null })).toBe(false);
    expect(changeOrderInvoiced({ status: "invoiced", payerViewUrl: null })).toBe(false);
    expect(changeOrderInvoiced({ status: "cancelled", payerViewUrl: "https://x" })).toBe(false);
    expect(changeOrderInvoiced({ status: "invoiced", payerViewUrl: "https://x" })).toBe(true);
    expect(changeOrderInvoiced({ status: "paid", payerViewUrl: "https://x" })).toBe(true);
  });
});
