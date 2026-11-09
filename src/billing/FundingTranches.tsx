import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { calendarDateToMs, isCalendarDate, plannedDateWarning, projectStartMs } from "../../convex/billing/trancheRules";
import { getErrorMessage } from "../lib/errors";
import { FundMilestoneControl, FundingStatus } from "../payments/FundMilestone";
import { ReleaseList } from "../payments/ReleaseMilestone";
import { ReceiptId } from "../payments/ReceiptId";
import { Button, ConfirmDialog, DateInput, MoneyInput, StatusPill, TextInput, formatCents } from "../ui";
import type { Terms } from "../lib/terms";

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
export function FundingTranches({ agreementId, ledgerMilestones, isGc, terms }: { agreementId: string; ledgerMilestones: LedgerMilestone[]; isGc: boolean; terms: Terms }) {
  const funding = terms.funding;
  const list = useQuery(api.billing.tranches.listTranches, { agreementId });
  const byId = new Map(ledgerMilestones.map((m) => [m._id as string, m]));
  if (list === undefined) {
    return (
      <p className="text-sm text-slate-400" role="status">
        Loading {funding.items}…
      </p>
    );
  }
  if (list === null) return null;
  const remaining = list.contractSumToDateCents - list.trancheTotalCents;

  return (
    <div className="space-y-4" data-testid="funding-tranches">
      <p className="text-sm text-slate-300" data-testid="tranche-totals">
        {funding.totalLabel} <span className="font-semibold tabular-nums">{formatCents(list.trancheTotalCents)}</span> of the contract sum to date{" "}
        <span className="font-semibold tabular-nums">{formatCents(list.contractSumToDateCents)}</span>
        {remaining > 0 ? ` (${formatCents(remaining)} not yet in a ${funding.item})` : ""}.
      </p>
      <p className="text-xs text-slate-400">{funding.authorizationNote}</p>
      {isGc && list.editBlockedReason ? <p className="text-sm text-amber-200">{list.editBlockedReason}</p> : null}
      {list.tranches.length === 0 ? (
        <p className="text-sm text-slate-400" data-testid="tranches-empty">
          {list.canEdit ? funding.emptyEditable : funding.emptyReadOnly}
        </p>
      ) : (
        <div className="table-scroll" role="region" aria-label={`${funding.ledgerTitle}, scroll horizontally on narrow screens`} tabIndex={0}>
          <table className="w-full text-sm" data-testid="tranches-table">
            <caption className="sr-only">{funding.ledgerTitle}</caption>
            <thead className="text-xs text-slate-400 text-left">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">{funding.itemTitle}</th>
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
                  terms={terms}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.canEdit ? (
        <AddTranche agreementId={agreementId} defaultPlannedDate={isoDate(list.defaultPlannedDate)} projectStartDate={list.projectStartDate} remainingCents={remaining} terms={terms} />
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
  terms,
}: {
  tranche: Tranche;
  milestone: LedgerMilestone | undefined;
  canEdit: boolean;
  isGc: boolean;
  first: boolean;
  last: boolean;
  projectStartDate: string | null;
  terms: Terms;
}) {
  const funding = terms.funding;
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
      setError(funding.amountRequired);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await update({ trancheId: tranche._id, name, amountCents: amount, plannedDate: date });
      setEditing(false);
    } catch (e) {
      setError(getErrorMessage(e, funding.saveFailed));
    } finally {
      setBusy(false);
    }
  }

  async function doMove(direction: "up" | "down") {
    setError(null);
    try {
      await move({ trancheId: tranche._id, direction });
    } catch (e) {
      setError(getErrorMessage(e, funding.moveFailed));
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
            <ReceiptId label="PayPal order" value={milestone.funding?.paypalOrderId} />
            <ReceiptId label="PayPal authorization" value={milestone.funding?.paypalAuthorizationId} />
            {isGc && !editing ? <FundMilestoneControl milestone={milestone} /> : null}
            <ReleaseList milestone={milestone} canRelease={isGc} />
            {isGc ? <CloseTrancheControl milestone={milestone} terms={terms} /> : null}
          </>
        ) : null}
      </td>
      {canEdit ? (
        <td className="py-2 pl-3">
          <div className="flex flex-wrap gap-1">
            {editing ? (
              <>
                <Button size="sm" loading={busy} onClick={() => void save()} data-testid="tranche-save">
                  {funding.saveAction}
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
            effect={funding.deleteEffect}
            confirmLabel={`Delete ${funding.item}`}
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
  terms,
}: {
  agreementId: string;
  defaultPlannedDate: string;
  projectStartDate: string | null;
  remainingCents: number;
  terms: Terms;
}) {
  const funding = terms.funding;
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
    if (name.trim() === "") next.name = funding.nameRequired;
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
      setNotice(out.warning ? `${funding.addedNotice} ${out.warning}` : funding.addedNotice);
    } catch (e) {
      setErrors({ form: getErrorMessage(e, funding.addFailed) });
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
      <p className="text-sm font-semibold">{funding.addTitle}</p>
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
        {funding.addAction}
      </Button>
    </form>
  );
}

/** Voids the uncaptured remainder of a partly paid tranche. */
function CloseTrancheControl({ milestone, terms }: { milestone: LedgerMilestone; terms: Terms }) {
  const closeMilestone = useAction(api.payments.release.closeMilestone);
  const [open, setOpen] = useState(false);
  const f = milestone.funding;
  if (!f || !f.paypalAuthorizationId || f.status !== "partially_captured") return null;
  const remainder = f.grossCents - (f.capturedCents ?? 0);
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-testid="close-milestone-button">
        {`Close ${terms.funding.item}`}
      </Button>
      <ConfirmDialog
        open={open}
        title={`Close ${milestone.name}?`}
        tone="danger"
        amountCents={remainder}
        amountLabel="Uncaptured remainder voided"
        effect={terms.funding.closeEffect}
        confirmLabel={`Close ${terms.funding.item}`}
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          try {
            await closeMilestone({ milestoneId: milestone._id });
          } catch (e) {
            throw new Error(getErrorMessage(e, terms.funding.closeFailed));
          }
          setOpen(false);
        }}
      />
    </>
  );
}
