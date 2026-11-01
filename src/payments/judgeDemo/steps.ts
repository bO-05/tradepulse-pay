/**
 * Step statuses of the one-click judge demo, derived only from backend state (agreement ledger, GC
 * inbox and change orders), so the page shows what Convex and PayPal actually recorded.
 */
import { formatCents } from "../../../convex/lib/money";
import { changeOrderInvoiced } from "./changeOrderStep";

export const JUDGE_DEMO_AUTOSTART_KEY = "tradepulse.judgeDemo.autostart";

export type StepStatus = "todo" | "running" | "human" | "done" | "error";

export type DemoStepId =
  | "execute"
  | "fund"
  | "honest"
  | "agent"
  | "review"
  | "license"
  | "proposals"
  | "approve_honest"
  | "approve_agent"
  | "payout"
  | "change_order"
  | "dashboard"
  | "owner_pays";

export type DemoStep = { id: DemoStepId; label: string; status: StepStatus; detail: string };

type Proposal = {
  _id: string;
  kind: string;
  status: string;
  amountCents: number | null;
  editedAmountCents: number | null;
  flags: string[];
  licenseStatus: string | null;
  error: string | null;
};

export type DemoInboxItem = {
  payApp: {
    _id: string;
    status: string;
    requestedTotalCents: number;
    review: { engine: string; approvedTotalCents: number } | null;
    lines: { review: { verdict: string } | null }[];
  };
  license: { status: string; checkedAt: number } | null;
  proposals: Proposal[];
  payment: { status: string; grossCents: number; retainageCents: number; netCents: number } | null;
};

export type DemoLedger = {
  sov: { excludedScope: boolean }[];
  milestones: { name: string; status: string; funding: { status: string; grossCents: number; capturedCents?: number } | null }[];
  totals: { capturedCents: number; paidCents: number; retainageHeldCents: number; changeOrdersPaidCents: number };
};

export type DemoChangeOrder = { status: string; label: string; amountCents: number; payerViewUrl: string | null; error: string | null };

export type DemoState = {
  agreementStatus: string | null;
  ledger: DemoLedger | null;
  honest: DemoInboxItem | null;
  agent: DemoInboxItem | null;
  honestFiled: boolean;
  agentFiled: boolean;
  changeOrder: DemoChangeOrder | null;
  /** This agreement's totals as the AG Studio dashboard source reports them. */
  dashboardTotals?: DemoLedger["totals"] | null;
};

export const FUNDED_STATUSES = new Set(["authorized", "partially_captured", "captured"]);
const REVIEWED = new Set(["reviewed", "approved", "approved_as_noted", "revision_requested", "paid", "rejected"]);
const DECIDED = new Set(["approved", "executed", "failed"]);

export function moneyProposal(item: DemoInboxItem | null, kind: "capture" | "payout"): Proposal | null {
  return item?.proposals.find((p) => p.kind === kind) ?? null;
}

export function proposalsReady(item: DemoInboxItem | null): boolean {
  return moneyProposal(item, "payout") !== null && moneyProposal(item, "capture") !== null;
}

export function payoutFinished(item: DemoInboxItem | null): boolean {
  const p = moneyProposal(item, "payout");
  return p !== null && (p.status === "executed" || p.status === "failed");
}

const TOTAL_KEYS = ["capturedCents", "paidCents", "retainageHeldCents", "changeOrdersPaidCents"] as const;
const PAYOUT_SETTLED = new Set(["success", "unclaimed"]);

/** PayPal has settled the payout item (SUCCESS, or UNCLAIMED for a receiver without an account). */
export function payoutSettled(item: DemoInboxItem | null): boolean {
  return item?.payment != null && PAYOUT_SETTLED.has(item.payment.status);
}

function amountOf(p: Proposal | null): number | null {
  if (p === null) return null;
  return p.editedAmountCents ?? p.amountCents;
}

