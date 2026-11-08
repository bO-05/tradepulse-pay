import { useAction, useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { demoLineCut } from "../../../convex/judgeDemo/scenario";
import { readableError } from "../FundMilestone";
import { formatCents } from "../format";
import { changeOrderInvoiced, ensureChangeOrderInvoiced, type DriverChangeOrder } from "./changeOrderStep";
import { demoRunBlocker, FUNDED_STATUSES, moneyProposal, payoutFinished, proposalsReady, type DemoInboxItem, type DemoLedger } from "./steps";

export type DriverSnapshot = {
  run: { _id: Id<"judgeDemoRuns">; agreementId: Id<"agreements">; agreementStatus: string } | null | undefined;
  ledger: DemoLedger | null | undefined;
  honest: DemoInboxItem | null;
  agent: DemoInboxItem | null;
  /** undefined while loading; null when the run has no change order yet. */
  changeOrder: (DriverChangeOrder & { _id: Id<"changeOrders"> }) | null | undefined;
};

const POLL_MS = 500;
const MINUTE = 60_000;

/**
 * Drives the judge demo through the app's real functions, one step at a time. Each wait reads the
 * reactive query results (never a local guess), so a reload or a second click resumes where the
 * backend is. Human steps (PayPal approval, the Owner paying) are waited for, never simulated.
 */
export function useJudgeDemoDriver(snapshot: DriverSnapshot, onRunCreated: (runId: Id<"judgeDemoRuns">) => void) {
  const startRun = useMutation(api.judgeDemo.runs.startRun);
  const executeAgreement = useMutation(api.agreements.executeAgreement);
  const fileDemoPayApp = useMutation(api.judgeDemo.runs.fileDemoPayApp);
  const approveProposal = useMutation(api.payApps.proposals.approveProposal);
  const decidePayApp = useMutation(api.payApps.decisions.decidePayApp);
  const prepareDemoChangeOrder = useMutation(api.judgeDemo.runs.prepareDemoChangeOrder);
  const sendChangeOrderInvoice = useAction(api.payments.invoices.sendChangeOrderInvoice);

  const latest = useRef(snapshot);
  latest.current = snapshot;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function waitFor<T>(what: string, pick: (s: DriverSnapshot) => T | null | undefined, timeoutMs: number, expectedRunId: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!alive.current) throw new Error("The demo page was closed; click Continue to resume.");
      const value = latest.current.run?._id === expectedRunId ? pick(latest.current) : null;
      if (value !== null && value !== undefined) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Click Continue to keep waiting.`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  function checkedItem(item: DemoInboxItem | null): DemoInboxItem | null {
    const blocker = demoRunBlocker(item);
    if (blocker) throw new Error(blocker);
    return item;
  }

  async function drive(fresh: boolean) {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      let runId = fresh ? undefined : latest.current.run?._id;
      if (runId === undefined) {
        setPhase("Creating the demo award for sub1's contractor…");
        const created = await startRun({});
        runId = created.runId;
        onRunCreated(created.runId);
      }
      const id = runId;
      // Continuing a pre-existing run must pin it too, before any funding/proposal observation.
      onRunCreated(id);
      const run = await waitFor("the demo run", (s) => s.run, 20_000, id);

      if (run.agreementStatus !== "executed") {
        setPhase("Executing the agreement…");
        await executeAgreement({ agreementId: run.agreementId });
      }
      await waitFor("the schedule of values", (s) => (s.ledger && s.ledger.milestones.length > 0 ? true : null), 30_000, id);

      setPhase("Waiting for the GC to approve the Mobilization funding in PayPal…");
      await waitFor(
        "the PayPal funding approval",
        (s) => {
          const m = s.ledger?.milestones.find((x) => x.name === "Mobilization");
          return m?.funding && FUNDED_STATUSES.has(m.funding.status) ? true : null;
        },
        20 * MINUTE,
        id,
      );

      setPhase("Filing the two pay applications…");
      await fileDemoPayApp({ runId: id, kind: "honest" });
      await fileDemoPayApp({ runId: id, kind: "agent" });

      setPhase("Rules review, license check and pay-agent proposals are running…");
      const honest = await waitFor("the honest pay app's proposals", (s) => {
        const item = checkedItem(s.honest);
        return proposalsReady(item) ? item : null;
      }, 5 * MINUTE, id);
      const honestPayout = moneyProposal(honest, "payout")!;
      if (honestPayout.status === "pending") {
        setPhase("GC approves the honest pay app as proposed…");
        await approveProposal({ proposalId: honestPayout._id });
      }
      setPhase("Capturing and paying the honest pay app…");
      await waitFor("the honest payout submission", (s) => (payoutFinished(checkedItem(s.honest)) ? true : null), 3 * MINUTE, id);

      const agent = await waitFor("the agent pay app's proposals", (s) => {
        const item = checkedItem(s.agent);
        return proposalsReady(item) ? item : null;
      }, 5 * MINUTE, id);
      const agentPayout = moneyProposal(agent, "payout")!;
      // N-10: cut the line the review flagged, by that line's own dollars. The reason states those
      // dollars; the pay-app total is never scaled by a percentage and no other line is reduced.
      const cut = demoLineCut(agent.payApp.lines);
      if (cut !== null && agent.payApp.status === "reviewed") {
        setPhase(`GC cuts line ${cut.lineNo} by ${formatCents(cut.cutCents)} and approves every other line at the review's amount…`);
        await decidePayApp({
          payAppId: agent.payApp._id,
          decision: "approve",
          lines: [{ sovLineId: cut.sovLineId, action: "override", amountCents: cut.approvedCents, reason: cut.reason }],
        });
      }
      if (agentPayout.status === "pending") {
        setPhase("GC approves the capture and payout at the line-specific approved amount…");
        await approveProposal({ proposalId: agentPayout._id });
      }
      setPhase("Capturing and paying the approved amount…");
      await waitFor("the agent payout submission", (s) => (payoutFinished(checkedItem(s.agent)) ? true : null), 3 * MINUTE, id);

      await ensureChangeOrderInvoiced<Id<"changeOrders">>({
        current: async () => (await waitFor("the change orders", (s) => (s.changeOrder === undefined ? null : { co: s.changeOrder }), 20_000, id)).co,
        create: async () => {
          const changeOrderId = await prepareDemoChangeOrder({ runId: id });
          return await sendChangeOrderInvoice({ changeOrderId });
        },
        resume: (changeOrderId) => sendChangeOrderInvoice({ changeOrderId }),
        waitInvoiced: () => waitFor("the sent change-order invoice", (s) => (changeOrderInvoiced(s.changeOrder ?? null) ? true : null), 30_000, id).then(() => undefined),
        onPhase: setPhase,
      });
      checkedItem(latest.current.honest);
      checkedItem(latest.current.agent);
      setPhase(`Payout requests and the change-order invoice were submitted. Check the steps below for actual PayPal settlement and dashboard totals. ${latest.current.changeOrder?.status === "paid" ? "The Owner invoice is paid." : "The Owner still needs to pay the invoice."}`);
    } catch (e) {
      setError(readableError(e));
      setPhase(null);
    } finally {
      if (alive.current) setRunning(false);
    }
  }

  return { drive, running, phase, error };
}
