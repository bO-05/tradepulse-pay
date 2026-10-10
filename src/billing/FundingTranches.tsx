import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { calendarDateToMs, isCalendarDate, plannedDateWarning, projectStartMs } from "../../convex/billing/trancheRules";
import { getErrorMessage } from "../lib/errors";
import { FundMilestoneControl, FundingStatus } from "../payments/FundMilestone";
import { ReleaseList } from "../payments/ReleaseMilestone";
import { Button, ConfirmDialog, DateInput, MoneyInput, StatusPill, TextInput, formatCents } from "../ui";

type Ledger = NonNullable<FunctionReturnType<typeof api.payments.ledger.getAgreementLedger>>;
type LedgerMilestone = Ledger["milestones"][number];
type TrancheList = NonNullable<FunctionReturnType<typeof api.billing.tranches.listTranches>>;
type Tranche = TrancheList["tranches"][number];

const TRANCHE_STATUS: Record<string, string> = {
  planned: "Not funded",
  funding: "Checkout started",
  funded: "Funded",
  in_progress: "Partly paid out",
  complete: "Closed",
  paid: "Paid out",
  funding_expired: "Funding expired",
};

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcDateLabel(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function dateWarning(value: string, projectStartDate: string | null): string | null {
  if (!isCalendarDate(value)) return null;
  return plannedDateWarning(calendarDateToMs(value), projectStartMs({ startDate: projectStartDate ?? undefined }));
}

/**
 * GC-defined funding tranches on the agreement ledger. The GC adds, edits, reorders and deletes
 * tranches until they are funded, and funds each through PayPal; nothing here pays the sub. Payments
 * are made from an approved pay app's Payment panel.
 */
export function FundingTranches({ agreementId, ledgerMilestones, isGc }: { agreementId: string; ledgerMilestones: LedgerMilestone[]; isGc: boolean }) {
  const list = useQuery(api.billing.tranches.listTranches, { agreementId });
  const byId = new Map(ledgerMilestones.map((m) => [m._id as string, m]));
  if (list === undefined) {
    return (
      <p className="text-sm text-slate-400" role="status">
        Loading tranches…
      </p>
    );
  }
  if (list === null) return null;
  const remaining = list.contractSumToDateCents - list.trancheTotalCents;

  return (
    <div className="space-y-4" data-testid="funding-tranches">
      <p className="text-sm text-slate-300" data-testid="tranche-totals">
        Tranches total <span className="font-semibold tabular-nums">{formatCents(list.trancheTotalCents)}</span> of the contract sum to date{" "}
        <span className="font-semibold tabular-nums">{formatCents(list.contractSumToDateCents)}</span>
        {remaining > 0 ? ` (${formatCents(remaining)} not yet in a tranche)` : ""}.
      </p>
      <p className="text-xs text-slate-400">Funding a tranche authorizes money at PayPal. The sub is paid only from an approved pay app's Payment panel.</p>
      {isGc && list.editBlockedReason ? <p className="text-sm text-amber-200">{list.editBlockedReason}</p> : null}
      {list.tranches.length === 0 ? (
        <p className="text-sm text-slate-400" data-testid="tranches-empty">
          {list.canEdit ? "No funding tranches yet. Add the first one below." : "No funding tranches yet."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="tranches-table">
            <caption className="sr-only">Funding tranches</caption>
            <thead className="text-xs text-slate-400 text-left">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">Tranche</th>
                <th scope="col" className="py-2 pr-3 font-medium">Planned date</th>
                <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                <th scope="col" className="py-2 pr-3 font-medium text-right">Amount</th>
                <th scope="col" className="py-2 pl-3 font-medium">Funding</th>
                {list.canEdit ? <th scope="col" className="py-2 pl-3 font-medium"><span className="sr-only">Edit</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {list.tranches.map((t, i) => (
                <TrancheRow
                  key={t._id}
                  tranche={t}
                  milestone={byId.get(t._id)}
                  canEdit={list.canEdit}
                  isGc={isGc}
                  first={i === 0}
                  last={i === list.tranches.length - 1}
                  projectStartDate={list.projectStartDate}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.canEdit ? (
        <AddTranche agreementId={agreementId} defaultPlannedDate={isoDate(list.defaultPlannedDate)} projectStartDate={list.projectStartDate} remainingCents={remaining} />
      ) : null}
    </div>
  );
}

function TrancheRow({
  tranche,
  milestone,
  canEdit,
  isGc,
  first,
  last,
  projectStartDate,
}: {
  tranche: Tranche;
  milestone: LedgerMilestone | undefined;
  canEdit: boolean;
  isGc: boolean;
  first: boolean;
  last: boolean;
  projectStartDate: string | null;
}) {
  const update = useMutation(api.billing.tranches.updateTranche);
  const move = useMutation(api.billing.tranches.moveTranche);
  const remove = useMutation(api.billing.tranches.deleteTranche);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tranche.name);
  const [amount, setAmount] = useState<number | null>(tranche.amountCents);
  const [date, setDate] = useState(isoDate(tranche.plannedDate));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function save() {
    if (amount === null) {
      setError("Enter the tranche amount.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await update({ trancheId: tranche._id, name, amountCents: amount, plannedDate: date });
      setEditing(false);
    } catch (e) {
      setError(getErrorMessage(e, "The tranche could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  async function doMove(direction: "up" | "down") {
    setError(null);
    try {
      await move({ trancheId: tranche._id, direction });
    } catch (e) {
      setError(getErrorMessage(e, "The tranche could not be moved."));
    }
  }

  const editable = canEdit && !tranche.locked;
  const liveWarning = editing ? dateWarning(date, projectStartDate) : tranche.dateWarning;

  return (
    <tr className="border-t border-slate-800 align-top" data-testid="tranche-row" data-locked={tranche.locked ? "true" : "false"}>
      <td className="py-2 pr-3">
        {editing ? (
          <TextInput label="Name" value={name} onChange={setName} data-testid="tranche-edit-name" />
        ) : (
          <span data-testid="tranche-name">{tranche.name}</span>
        )}
        {tranche.locked && canEdit ? <span className="block text-xs text-slate-400">Locked: funded</span> : null}
      </td>
      <td className="py-2 pr-3">
        {editing ? <DateInput label="Planned date" value={date} onChange={setDate} data-testid="tranche-edit-date" /> : utcDateLabel(tranche.plannedDate)}
        {liveWarning ? (
          <span className="block text-xs text-amber-300" data-testid="tranche-date-warning">
            {liveWarning}
          </span>
        ) : null}
      </td>
      <td className="py-2 pr-3">
        <StatusPill status={tranche.status} label={TRANCHE_STATUS[tranche.status] ?? "Not funded"} />
      </td>
      <td className="py-2 pr-3 text-right tabular-nums">
        {editing ? (
          <MoneyInput label="Amount" value={amount} onChange={setAmount} data-testid="tranche-edit-amount" />
        ) : (
          <span data-testid="tranche-amount">{formatCents(tranche.amountCents)}</span>
        )}
      </td>
      <td className="py-2 pl-3 space-y-1">
        {milestone ? (
          <>
            <FundingStatus milestone={milestone} />
            {isGc && !editing ? <FundMilestoneControl milestone={milestone} /> : null}
            <ReleaseList milestone={milestone} canRelease={isGc} />
            {isGc ? <CloseTrancheControl milestone={milestone} /> : null}
          </>
        ) : null}
      </td>
      {canEdit ? (
        <td className="py-2 pl-3">
          <div className="flex flex-wrap gap-1">
            {editing ? (
              <>
                <Button size="sm" loading={busy} onClick={() => void save()} data-testid="tranche-save">
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setError(null); }}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                {editable ? (
                  <Button size="sm" variant="secondary" onClick={() => { setName(tranche.name); setAmount(tranche.amountCents); setDate(isoDate(tranche.plannedDate)); setEditing(true); }} data-testid="tranche-edit">
                    Edit
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" disabled={first} onClick={() => void doMove("up")} aria-label={`Move ${tranche.name} up`} data-testid="tranche-up">
                  ↑
                </Button>
                <Button size="sm" variant="ghost" disabled={last} onClick={() => void doMove("down")} aria-label={`Move ${tranche.name} down`} data-testid="tranche-down">
                  ↓
                </Button>
                {editable ? (
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} data-testid="tranche-delete">
                    Delete
                  </Button>
                ) : null}
              </>
            )}
          </div>
          {error ? (
            <p className="mt-1 max-w-xs text-xs text-rose-300" role="alert" data-testid="tranche-error">
              {error}
            </p>
          ) : null}
          <ConfirmDialog
            open={confirmDelete}
            title={`Delete ${tranche.name}?`}
            tone="danger"
            amountCents={tranche.amountCents}
            effect="Removes this unfunded tranche. No money moves."
            confirmLabel="Delete tranche"
            onCancel={() => setConfirmDelete(false)}
            onConfirm={async () => {
              await remove({ trancheId: tranche._id });
              setConfirmDelete(false);
            }}
          />
        </td>
      ) : null}
    </tr>
  );
}

function AddTranche({
  agreementId,
  defaultPlannedDate,
  projectStartDate,
  remainingCents,
}: {
  agreementId: string;
  defaultPlannedDate: string;
  projectStartDate: string | null;
  remainingCents: number;
}) {
  const create = useMutation(api.billing.tranches.createTranche);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(defaultPlannedDate);
  const [errors, setErrors] = useState<{ name?: string; amount?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const warning = dateWarning(date, projectStartDate);

  async function submit() {
    const next: typeof errors = {};
    if (name.trim() === "") next.name = "Enter a tranche name.";
    if (amount === null || amount <= 0) next.amount = "Enter an amount more than $0.00.";
    setErrors(next);
    setNotice(null);
    if (next.name || next.amount) return;
    setBusy(true);
    try {
      const out = await create({ agreementId, name, amountCents: amount!, plannedDate: date });
      setName("");
      setAmount(null);
      setDate(defaultPlannedDate);
      setNotice(out.warning ? `Tranche added. ${out.warning}` : "Tranche added.");
    } catch (e) {
      setErrors({ form: getErrorMessage(e, "The tranche could not be added.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="rounded-xl border border-slate-800 p-3 space-y-3"
      data-testid="add-tranche-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm font-semibold">Add a funding tranche</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextInput label="Name" required value={name} onChange={setName} error={errors.name} data-testid="tranche-name-input" />
        <MoneyInput
          label="Amount"
          required
          value={amount}
          onChange={setAmount}
          error={errors.amount}
          hint={remainingCents > 0 ? `Up to ${formatCents(remainingCents)}` : undefined}
          data-testid="tranche-amount-input"
        />
        <DateInput
          label="Planned date"
          value={date}
          onChange={setDate}
          hint={projectStartDate ? `Project starts ${utcDateLabel(calendarDateToMs(projectStartDate))}` : undefined}
          data-testid="tranche-date-input"
        />
      </div>
      {warning ? (
        <p className="text-xs text-amber-300" data-testid="tranche-date-warning">
          {warning}
        </p>
      ) : null}
      {errors.form ? (
        <p className="text-sm text-rose-300" role="alert" data-testid="tranche-add-error">
          {errors.form}
        </p>
      ) : null}
      {notice ? (
        <p className="text-sm text-slate-300" role="status">
          {notice}
        </p>
      ) : null}
      <Button type="submit" loading={busy} data-testid="add-tranche-button">
        Add tranche
      </Button>
    </form>
  );
}

/** Voids the uncaptured remainder of a partly paid tranche. */
function CloseTrancheControl({ milestone }: { milestone: LedgerMilestone }) {
  const closeMilestone = useAction(api.payments.release.closeMilestone);
  const [open, setOpen] = useState(false);
  const f = milestone.funding;
  if (!f || !f.paypalAuthorizationId || f.status !== "partially_captured") return null;
  const remainder = f.grossCents - (f.capturedCents ?? 0);
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-testid="close-milestone-button">
        Close tranche
      </Button>
      <ConfirmDialog
        open={open}
        title={`Close ${milestone.name}?`}
        tone="danger"
        amountCents={remainder}
        amountLabel="Uncaptured remainder voided"
        effect="Voids the rest of this tranche's PayPal authorization. The voided money can't be captured again; fund a new tranche if needed."
        confirmLabel="Close tranche"
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          try {
            await closeMilestone({ milestoneId: milestone._id });
          } catch (e) {
            throw new Error(getErrorMessage(e, "The tranche could not be closed."));
          }
          setOpen(false);
        }}
      />
    </>
  );
}