function reviewDetail(item: DemoInboxItem | null): string {
  const r = item?.payApp.review;
  if (!item || !r) return "waiting";
  const counts = new Map<string, number>();
  for (const l of item.payApp.lines) {
    const verdict = l.review?.verdict;
    if (verdict && verdict !== "ok") counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
  }
  const verdicts = counts.size ? [...counts].map(([v, n]) => `${v.replace(/_/g, " ")} ×${n}`).join(", ") : "all lines ok";
  return `${r.engine}: ${formatCents(r.approvedTotalCents)} of ${formatCents(item.payApp.requestedTotalCents)} approved (${verdicts})`;
}

function payoutDetail(item: DemoInboxItem | null): string {
  const pay = item?.payment;
  if (!pay) return "no payout yet";
  return `${formatCents(pay.grossCents)} gross → ${formatCents(pay.netCents)} net, ${formatCents(pay.retainageCents)} retainage (${pay.status})`;
}

export function deriveSteps(s: DemoState): DemoStep[] {
  const ledger = s.ledger;
  const executed = s.agreementStatus === "executed" && (ledger?.sov.length ?? 0) > 0 && (ledger?.milestones.length ?? 0) > 0;
  const mobilization = ledger?.milestones.find((m) => m.name === "Mobilization") ?? null;
  const funded = mobilization?.funding != null && FUNDED_STATUSES.has(mobilization.funding.status);
  const bothReviewed = REVIEWED.has(s.honest?.payApp.status ?? "") && REVIEWED.has(s.agent?.payApp.status ?? "");
  const license = s.agent?.license ?? s.honest?.license ?? null;
  const honestPayout = moneyProposal(s.honest, "payout");
  const agentPayout = moneyProposal(s.agent, "payout");
  const proposalError = [honestPayout, agentPayout].find((p) => p?.status === "failed");
  const co = s.changeOrder;
  const coInvoiced = changeOrderInvoiced(co);

  const dt = s.dashboardTotals ?? null;
  const dashboardMatches =
    dt !== null &&
    ledger !== null &&
    dt.paidCents > 0 &&
    payoutSettled(s.honest) &&
    payoutSettled(s.agent) &&
    TOTAL_KEYS.every((k) => dt[k] === ledger.totals[k]);

  const steps: DemoStep[] = [
    {
      id: "execute",
      label: "Execute the agreement; generate SOV and milestones",
      status: executed ? "done" : "todo",
      detail: executed
        ? `${ledger!.sov.length} SOV lines (${ledger!.sov.filter((l) => l.excludedScope).length} excluded scope), ${ledger!.milestones.length} milestones`
        : s.agreementStatus ?? "not started",
    },
    {
      id: "fund",
      label: "Fund Mobilization with PayPal (guest card approval)",
      status: funded ? "done" : executed ? "human" : "todo",
      detail: funded
        ? `Authorized ${formatCents(mobilization!.funding!.grossCents)} (${mobilization!.funding!.status})`
        : executed
          ? "Approve the PayPal checkout below with the sandbox guest card"
          : "waiting for execution",
    },
    {
      id: "honest",
      label: "sub1 files an honest pay app",
      status: s.honestFiled ? "done" : "todo",
      detail: s.honest ? `${formatCents(s.honest.payApp.requestedTotalCents)} requested · ${s.honest.payApp.status}` : "not filed",
    },
    {
      id: "agent",
      label: "Billing agent files an overbilled pay app (with excluded scope)",
      status: s.agentFiled ? "done" : "todo",
      detail: s.agent ? `${formatCents(s.agent.payApp.requestedTotalCents)} requested · ${s.agent.payApp.status}` : "not filed",
    },
    {
      id: "review",
      label: "AI review of both pay apps (code computes every dollar)",
      status: bothReviewed ? "done" : s.honestFiled || s.agentFiled ? "running" : "todo",
      detail: `Honest: ${reviewDetail(s.honest)} · Agent: ${reviewDetail(s.agent)}`,
    },
    {
      id: "license",
      label: "KERNEL CSLB license check",
      status: license ? (license.status === "active" ? "done" : "error") : s.agentFiled ? "running" : "todo",
      detail: license ? `CSLB status ${license.status}, checked ${new Date(license.checkedAt).toLocaleTimeString()}` : "waiting",
    },
    {
      id: "proposals",
      label: "Pay agent proposals (capture + payout) in the GC inbox",
      status: proposalsReady(s.honest) && proposalsReady(s.agent) ? "done" : bothReviewed ? "running" : "todo",
      detail: `Honest payout ${amountOf(honestPayout) !== null ? formatCents(amountOf(honestPayout)!) : "—"} · Agent payout ${
        agentPayout?.amountCents != null ? formatCents(agentPayout.amountCents) : "—"
      }`,
    },
    {
      id: "approve_honest",
      label: "GC approves the honest pay app as proposed",
      status: honestPayout && DECIDED.has(honestPayout.status) ? (honestPayout.status === "failed" ? "error" : "done") : "todo",
      detail: honestPayout ? `payout proposal ${honestPayout.status}${honestPayout.error ? `: ${honestPayout.error}` : ""}` : "waiting",
    },
    {
      id: "approve_agent",
      label: "GC edits the agent's proposal down and approves",
      status: agentPayout && DECIDED.has(agentPayout.status) ? (agentPayout.status === "failed" ? "error" : "done") : "todo",
      detail: agentPayout
        ? `${agentPayout.editedAmountCents !== null ? `edited ${formatCents(agentPayout.amountCents ?? 0)} → ${formatCents(agentPayout.editedAmountCents)}` : "not edited yet"} · ${agentPayout.status}${
            agentPayout.error ? `: ${agentPayout.error}` : ""
          }`
        : "waiting",
    },
    {
      id: "payout",
      label: "PayPal capture + payout to sub1 with 10% retainage held",
      status: proposalError
        ? "error"
        : payoutSettled(s.honest) && payoutSettled(s.agent)
          ? "done"
          : payoutFinished(s.honest) || payoutFinished(s.agent)
            ? "running"
            : "todo",
      detail: `Honest: ${payoutDetail(s.honest)} · Agent: ${payoutDetail(s.agent)}${
        ledger ? ` · Ledger: captured ${formatCents(ledger.totals.capturedCents)}, paid ${formatCents(ledger.totals.paidCents)}, retainage held ${formatCents(ledger.totals.retainageHeldCents)}` : ""
      }`,
    },
    {
      id: "change_order",
      label: "Change-order invoice to the Owner (PayPal Invoicing)",
      status: coInvoiced ? "done" : co?.error ? "error" : "todo",
      detail: co ? `${co.label} ${formatCents(co.amountCents)} · ${co.status}${co.error ? `: ${co.error}` : ""}` : "not created",
    },
    {
      id: "dashboard",
      label: "Dashboard shows the new totals (same figures as the ledger)",
      status: dashboardMatches ? "done" : s.dashboardTotals === undefined || s.dashboardTotals === null ? "todo" : "running",
      detail: s.dashboardTotals
        ? `Dashboard: captured ${formatCents(s.dashboardTotals.capturedCents)}, paid ${formatCents(s.dashboardTotals.paidCents)}, retainage held ${formatCents(
            s.dashboardTotals.retainageHeldCents,
          )}, change orders paid ${formatCents(s.dashboardTotals.changeOrdersPaidCents)}${dashboardMatches ? " · matches the ledger" : ""}`
        : "waiting",
    },
    {
      id: "owner_pays",
      label: "Owner pays the invoice (human step in the Owner's browser)",
      status: co?.status === "paid" ? "done" : coInvoiced ? "human" : "todo",
      detail: co?.status === "paid" ? "Invoice paid" : coInvoiced ? "Sign in as the Owner and pay, then Refresh status" : "waiting",
    },
  ];
  return steps;
}
