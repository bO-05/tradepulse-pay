import { useAction, useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { DEMO_CHANGE_ORDER, demoEditedApprovalCents } from "../../../convex/judgeDemo/scenario";
import { readableError } from "../FundMilestone";
import { changeOrderInvoiced, ensureChangeOrderInvoiced, type DriverChangeOrder } from "./changeOrderStep";
import { FUNDED_STATUSES, moneyProposal, payoutFinished, proposalsReady, type DemoInboxItem, type DemoLedger } from "./steps";

export type DriverSnapshot = {
  run: { _id: Id<"judgeDemoRuns">; agreementId: Id<"agreements">; agreementStatus: string } | null | undefined;
  ledger: DemoLedger | null | undefined;
  honest: DemoInboxItem | null;
  agent: DemoInboxItem | null;
  /** undefined while loading; null when the agreement has no change order yet. */
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
  const editProposal = useMutation(api.payApps.proposals.editProposal);
  const createChangeOrder = useAction(api.payments.invoices.createChangeOrder);
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

  async function waitFor<T>(what: string, pick: (s: DriverSnapshot) => T | null | undefined, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!alive.current) throw new Error("The demo page was closed; click Continue to resume.");
      const value = pick(latest.current);
      if (value !== null && value !== undefined) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Click Continue to keep waiting.`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
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
      const run = await waitFor("the demo run", (s) => (s.run?._id === id ? s.run : null), 20_000);

      if (run.agreementStatus !== "executed") {
        setPhase("Executing the agreement…");
        await executeAgreement({ agreementId: run.agreementId });
      }
      await waitFor("the schedule of values", (s) => (s.ledger && s.ledger.milestones.length > 0 ? true : null), 30_000);

      setPhase("Waiting for the GC to approve the Mobilization funding in PayPal…");
      await waitFor(
        "the PayPal funding approval",
        (s) => {
          const m = s.ledger?.milestones.find((x) => x.name === "Mobilization");
          return m?.funding && FUNDED_STATUSES.has(m.funding.status) ? true : null;
        },
        20 * MINUTE,
      );

      setPhase("Filing the two pay applications…");
      await fileDemoPayApp({ runId: id, kind: "honest" });
      await fileDemoPayApp({ runId: id, kind: "agent" });

      setPhase("AI review, KERNEL license check and pay-agent proposals are running…");
      const honest = await waitFor("the honest pay app's proposals", (s) => (proposalsReady(s.honest) ? s.honest : null), 5 * MINUTE);
      const honestPayout = moneyProposal(honest, "payout")!;
      if (honestPayout.status === "pending") {
        setPhase("GC approves the honest pay app as proposed…");
        await approveProposal({ proposalId: honestPayout._id });
      }
      setPhase("Capturing and paying the honest pay app…");
      await waitFor("the honest payout", (s) => (payoutFinished(s.honest) ? true : null), 3 * MINUTE);

      const agent = await waitFor("the agent pay app's proposals", (s) => (proposalsReady(s.agent) ? s.agent : null), 5 * MINUTE);
      const agentPayout = moneyProposal(agent, "payout")!;
      if (agentPayout.status === "pending") {
        const edited = agentPayout.editedAmountCents ?? demoEditedApprovalCents(agentPayout.amountCents ?? 0);
        if (edited !== null && agentPayout.editedAmountCents === null) {
          setPhase("GC edits the agent's proposal down…");
          await editProposal({ proposalId: agentPayout._id, amountCents: edited });
        }
        setPhase("GC approves the edited amount…");
        await approveProposal({ proposalId: agentPayout._id });
      }
      setPhase("Capturing and paying the edited amount…");
      await waitFor("the agent payout", (s) => (payoutFinished(s.agent) ? true : null), 3 * MINUTE);

      await ensureChangeOrderInvoiced<Id<"changeOrders">>({
        current: async () => (await waitFor("the change orders", (s) => (s.changeOrder === undefined ? null : { co: s.changeOrder }), 20_000)).co,
        create: () => createChangeOrder({ agreementId: run.agreementId, ...DEMO_CHANGE_ORDER }),
        resume: (changeOrderId) => sendChangeOrderInvoice({ changeOrderId }),
        waitInvoiced: () => waitFor("the sent change-order invoice", (s) => (changeOrderInvoiced(s.changeOrder ?? null) ? true : null), 30_000).then(() => undefined),
        onPhase: setPhase,
      });
      setPhase("Done. The Owner can now pay the invoice; the dashboard shows the new totals.");
    } catch (e) {
      setError(readableError(e));
      setPhase(null);
    } finally {
      if (alive.current) setRunning(false);
    }
  }

  return { drive, running, phase, error };
}
