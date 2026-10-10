import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { ChangeOrderRowView } from "../../convex/billing/changeOrderView";
import type { ContractSumBreakdown } from "../../convex/payments/changeOrderMath";
import { changeOrderFieldErrors, type ChangeOrderFieldErrors } from "../../convex/payments/changeOrderMath";
import { getErrorMessage } from "../lib/errors";
import { Button, ConfirmDialog, Dialog, EmptyState, MoneyInput, PageHeader, StatusPill, Tabs, TextInput, formatCents, formatDate, useToast } from "../ui";
import { Field, focusFirstInvalid, inputClass } from "../ui/Field";

export const CHANGE_ORDERS_PAGE_HASH = "#/change-orders";

function signedCents(cents: number): string {
  return cents > 0 ? `+${formatCents(cents)}` : formatCents(cents);
}

/** Original sum, net change and sum to date for an agreement (subcontract) or the project (prime). */
function ContractSumSummary({ sum, label, testId }: { sum: ContractSumBreakdown; label: string; testId: string }) {
  const parts = [];
  if (sum.additionsCents !== 0) parts.push(`+${formatCents(sum.additionsCents)} additions`);
  if (sum.deductionsCents !== 0) parts.push(`${formatCents(sum.deductionsCents)} deductions`);
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-3" data-testid={testId}>
      <div>
        <dt className="text-xs text-ink-subtle">Original {label}</dt>
        <dd className="font-semibold tabular-nums" data-testid={`${testId}-original`}>
          {formatCents(sum.originalCents)}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-ink-subtle">Net change by change orders</dt>
        <dd className="font-semibold tabular-nums" data-testid={`${testId}-net`}>
          {signedCents(sum.netChangeCents)}
        </dd>
        {parts.length > 0 ? <dd className="text-xs text-ink-subtle" data-testid={`${testId}-breakdown`}>{parts.join(", ")}</dd> : null}
      </div>
      <div>
        <dt className="text-xs text-ink-subtle">{label[0].toUpperCase() + label.slice(1)} to date</dt>
        <dd className="font-semibold tabular-nums" data-testid={`${testId}-to-date`}>
          {formatCents(sum.toDateCents)}
        </dd>
      </div>
    </dl>
  );
}

type FormValues = { title: string; description: string; amountCents: number | null; scheduleDays: string };

function parseDays(text: string): number | null | "invalid" {
  const t = text.trim();
  if (t === "") return null;
  if (!/^-?\d+$/.test(t)) return "invalid";
  return Number(t);
}

