import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { DocumentDownloadButton, ProjectDocumentsList } from "../documents/DocumentDownload";
import { getErrorMessage } from "../lib/errors";
import { Button, Card, ConfirmDialog, Dialog, EmptyState, MoneyInput, PageHeader, StatusPill, formatBps, formatCents, formatDate, useToast } from "../ui";
import { Field, inputClass } from "../ui/Field";

export const OWNER_PAY_APPS_HASH = "#/owner-pay-apps";

type Detail = FunctionReturnType<typeof api.billing.ownerPayApps.getOwnerPayApp>;
type List = FunctionReturnType<typeof api.billing.ownerPayApps.listOwnerPayApps>;
type Party = "gc" | "owner";

function signedCents(cents: number): string {
  return cents > 0 ? `+${formatCents(cents)}` : formatCents(cents);
}

function percent(hundredths: number | null): string {
  return hundredths === null ? "–" : `${(hundredths / 100).toFixed(2)}%`;
}

/** The project picker shared by the GC tab and the owner page: only projects where the caller is that party. */
function useOwnerBillingProject(party: Party) {
  const projects = useQuery(api.billing.ownerPayApps.ownerBillingProjects, {});
  const mine = projects?.filter((p) => p.partyRole === party);
  const [projectId, setProjectId] = useState<string | null>(null);
  const selected = projectId ?? mine?.[0]?._id ?? null;
  const picker =
    mine === undefined || mine.length <= 1 ? (
      mine?.[0] ? <p className="text-sm font-medium">{mine[0].title}</p> : null
    ) : (
      <Field label="Project" className="max-w-sm">
        {(control) => (
          <select {...control} value={selected ?? ""} onChange={(e) => setProjectId(e.target.value)} className={inputClass(false)} data-testid="owner-billing-project">
            {mine.map((p) => (
              <option key={p._id} value={p._id}>
                {p.title}
              </option>
            ))}
          </select>
        )}
      </Field>
    );
  return { loading: mine === undefined, empty: mine?.length === 0, selected, picker };
}

