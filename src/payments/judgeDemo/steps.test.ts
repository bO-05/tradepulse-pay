import { describe, expect, test } from "vitest";
import { deriveSteps, payoutFinished, proposalsReady, type DemoInboxItem, type DemoLedger, type DemoState } from "./steps";

const ledger = (fundingStatus: string | null): DemoLedger => ({
  sov: [{ excludedScope: false }, { excludedScope: true }],
  milestones: [
    { name: "Mobilization", status: "pending", funding: fundingStatus ? { status: fundingStatus, grossCents: 595_000 } : null },
    { name: "Rough-in", status: "pending", funding: null },
  ],
  totals: { capturedCents: 0, paidCents: 0, retainageHeldCents: 0, changeOrdersPaidCents: 0 },
});

const item = (payoutStatus: string | null, payAppStatus = "reviewed"): DemoInboxItem => ({
  payApp: {
    _id: "p",
    status: payAppStatus,
    requestedTotalCents: 100_000,
    review: { engine: "Anthropic", approvedTotalCents: 80_000 },
    lines: [{ review: { verdict: "ok" } }, { review: { verdict: "excluded_scope" } }],
  },
  license: { status: "active", checkedAt: 0 },
  proposals:
    payoutStatus === null
      ? []
      : [
          { _id: "c", kind: "capture", status: "pending", amountCents: 80_000, editedAmountCents: null, flags: [], licenseStatus: "active", error: null },
          { _id: "o", kind: "payout", status: payoutStatus, amountCents: 72_000, editedAmountCents: null, flags: [], licenseStatus: "active", error: null },
        ],
  payment: null,
});

const base: DemoState = {
  agreementStatus: "generated",
  ledger: null,
  honest: null,
  agent: null,
  honestFiled: false,
  agentFiled: false,
  changeOrder: null,
};

const status = (s: DemoState) => Object.fromEntries(deriveSteps(s).map((x) => [x.id, x.status]));

describe("judge demo steps", () => {
  test("nothing done before execution", () => {
    const st = status(base);
    expect(st.execute).toBe("todo");
    expect(st.fund).toBe("todo");
  });

  test("funding is a human step once executed, done once PayPal authorizes", () => {
    expect(status({ ...base, agreementStatus: "executed", ledger: ledger(null) }).fund).toBe("human");
    const st = status({ ...base, agreementStatus: "executed", ledger: ledger("authorized") });
    expect(st.execute).toBe("done");
    expect(st.fund).toBe("done");
  });

  test("review and proposals reflect both pay apps", () => {
    const s: DemoState = { ...base, agreementStatus: "executed", ledger: ledger("authorized"), honestFiled: true, agentFiled: true, honest: item("pending"), agent: item(null, "submitted") };
    const st = status(s);
    expect(st.review).toBe("running");
    expect(st.proposals).toBe("todo");
    const both = status({ ...s, agent: item("pending") });
    expect(both.review).toBe("done");
    expect(both.proposals).toBe("done");
    expect(both.license).toBe("done");
    const detail = deriveSteps({ ...s, agent: item("pending") }).find((x) => x.id === "review")!.detail;
    expect(detail).toContain("excluded scope ×1");
  });

  test("payout and owner steps", () => {
    expect(payoutFinished(item("executed"))).toBe(true);
    expect(payoutFinished(item("approved"))).toBe(false);
    expect(proposalsReady(item(null))).toBe(false);
    const s: DemoState = {
      ...base,
      agreementStatus: "executed",
      ledger: ledger("captured"),
      honestFiled: true,
      agentFiled: true,
      honest: item("executed"),
      agent: item("failed"),
      changeOrder: { status: "invoiced", label: "CO-001", amountCents: 185_000, payerViewUrl: "https://x", error: null },
    };
    const st = status(s);
    expect(st.payout).toBe("error");
    expect(st.approve_agent).toBe("error");
    expect(st.change_order).toBe("done");
    expect(st.owner_pays).toBe("human");
    expect(status({ ...s, changeOrder: { ...s.changeOrder!, status: "paid" } }).owner_pays).toBe("done");

    const paid = (st: string): DemoInboxItem => ({ ...item("executed"), payment: { status: st, grossCents: 1000, retainageCents: 100, netCents: 900 } });
    expect(status({ ...s, honest: paid("pending"), agent: paid("success") }).payout).toBe("running");
    expect(status({ ...s, honest: paid("success"), agent: paid("success") }).payout).toBe("done");

    const totals = { capturedCents: 2_000, paidCents: 1_800, retainageHeldCents: 200, changeOrdersPaidCents: 0 };
    const settled: DemoState = { ...s, honest: paid("success"), agent: paid("success"), ledger: { ...ledger("captured"), totals } };
    expect(status({ ...settled, dashboardTotals: undefined }).dashboard).toBe("todo");
    expect(status({ ...settled, dashboardTotals: { ...totals, paidCents: 900 } }).dashboard).toBe("running");
    expect(status({ ...settled, dashboardTotals: { ...totals } }).dashboard).toBe("done");
  });
});