/** Title, description, amount (negative for a deductive CO) and schedule impact, with inline errors. */
function ChangeOrderForm({
  initial,
  submitLabel,
  onSave,
  onCancel,
  linkOptions,
}: {
  initial?: FormValues;
  submitLabel: string;
  onSave: (values: { title: string; description: string; amountCents: number; scheduleDays: number | null; linkedChangeOrderId?: string }) => Promise<void>;
  onCancel: () => void;
  linkOptions?: { id: string; label: string }[];
}) {
  const [values, setValues] = useState<FormValues>(initial ?? { title: "", description: "", amountCents: null, scheduleDays: "" });
  const [linked, setLinked] = useState("");
  const [errors, setErrors] = useState<ChangeOrderFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const days = parseDays(values.scheduleDays);
    const found = changeOrderFieldErrors({
      title: values.title,
      description: values.description,
      amountCents: values.amountCents,
      scheduleDays: days === "invalid" ? 0.5 : days,
    });
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(formRef.current);
      return;
    }
    setBusy(true);
    try {
      await onSave({
        title: values.title,
        description: values.description,
        amountCents: values.amountCents!,
        scheduleDays: days === "invalid" ? null : days,
        ...(linked ? { linkedChangeOrderId: linked } : {}),
      });
    } catch (err) {
      const data = (err as { data?: { fieldErrors?: ChangeOrderFieldErrors } }).data;
      if (data && typeof data === "object" && data.fieldErrors) setErrors(data.fieldErrors);
      setFormError(getErrorMessage(err, "The change order could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="space-y-3 rounded-xl border border-line p-4" data-testid="change-order-form">
      <TextInput
        label="Title"
        required
        value={values.title}
        onChange={(title) => setValues({ ...values, title })}
        error={errors.title}
        maxLength={200}
        data-testid="change-order-title"
      />
      <Field label="Description" error={errors.description}>
        {(control) => (
          <textarea
            {...control}
            value={values.description}
            onChange={(e) => setValues({ ...values, description: e.target.value })}
            rows={3}
            maxLength={1000}
            className={inputClass(Boolean(errors.description), "py-2")}
            data-testid="change-order-description"
          />
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <MoneyInput
          label="Amount"
          required
          allowNegative
          value={values.amountCents}
          onChange={(amountCents) => setValues({ ...values, amountCents })}
          error={errors.amountCents}
          hint="Use a negative amount for a deductive change order."
          data-testid="change-order-amount-input"
        />
        <TextInput
          label="Schedule impact (days)"
          value={values.scheduleDays}
          onChange={(scheduleDays) => setValues({ ...values, scheduleDays })}
          error={errors.scheduleDays}
          inputMode="numeric"
          data-testid="change-order-schedule-days"
        />
      </div>
      {linkOptions && linkOptions.length > 0 ? (
        <Field label="Linked subcontract change order (for reference)">
          {(control) => (
            <select {...control} value={linked} onChange={(e) => setLinked(e.target.value)} className={inputClass(false)} data-testid="change-order-link">
              <option value="">None</option>
              {linkOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
      {formError ? (
        <p role="alert" className="text-sm text-rose-300" data-testid="change-order-form-error">
          {formError}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" loading={busy} loadingLabel="Saving…" data-testid="change-order-save">
          {submitLabel}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Approve: the dialog states the effect the server computed (SOV line and new contract sum, or the prime change). */
function ApproveDialog({ co, open, onClose }: { co: ChangeOrderRowView; open: boolean; onClose: () => void }) {
  const detail = useQuery(api.billing.changeOrders.getChangeOrder, open ? { changeOrderId: co._id } : "skip");
  const approve = useMutation(api.billing.changeOrders.approveChangeOrder);
  const toast = useToast();
  const preview = detail?.approvalPreview ?? null;
  const blocked = preview?.floorProblem ?? preview?.sovProblem ?? null;
  const effect =
    co.scope === "prime"
      ? `Approves ${co.label} and changes the prime contract sum by ${signedCents(co.amountCents)}. Decided change orders cannot be changed.`
      : preview === null
        ? "Loading the effect of this approval…"
        : blocked ?? `${preview.message}. Decided change orders cannot be changed.`;
  return (
    <ConfirmDialog
      open={open}
      title={`Approve ${co.label}?`}
      amountCents={co.amountCents}
      effect={<span data-testid="change-order-approve-effect">{effect}</span>}
      details={[{ label: "Change order", value: `${co.label} – ${co.title}` }]}
      confirmLabel="Approve"
      onCancel={onClose}
      onConfirm={async () => {
        if (co.scope === "subcontract" && (preview === null || blocked !== null)) throw new Error(blocked ?? "The approval preview is still loading.");
        await approve({ changeOrderId: co._id });
        toast.success(`${co.label} approved.`);
        onClose();
      }}
    />
  );
}

function RejectDialog({ co, open, onClose }: { co: ChangeOrderRowView; open: boolean; onClose: () => void }) {
  const reject = useMutation(api.billing.changeOrders.rejectChangeOrder);
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setReason("");
      setError(null);
    }
  }, [open]);
  async function submit() {
    if (reason.trim() === "") {
      setError("Enter a reason for rejecting the change order.");
      return;
    }
    setBusy(true);
    try {
      await reject({ changeOrderId: co._id, reason });
      toast.success(`${co.label} rejected.`);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "The change order could not be rejected."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      title={`Reject ${co.label}?`}
      description="The requester sees the reason. A rejected change order adds nothing and cannot be changed."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void submit()} data-testid="change-order-reject-confirm">
            Reject
          </Button>
        </>
      }
    >
      <Field label="Reason" required error={error}>
        {(control) => (
          <textarea
            {...control}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={1000}
            className={inputClass(Boolean(error), "py-2")}
            data-testid="change-order-reject-reason"
          />
        )}
      </Field>
    </Dialog>
  );
}

type Pending = "approve" | "reject" | "delete" | "invoice" | null;

/** One change order with the caller's controls (the server decides which ones the caller has). */
function ChangeOrderRow({ co, showAgreement, recipientEmail }: { co: ChangeOrderRowView; showAgreement: boolean; recipientEmail: string | null }) {
  const update = useMutation(api.billing.changeOrders.updateChangeOrder);
  const remove = useMutation(api.billing.changeOrders.deleteChangeOrder);
  const submit = useMutation(api.billing.changeOrders.submitChangeOrder);
  const withdraw = useMutation(api.billing.changeOrders.withdrawChangeOrder);
  const invoiceNow = useAction(api.payments.invoices.sendChangeOrderInvoice);
  const refresh = useAction(api.payments.invoices.refreshChangeOrderStatus);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      toast.success(label);
    } catch (err) {
      toast.error(err, "The change order could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className="py-3" data-testid="change-order-row">
        <ChangeOrderForm
          initial={{ title: co.title, description: co.description, amountCents: co.amountCents, scheduleDays: co.scheduleDays === null ? "" : String(co.scheduleDays) }}
          submitLabel="Save draft"
          onCancel={() => setEditing(false)}
          onSave={async (v) => {
            await update({ changeOrderId: co._id, title: v.title, description: v.description, amountCents: v.amountCents, scheduleDays: v.scheduleDays });
            toast.success(`${co.label} saved.`);
            setEditing(false);
          }}
        />
      </li>
    );
  }

  return (
    <li className="space-y-1.5 py-3" data-testid="change-order-row" data-status={co.status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm">
            <span className="font-semibold" data-testid="change-order-label">
              {co.label}
            </span>
            {showAgreement && co.agreementNumber ? <span className="text-ink-subtle"> · {co.agreementNumber}</span> : null} ·{" "}
            <span data-testid="change-order-title-text">{co.title}</span>
          </p>
          {co.description ? <p className="text-xs text-ink-subtle">{co.description}</p> : null}
          <p className="text-xs text-ink-subtle">
            {co.scheduleDays !== null ? `Schedule impact ${co.scheduleDays} days · ` : ""}
            {co.requestedByParty === "sub" ? "Requested by the sub" : "Requested by the GC"}
            {co.sovLineNo !== null ? ` · SOV line ${co.sovLineNo}` : ""}
            {co.linkedLabel ? ` · linked to ${co.linkedLabel}` : ""}
            {co.approvedAt ? ` · approved ${formatDate(co.approvedAt)}` : ""}
            {co.judgeDemoApproval ? ` (by the guided demo for ${co.judgeDemoApproval})` : ""}
            {co.paidAt ? ` · paid ${formatDate(co.paidAt)}` : co.invoicedAt ? ` · invoiced ${formatDate(co.invoicedAt)}` : ""}
          </p>
          {co.rejectionReason ? (
            <p className="text-xs text-rose-300" data-testid="change-order-rejection-reason">
              Rejected: {co.rejectionReason}
            </p>
          ) : null}
          {co.recipientEmail || co.paypalInvoiceId ? (
            <p className="text-xs text-ink-subtle">
              {[
                co.recipientEmail ? `Invoice to ${co.recipientEmail}` : null,
                co.paypalInvoiceId ? `PayPal invoice ${co.paypalInvoiceId}${co.paypalInvoiceStatus ? ` (${co.paypalInvoiceStatus})` : ""}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
          {co.error ? <p className="text-xs text-rose-300">{co.error}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold tabular-nums" data-testid="change-order-amount">
            {signedCents(co.amountCents)}
          </span>
          <StatusPill status={co.status} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {co.canEdit ? (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)} disabled={busy} data-testid="change-order-edit">
            Edit
          </Button>
        ) : null}
        {co.canSubmit ? (
          <Button size="sm" onClick={() => void run(`${co.label} submitted.`, () => submit({ changeOrderId: co._id }))} disabled={busy} data-testid="change-order-submit">
            Submit
          </Button>
        ) : null}
        {co.canDelete ? (
          <Button size="sm" variant="ghost" onClick={() => setPending("delete")} disabled={busy} data-testid="change-order-delete">
            Delete draft
          </Button>
        ) : null}
        {co.canWithdraw ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void run(`${co.label} withdrawn to Draft.`, () => withdraw({ changeOrderId: co._id }))}
            disabled={busy}
            data-testid="change-order-withdraw"
          >
            Withdraw
          </Button>
        ) : null}
        {co.canApprove ? (
          <Button size="sm" onClick={() => setPending("approve")} disabled={busy} data-testid="change-order-approve">
            Approve
          </Button>
        ) : null}
        {co.canReject ? (
          <Button size="sm" variant="danger" onClick={() => setPending("reject")} disabled={busy} data-testid="change-order-reject">
            Reject
          </Button>
        ) : null}
        {co.invoice.show ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setPending("invoice")}
            disabled={busy || !co.invoice.enabled}
            title={co.invoice.reason ?? undefined}
            data-testid="change-order-invoice-now"
          >
            Invoice now
          </Button>
        ) : null}
        {co.invoice.show && co.invoice.reason ? (
          <span className="text-xs text-amber-300" data-testid="change-order-invoice-disabled">
            {co.invoice.reason}
          </span>
        ) : null}
        {co.payerViewUrl ? (
          <a href={co.payerViewUrl} target="_blank" rel="noreferrer" className="text-xs text-emerald-300 hover:underline" data-testid="change-order-invoice-link">
            Open PayPal invoice
          </a>
        ) : null}
        {co.canRefresh && (co.status === "invoiced" || co.status === "paid") ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run("Invoice status refreshed.", async () => {
                const out = await refresh({ changeOrderId: co._id });
                return out;
              })
            }
            data-testid="change-order-refresh"
          >
            Refresh status
          </Button>
        ) : null}
      </div>
      {co.editBlockedReason && co.status !== "draft" && co.status !== "submitted" ? (
        <p className="text-xs text-ink-subtle">{co.editBlockedReason}</p>
      ) : null}

      <ApproveDialog co={co} open={pending === "approve"} onClose={() => setPending(null)} />
      <RejectDialog co={co} open={pending === "reject"} onClose={() => setPending(null)} />
      <ConfirmDialog
        open={pending === "delete"}
        title={`Delete draft ${co.label}?`}
        effect="Deletes this draft change order. Nothing was submitted, so nothing else changes."
        confirmLabel="Delete draft"
        tone="danger"
        onCancel={() => setPending(null)}
        onConfirm={async () => {
          await remove({ changeOrderId: co._id });
          toast.success(`Draft ${co.label} deleted.`);
          setPending(null);
        }}
      />
      <ConfirmDialog
        open={pending === "invoice"}
        title={`Invoice ${co.label} now?`}
        amountCents={co.amountCents}
        payee={recipientEmail ?? "The project owner's billing email"}
        payeeLabel="Invoice to"
        effect="Creates and sends a PayPal invoice for this approved change order. The sandbox sends no email; open the invoice from the link here."
        confirmLabel="Invoice now"
        onCancel={() => setPending(null)}
        onConfirm={async () => {
          await invoiceNow({ changeOrderId: co._id });
          toast.success(`${co.label} invoiced.`);
          setPending(null);
        }}
      />
    </li>
  );
}

export function ChangeOrderRows({
  rows,
  emptyText,
  showAgreement = false,
  recipientEmail = null,
}: {
  rows: ChangeOrderRowView[];
  emptyText: string;
  showAgreement?: boolean;
  recipientEmail?: string | null;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-subtle" data-testid="change-orders-empty">
        {emptyText}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line" data-testid="change-order-list">
      {rows.map((co) => (
        <ChangeOrderRow key={co._id} co={co} showAgreement={showAgreement} recipientEmail={recipientEmail} />
      ))}
    </ul>
  );
}

function NewChangeOrder({
  label,
  create,
  linkOptions,
}: {
  label: string;
  create: (v: { title: string; description: string; amountCents: number; scheduleDays: number | null; linkedChangeOrderId?: string }) => Promise<unknown>;
  linkOptions?: { id: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)} data-testid="change-order-new">
        {label}
      </Button>
    );
  }
  return (
    <ChangeOrderForm
      submitLabel="Save draft"
      linkOptions={linkOptions}
      onCancel={() => setOpen(false)}
      onSave={async (v) => {
        await create(v);
        toast.success("Change order saved as Draft.");
        setOpen(false);
      }}
    />
  );
}

type ProjectList = NonNullable<ReturnType<typeof useProjectChangeOrders>>;
function useProjectChangeOrders(projectId: string | null) {
  return useQuery(api.billing.changeOrders.listForProject, projectId ? { projectId } : "skip");
}

function SubcontractSection({ agreement }: { agreement: ProjectList["agreements"][number] }) {
  const create = useMutation(api.billing.changeOrders.createChangeOrder);
  return (
    <section className="space-y-3 rounded-2xl border border-line bg-surface p-5" data-testid="subcontract-change-orders" aria-label={`${agreement.agreementNumber} change orders`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">
            {agreement.subcontractorName} · {agreement.tradeName}
          </h3>
          <p className="text-xs text-ink-subtle">{agreement.agreementNumber}</p>
        </div>
        {agreement.canCreate ? (
          <NewChangeOrder
            label="New change order"
            create={(v) =>
              create({
                scope: "subcontract",
                agreementId: agreement.agreementId,
                title: v.title,
                description: v.description,
                amountCents: v.amountCents,
                scheduleDays: v.scheduleDays,
              })
            }
          />
        ) : null}
      </div>
      <ContractSumSummary sum={agreement.contractSum} label="contract sum" testId="agreement-contract-sum" />
      {!agreement.executed ? <p className="text-xs text-ink-subtle">Change orders open once the GC records execution of this agreement.</p> : null}
      <ChangeOrderRows rows={agreement.changeOrders} emptyText="No change orders on this agreement yet." />
    </section>
  );
}

function PrimeSection({ data }: { data: ProjectList }) {
  const create = useMutation(api.billing.changeOrders.createChangeOrder);
  const prime = data.prime!;
  const linkOptions = data.agreements.flatMap((a) =>
    a.changeOrders.filter((c) => c.status !== "draft").map((c) => ({ id: c._id as string, label: `${c.label} – ${c.title} (${a.subcontractorName})` })),
  );
  return (
    <section className="space-y-3 rounded-2xl border border-line bg-surface p-5" data-testid="prime-change-orders" aria-label="Prime change orders">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">Prime change orders</h3>
          <p className="text-xs text-ink-subtle">Between the GC and the owner. The owner approves or rejects each one.</p>
        </div>
        {prime.canCreate ? (
          <NewChangeOrder
            label="New prime change order"
            linkOptions={linkOptions}
            create={(v) =>
              create({
                scope: "prime",
                projectId: data.projectId,
                title: v.title,
                description: v.description,
                amountCents: v.amountCents,
                scheduleDays: v.scheduleDays,
                ...(v.linkedChangeOrderId ? { linkedChangeOrderId: v.linkedChangeOrderId } : {}),
              })
            }
          />
        ) : null}
      </div>
      {prime.contractSum ? (
        <ContractSumSummary sum={prime.contractSum} label="prime contract sum" testId="prime-contract-sum" />
      ) : prime.canCreate ? (
        <p className="text-xs text-ink-subtle">Set the project's contract value in Project settings to see the prime contract sum.</p>
      ) : null}
      {data.invoicing?.recipientEmail ? (
        <p className="text-xs text-ink-subtle" data-testid="change-order-recipient">
          "Invoice now" sends approved prime change orders to the owner at {data.invoicing.recipientEmail}.
        </p>
      ) : null}
      <ChangeOrderRows rows={prime.changeOrders} emptyText="No prime change orders yet." recipientEmail={data.invoicing?.recipientEmail ?? null} />
    </section>
  );
}

function ProjectChangeOrders({ projectId }: { projectId: string }) {
  const data = useProjectChangeOrders(projectId);
  if (data === undefined) {
    return (
      <p className="text-sm text-ink-subtle" role="status">
        Loading change orders…
      </p>
    );
  }
  const subcontract =
    data.agreements.length === 0 ? (
      <p className="text-sm text-ink-subtle">No subcontract agreements on this project yet.</p>
    ) : (
      <div className="space-y-4">
        {data.agreements.map((a) => (
          <SubcontractSection key={a.agreementId} agreement={a} />
        ))}
      </div>
    );
  if (data.party === "sub") return subcontract;
  if (data.party === "owner") return <PrimeSection data={data} />;
  return (
    <Tabs
      label="Change order type"
      tabs={[
        { id: "subcontract", label: "Subcontract", content: subcontract },
        { id: "prime", label: "Prime", content: <PrimeSection data={data} /> },
      ]}
    />
  );
}

/** Change orders page: subcontract COs (GC and that sub) and prime COs (GC and the owner) per project. */
export function ChangeOrdersPage() {
  const projects = useQuery(api.billing.changeOrders.myChangeOrderProjects, {});
  const [projectId, setProjectId] = useState<string | null>(null);
  const selected = projectId ?? projects?.[0]?._id ?? null;
  if (projects === undefined) {
    return (
      <p className="text-sm text-ink-subtle" role="status">
        Loading projects…
      </p>
    );
  }
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Change orders"
        description="Subcontract change orders add a line to the agreement's schedule of values once the GC approves them. Prime change orders change the owner contract once the owner approves them."
      />
      {projects.length === 0 ? (
        <EmptyState title="No projects yet" description="Change orders appear here once you are on a project." />
      ) : (
        <>
          {projects.length > 1 ? (
            <Field label="Project" className="max-w-sm">
              {(control) => (
                <select {...control} value={selected ?? ""} onChange={(e) => setProjectId(e.target.value)} className={inputClass(false)} data-testid="change-orders-project">
                  {projects.map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.title}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : (
            <p className="text-sm font-medium">{projects[0].title}</p>
          )}
          {selected ? <ProjectChangeOrders key={selected} projectId={selected} /> : null}
        </>
      )}
    </div>
  );
}

/** Agreement ledger section: the agreement's subcontract change orders and its contract sum to date. */
export function AgreementChangeOrders({ agreementId }: { agreementId: Id<"agreements"> }) {
  const data = useQuery(api.billing.changeOrders.listForAgreement, { agreementId });
  if (data === undefined || data === null) return null;
  return (
    <section aria-labelledby="ledger-change-orders" className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5" data-testid="ledger-change-orders">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="ledger-change-orders" className="text-base font-semibold">
          Change orders
        </h3>
        <a href={CHANGE_ORDERS_PAGE_HASH} className="text-sm text-emerald-300 hover:underline">
          Open Change orders
        </a>
      </div>
      <ContractSumSummary sum={data.contractSum} label="contract sum" testId="ledger-contract-sum" />
      <ChangeOrderRows rows={data.changeOrders} emptyText="No change orders on this agreement yet." />
    </section>
  );
}