/** G702 application summary of an owner pay app. */
function G702Summary({ app }: { app: Detail }) {
  const f = app.figures;
  const rows: [string, string, string][] = [
    ["1", "Original contract sum", formatCents(f.originalContractSumCents)],
    ["2", "Net change by change orders", signedCents(f.netChangeOrdersCents)],
    ["3", "Contract sum to date", formatCents(f.contractSumToDateCents)],
    ["4", "Total completed & stored to date", formatCents(f.completedAndStoredCents)],
    ["5", `Retainage (${formatBps(app.retainageBps)} on each prime line)`, formatCents(f.retainageCents)],
    ["6", "Total earned less retainage", formatCents(f.earnedLessRetainageCents)],
    ["7", "Less previous certificates for payment", formatCents(f.previousCertificatesCents)],
    ["8", "Current payment due", formatCents(f.currentPaymentDueCents)],
    ["9", "Balance to finish, including retainage", formatCents(f.balanceToFinishInclRetainageCents)],
  ];
  return (
    <dl className="divide-y divide-line rounded-lg border border-line text-sm" data-testid="owner-g702">
      {rows.map(([no, label, value]) => (
        <div key={no} className={`flex justify-between gap-4 px-3 py-2 ${no === "8" ? "bg-emerald-950/30 font-semibold" : ""}`} data-testid={`owner-g702-${no}`}>
          <dt className="text-ink-subtle">
            {no}. {label}
          </dt>
          <dd className="text-right font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** G703 continuation sheet of the prime contract. The GC edits this period's amounts on GC and change-order lines. */
function PrimeSheet({
  app,
  amounts,
  onAmount,
  errors,
}: {
  app: Detail;
  amounts: Record<string, number | null>;
  onAmount?: (key: string, cents: number | null) => void;
  errors: Record<string, string>;
}) {
  const editable = onAmount !== undefined && app.controls.edit;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-sm" data-testid="owner-g703">
        <caption className="sr-only">Prime continuation sheet</caption>
        <thead className="text-left text-xs text-ink-subtle">
          <tr>
            <th scope="col" className="py-2 pr-2 font-medium">#</th>
            <th scope="col" className="py-2 pr-2 font-medium">Description of work</th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">Scheduled value</th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">Previous applications</th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">This period</th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">Materials stored</th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">Completed & stored</th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">%</th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">Balance to finish</th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">Retainage</th>
          </tr>
        </thead>
        <tbody>
          {app.lines.map((l) => (
            <tr key={l.key} className="border-t border-line align-top" data-testid="owner-g703-row" data-kind={l.kind}>
              <td className="py-2 pr-2 tabular-nums">{l.lineNo}</td>
              <td className="py-2 pr-2">
                {l.description}
                {l.kind === "trade" ? <span className="block text-xs text-ink-subtle">From approved sub pay apps</span> : null}
              </td>
              <td className="py-2 pr-2 text-right tabular-nums">{formatCents(l.scheduledValueCents)}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{formatCents(l.previousWorkCents + l.previousStoredCents)}</td>
              <td className="py-2 pr-2 text-right tabular-nums">
                {editable && l.kind !== "trade" ? (
                  <MoneyInput
                    label={<span className="sr-only">This period for {l.description}</span>}
                    value={amounts[l.key] ?? null}
                    onChange={(cents) => onAmount(l.key, cents)}
                    allowNegative={l.scheduledValueCents < 0}
                    error={errors[l.key]}
                    hint={
                      <span className="text-xs">
                        {l.scheduledValueCents < 0
                          ? `Credit: ${formatCents(l.remainingCents)} to $0.00`
                          : `Up to ${formatCents(l.remainingCents)}`}
                      </span>
                    }
                    className="ml-auto w-36"
                    data-testid="owner-line-amount"
                  />
                ) : (
                  formatCents(l.workThisPeriodCents)
                )}
              </td>
              <td className="py-2 pr-2 text-right tabular-nums">{formatCents(l.storedCents)}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{formatCents(l.totalCents)}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{percent(l.percentHundredths)}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{formatCents(l.balanceCents)}</td>
              <td className="py-2 pr-2 text-right tabular-nums">
                {formatCents(l.retainageCents)}
                {l.subRetainageCents !== null && l.subRetainageCents !== l.retainageCents ? (
                  <span className="block text-xs text-ink-subtle">Sub pay apps: {formatCents(l.subRetainageCents)}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function History({ app }: { app: Detail }) {
  return (
    <ol className="space-y-1 text-xs text-ink-subtle" data-testid="owner-pay-app-history">
      {app.history.map((h, i) => (
        <li key={i}>
          <StatusPill status={h.status} /> {formatDate(h.at)} by {h.byName}
          {h.comment ? <span className="block pl-2 text-ink">“{h.comment}”</span> : null}
        </li>
      ))}
    </ol>
  );
}

function InvoicePanel({ app }: { app: Detail }) {
  const refresh = useAction(api.billing.ownerInvoices.refreshOwnerPayAppStatus);
  const resume = useAction(api.billing.ownerInvoices.sendOwnerPayAppInvoice);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  if (app.paypalInvoiceId === null && !app.controls.sendInvoice && app.error === null) return null;
  async function refreshStatus() {
    setBusy(true);
    try {
      const out = await refresh({ ownerPayAppId: app._id });
      toast.success(out.changed ? "Status updated." : `PayPal shows ${out.paypalInvoiceStatus ?? "no change"}.`);
    } catch (err) {
      toast.error(getErrorMessage(err, "PayPal could not be reached."));
    } finally {
      setBusy(false);
    }
  }
  const amount = formatCents(app.figures.currentPaymentDueCents);
  const recipient = app.recipientEmail ?? "the owner's billing email";
  return (
    <div className="space-y-2 rounded-lg border border-line p-3 text-sm" data-testid="owner-invoice-panel">
      <p className="font-medium">PayPal invoice</p>
      {app.paypalInvoiceId ? (
        <p>
          Invoice <span className="font-mono text-xs" data-testid="owner-invoice-id">{app.paypalInvoiceId}</span>
          {app.paypalInvoiceStatus ? ` · PayPal status ${app.paypalInvoiceStatus}` : null}
          {app.recipientEmail ? ` · sent to ${app.recipientEmail}` : null}
        </p>
      ) : null}
      {app.payerViewUrl ? (
        <a href={app.payerViewUrl} target="_blank" rel="noreferrer" className="text-emerald-400 hover:text-emerald-300" data-testid="owner-invoice-payer-link">
          Open the invoice in PayPal (sandbox)
        </a>
      ) : null}
      {app.error ? (
        <p role="alert" className="text-rose-300">
          {app.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {app.controls.refreshStatus ? (
          <Button variant="secondary" size="sm" loading={busy} onClick={() => void refreshStatus()} data-testid="owner-invoice-refresh">
            Refresh status
          </Button>
        ) : null}
        {app.controls.sendInvoice && app.party === "gc" ? (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmSend(true)} data-testid="owner-invoice-resume">
            Send invoice
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmSend}
        title={`Send the PayPal invoice for owner pay app #${app.applicationNo}?`}
        amountCents={app.figures.currentPaymentDueCents}
        amountLabel="Invoice amount (current payment due)"
        payee={recipient}
        payeeLabel="Billed to (owner billing email)"
        details={[{ label: "Retainage", value: formatCents(app.figures.retainageCents) }]}
        effect={`Creates and sends a PayPal invoice for ${amount} to ${recipient}, asking the owner to pay it. If an earlier attempt already created or sent this invoice, PayPal returns that invoice instead of a second one.`}
        confirmLabel={`Send ${amount} invoice`}
        onCancel={() => setConfirmSend(false)}
        onConfirm={async () => {
          await resume({ ownerPayAppId: app._id });
          setConfirmSend(false);
          toast.success("Invoice sent.");
        }}
      />
    </div>
  );
}

function AppHeader({ app }: { app: Detail }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h3 className="text-base font-semibold">
        Owner pay app #{app.applicationNo} · period ending {formatDate(app.periodEnd)}
      </h3>
      <StatusPill status={app.status} />
      <span className="text-sm text-ink-subtle">{percent(app.percentCompleteHundredths)} complete</span>
      <DocumentDownloadButton kind="owner_pay_app_pdf" relatedId={app._id} label="Download PDF" testId="owner-pay-app-download-pdf" />
    </div>
  );
}

// ---- GC ------------------------------------------------------------------------------------------

function GcOwnerPayApp({ ownerPayAppId }: { ownerPayAppId: string }) {
  const app = useQuery(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId });
  const save = useMutation(api.billing.ownerPayApps.saveOwnerPayApp);
  const submit = useMutation(api.billing.ownerPayApps.submitOwnerPayApp);
  const remove = useMutation(api.billing.ownerPayApps.deleteOwnerPayApp);
  const toast = useToast();
  const [amounts, setAmounts] = useState<Record<string, number | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<"submit" | "delete" | null>(null);

  const linesKey = app ? app.lines.map((l) => `${l.key}:${l.workThisPeriodCents}`).join("|") : "";
  useEffect(() => {
    if (!app) return;
    setAmounts(Object.fromEntries(app.lines.filter((l) => l.kind !== "trade").map((l) => [l.key, l.workThisPeriodCents])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey]);

  if (app === undefined) return <p className="text-sm text-ink-subtle" role="status">Loading owner pay app…</p>;
  const dirty = app.lines.some((l) => l.kind !== "trade" && (amounts[l.key] ?? 0) !== l.workThisPeriodCents);

  async function saveLines(): Promise<boolean> {
    setSaving(true);
    setErrors({});
    try {
      await save({ ownerPayAppId, entries: Object.entries(amounts).map(([key, cents]) => ({ key, workThisPeriodCents: cents ?? 0 })) });
      return true;
    } catch (err) {
      const data = (err as { data?: { lineErrors?: { key: string; message: string }[] } }).data;
      if (data?.lineErrors) setErrors(Object.fromEntries(data.lineErrors.map((e) => [e.key, e.message])));
      toast.error(getErrorMessage(err, "The owner pay app could not be saved."));
      return false;
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="owner-pay-app">
      <AppHeader app={app} />
      {app.pendingNote ? (
        <p className="rounded-lg border border-amber-700 bg-amber-950/40 px-3 py-2 text-sm text-amber-100" data-testid="owner-pending-note">
          {app.pendingNote} – it contributes $0.00 until you approve it.
        </p>
      ) : null}
      {app.status === "changes_requested" && app.changesRequestedComment ? (
        <p className="rounded-lg border border-amber-700 bg-amber-950/40 px-3 py-2 text-sm text-amber-100" data-testid="owner-changes-comment">
          The owner requested changes: “{app.changesRequestedComment}”
        </p>
      ) : null}
      <G702Summary app={app} />
      <PrimeSheet app={app} amounts={amounts} errors={errors} onAmount={(key, cents) => setAmounts((a) => ({ ...a, [key]: cents }))} />
      <div className="flex flex-wrap gap-2">
        {app.controls.edit ? (
          <Button variant="secondary" loading={saving} disabled={!dirty} onClick={() => void saveLines().then((ok) => ok && toast.success("Saved."))} data-testid="owner-pay-app-save">
            Save
          </Button>
        ) : null}
        {app.controls.submit ? (
          <Button onClick={() => setConfirm("submit")} data-testid="owner-pay-app-submit">
            Submit to owner
          </Button>
        ) : null}
        {app.controls.delete ? (
          <Button variant="danger" onClick={() => setConfirm("delete")} data-testid="owner-pay-app-delete">
            Delete draft
          </Button>
        ) : null}
      </div>
      {app.invoiceBlockedReason && app.controls.submit ? <p className="text-xs text-amber-200">{app.invoiceBlockedReason}</p> : null}
      <InvoicePanel app={app} />
      <History app={app} />
      <ConfirmDialog
        open={confirm === "submit"}
        title={`Submit owner pay app #${app.applicationNo} to the owner?`}
        amountCents={app.figures.currentPaymentDueCents}
        amountLabel="Current payment due"
        details={[
          { label: "Retainage", value: formatCents(app.figures.retainageCents) },
          { label: "Period ending", value: formatDate(app.periodEnd) },
        ]}
        effect="The owner is notified and reviews it in the owner portal. You can't edit its lines unless the owner requests changes."
        confirmLabel="Submit to owner"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (dirty && !(await saveLines())) throw new Error("Fix the amounts before submitting.");
          await submit({ ownerPayAppId });
          toast.success(`Owner pay app #${app.applicationNo} submitted to the owner.`);
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        title={`Delete draft owner pay app #${app.applicationNo}?`}
        effect="The draft is removed. You can create it again from the approved sub pay apps."
        confirmLabel="Delete draft"
        tone="danger"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          await remove({ ownerPayAppId });
          toast.success("Draft deleted.");
          setConfirm(null);
        }}
      />
    </div>
  );
}

/** A deleted draft or one returned out of view leaves a stale selection; fall back to the first row. */
function pickCurrent(rows: List["rows"], selected: string | null): string | null {
  if (selected !== null && rows.some((r) => r._id === selected)) return selected;
  return rows[0]?._id ?? null;
}

function AppList({ list, selected, onSelect }: { list: List; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <ul className="divide-y divide-line rounded-lg border border-line text-sm" data-testid="owner-pay-app-list">
      {list.rows.map((r) => (
        <li key={r._id}>
          <button
            type="button"
            onClick={() => onSelect(r._id)}
            aria-current={selected === r._id ? "true" : undefined}
            className={`flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left hover:bg-slate-800 ${selected === r._id ? "bg-slate-800" : ""}`}
            data-testid="owner-pay-app-row"
          >
            <span>
              Owner pay app #{r.applicationNo} · {formatDate(r.periodEnd)}
            </span>
            <span className="flex items-center gap-2">
              <span className="tabular-nums">{formatCents(r.currentPaymentDueCents)}</span>
              <StatusPill status={r.status} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function GcProjectOwnerBilling({ projectId }: { projectId: string }) {
  const list = useQuery(api.billing.ownerPayApps.listOwnerPayApps, { projectId });
  const create = useMutation(api.billing.ownerPayApps.createOwnerPayApp);
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  if (list === undefined) return <p className="text-sm text-ink-subtle" role="status">Loading owner pay apps…</p>;
  const current = pickCurrent(list.rows, selected);
  return (
    <div className="space-y-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-subtle">Prime contract value</dt>
          <dd className="font-semibold tabular-nums">{list.contractValueCents === null ? "Not set" : formatCents(list.contractValueCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-subtle">Owner retainage</dt>
          <dd className="font-semibold">{formatBps(list.retainageBps)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-subtle">Retainage held by owner</dt>
          <dd className="font-semibold tabular-nums">{list.primeRetainageHeldCents === null ? "None yet" : formatCents(list.primeRetainageHeldCents)}</dd>
        </div>
      </dl>
      {list.create ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={!list.create.allowed}
            loading={creating}
            onClick={async () => {
              setCreating(true);
              try {
                const { ownerPayAppId } = await create({ projectId });
                setSelected(ownerPayAppId);
                toast.success("Owner pay app created from the approved sub pay apps.");
              } catch (err) {
                toast.error(getErrorMessage(err, "The owner pay app could not be created."));
              } finally {
                setCreating(false);
              }
            }}
            data-testid="owner-pay-app-new"
          >
            New owner pay app
          </Button>
          <span className="text-xs text-ink-subtle">
            {list.create.allowed && list.create.nextPeriodEnd ? `For the period ending ${formatDate(list.create.nextPeriodEnd)}` : list.create.reason}
          </span>
        </div>
      ) : null}
      {list.rows.length === 0 ? (
        <EmptyState
          title="No owner pay apps yet"
          description="An owner pay app bills the owner for the trade packages (from approved sub pay apps), your GC lines and approved prime change orders."
          headingLevel={3}
        />
      ) : (
        <>
          <AppList list={list} selected={current} onSelect={setSelected} />
          {current ? <GcOwnerPayApp key={current} ownerPayAppId={current} /> : null}
        </>
      )}
    </div>
  );
}

/** GC Billing → Owner billing. */
export function GcOwnerBilling() {
  const { loading, empty, selected, picker } = useOwnerBillingProject("gc");
  if (loading) return <p className="text-sm text-ink-subtle" role="status">Loading projects…</p>;
  if (empty) return <EmptyState title="No projects yet" description="Owner billing appears once you have a project." headingLevel={3} />;
  return (
    <div className="space-y-4" data-testid="gc-owner-billing">
      {picker}
      {selected ? <GcProjectOwnerBilling key={selected} projectId={selected} /> : null}
    </div>
  );
}

/** GC Billing → Documents: the generated PDFs and CSV exports on a project. */
export function GcBillingDocuments() {
  const { loading, empty, selected, picker } = useOwnerBillingProject("gc");
  if (loading) return <p className="text-sm text-ink-subtle" role="status">Loading projects…</p>;
  if (empty) return <EmptyState title="No projects yet" description="Documents appear once you have a project." headingLevel={3} />;
  return (
    <Card title="Documents" description="Pay app, owner pay app, change order and subcontract PDFs and CSV exports. Downloads require your sign-in.">
      <div className="space-y-4" data-testid="gc-billing-documents">
        {picker}
        {selected ? <ProjectDocumentsList key={selected} projectId={selected} /> : null}
      </div>
    </Card>
  );
}

// ---- Owner ---------------------------------------------------------------------------------------

function RequestChangesDialog({ app, open, onClose }: { app: Detail; open: boolean; onClose: () => void }) {
  const requestChanges = useMutation(api.billing.ownerPayApps.requestOwnerPayAppChanges);
  const toast = useToast();
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setComment("");
      setError(null);
    }
  }, [open]);
  async function send() {
    if (comment.trim() === "") {
      setError("Enter a comment telling the GC what to change.");
      return;
    }
    setBusy(true);
    try {
      await requestChanges({ ownerPayAppId: app._id, comment });
      toast.success("Returned to the GC for changes.");
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "The request could not be sent."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      title={`Request changes to owner pay app #${app.applicationNo}?`}
      description="The GC sees your comment and resubmits the pay app."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void send()} data-testid="owner-request-changes-confirm">
            Request changes
          </Button>
        </>
      }
    >
      <Field label="Comment" required error={error}>
        {(control) => (
          <textarea
            {...control}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            maxLength={1000}
            className={inputClass(Boolean(error), "py-2")}
            data-testid="owner-request-changes-comment"
          />
        )}
      </Field>
    </Dialog>
  );
}

function OwnerPayAppView({ ownerPayAppId }: { ownerPayAppId: string }) {
  const app = useQuery(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId });
  const approve = useAction(api.billing.ownerInvoices.approveOwnerPayApp);
  const toast = useToast();
  const [open, setOpen] = useState<"approve" | "changes" | null>(null);
  if (app === undefined) return <p className="text-sm text-ink-subtle" role="status">Loading owner pay app…</p>;
  return (
    <div className="space-y-4" data-testid="owner-pay-app">
      <AppHeader app={app} />
      <G702Summary app={app} />
      <PrimeSheet app={app} amounts={{}} errors={{}} />
      <div className="flex flex-wrap gap-2">
        {app.controls.approve ? (
          <Button onClick={() => setOpen("approve")} data-testid="owner-pay-app-approve">
            Approve
          </Button>
        ) : null}
        {app.controls.requestChanges ? (
          <Button variant="secondary" onClick={() => setOpen("changes")} data-testid="owner-pay-app-request-changes">
            Request changes
          </Button>
        ) : null}
      </div>
      {app.controls.approve && app.invoiceBlockedReason ? <p className="text-xs text-amber-200">{app.invoiceBlockedReason}</p> : null}
      <InvoicePanel app={app} />
      <History app={app} />
      <ConfirmDialog
        open={open === "approve"}
        title={`Approve owner pay app #${app.applicationNo}?`}
        amountCents={app.figures.currentPaymentDueCents}
        amountLabel="Current payment due"
        payee={app.recipientEmail ?? "No billing email set"}
        payeeLabel="Invoice to"
        details={[{ label: "Retainage held", value: formatCents(app.figures.retainageCents) }]}
        effect="Approves the application and creates a PayPal invoice for the current payment due, sent to your company's billing email. An approved application can't be changed."
        confirmLabel="Approve"
        onCancel={() => setOpen(null)}
        onConfirm={async () => {
          await approve({ ownerPayAppId: app._id as Id<"ownerPayApps"> });
          toast.success(`Owner pay app #${app.applicationNo} approved and invoiced.`);
          setOpen(null);
        }}
      />
      <RequestChangesDialog app={app} open={open === "changes"} onClose={() => setOpen(null)} />
    </div>
  );
}

function OwnerProjectPayApps({ projectId }: { projectId: string }) {
  const list = useQuery(api.billing.ownerPayApps.listOwnerPayApps, { projectId });
  const [selected, setSelected] = useState<string | null>(null);
  if (list === undefined) return <p className="text-sm text-ink-subtle" role="status">Loading owner pay apps…</p>;
  const current = pickCurrent(list.rows, selected);
  return (
    <div className="space-y-4">
      <p className="text-sm" data-testid="owner-prime-retainage">
        Retainage you hold on this contract:{" "}
        <span className="font-semibold tabular-nums">{list.primeRetainageHeldCents === null ? "None yet" : formatCents(list.primeRetainageHeldCents)}</span>
      </p>
      {list.rows.length === 0 ? (
        <EmptyState title="No owner pay apps yet" description="Pay applications from your GC appear here once they are submitted to you." headingLevel={3} />
      ) : (
        <>
          <AppList list={list} selected={current} onSelect={setSelected} />
          {current ? <OwnerPayAppView key={current} ownerPayAppId={current} /> : null}
        </>
      )}
      <section className="space-y-2" aria-labelledby="owner-documents-heading" data-testid="owner-documents">
        <h3 id="owner-documents-heading" className="text-base font-semibold">
          Documents
        </h3>
        <ProjectDocumentsList projectId={projectId} />
      </section>
    </div>
  );
}

/** Owner → Owner pay apps: review, approve (PayPal invoice) or return the GC's pay applications. */
export function OwnerPayAppsPage() {
  const { loading, empty, selected, picker } = useOwnerBillingProject("owner");
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Owner pay apps"
        description="Your GC's pay applications on the prime contract. Approving one sends you a PayPal invoice for the current payment due."
      />
      {loading ? (
        <p className="text-sm text-ink-subtle" role="status">
          Loading projects…
        </p>
      ) : empty ? (
        <EmptyState title="No projects yet" description="Owner pay apps appear once you are the owner on a project." />
      ) : (
        <Card>
          <div className="space-y-4">
            {picker}
            {selected ? <OwnerProjectPayApps key={selected} projectId={selected} /> : null}
          </div>
        </Card>
      )}
    </div>
  );
}
