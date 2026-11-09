import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { DocumentDownloadButton, ProjectDocumentsList } from "../documents/DocumentDownload";
import { getErrorMessage } from "../lib/errors";
import { maskSandboxEmail } from "../lib/demoPrivacy";
import { demoDisplayName, demoProjectName } from "../lib/demoCopy";
import { tradeLineDisplay } from "../lib/tradeLineDisplay";
import { termsForKind, type ProjectKind } from "../lib/terms";
import { Button, Card, CommercialReferenceBadge, ConfirmDialog, Dialog, EmptyState, LinkButton, MoneyInput, MoneyTrail, PageHeader, StatusPill, formatBps, formatCents, formatDate, useToast, type LinkButtonVariant } from "../ui";
import { Field, inputClass } from "../ui/Field";
import { ReferenceNotice } from "../payments/ReferenceNotice";
import { ownerMoneyTotals } from "./ownerMoney";
import { ProjectMoneyStrip } from "./ProjectMoneyStrip";

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

/** A residential job leads the picker so the homeowner's draw is the first one a visitor sees. */
function residentialFirst<T extends { projectKind: ProjectKind }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => Number(b.projectKind === "residential") - Number(a.projectKind === "residential"));
}

/** The project picker shared by the GC tab and the owner page: only projects where the caller is that party. */
function useOwnerBillingProject(party: Party) {
  const projects = useQuery(api.billing.ownerPayApps.ownerBillingProjects, {});
  const mine = projects?.filter((p) => p.partyRole === party);
  const ordered = mine === undefined ? undefined : residentialFirst(mine);
  const [projectId, setProjectId] = useState<string | null>(null);
  const selected = projectId ?? ordered?.[0]?._id ?? null;
  const picker =
    ordered === undefined || ordered.length <= 1 ? (
      ordered?.[0] ? <p className="text-sm font-medium">{demoProjectName(ordered[0].title)}</p> : null
    ) : (
      <Field label="Project" className="max-w-sm">
        {(control) => (
          <select {...control} value={selected ?? ""} onChange={(e) => setProjectId(e.target.value)} className={inputClass(false)} data-testid="owner-billing-project">
            {ordered.map((p) => (
              <option key={p._id} value={p._id}>
                {demoProjectName(p.title)}
              </option>
            ))}
          </select>
        )}
      </Field>
    );
  return { loading: mine === undefined, empty: mine?.length === 0, selected, selectedKind: ordered?.find((p) => p._id === selected)?.projectKind ?? null, picker };
}

/** The owner-facing summary of an owner pay app (a draw on a residential job). */
export function G702Summary({ app }: { app: Detail }) {
  const terms = termsForKind(app.projectKind);
  const residential = terms.kind === "residential";
  const f = app.figures;
  const rows: [string, string, string][] = [
    ["1", "Original contract sum", formatCents(f.originalContractSumCents)],
    ["2", "Net change by change orders", signedCents(f.netChangeOrdersCents)],
    ["3", "Contract sum to date", formatCents(f.contractSumToDateCents)],
    ["4", residential ? "Total work completed to date" : "Total completed & stored to date", formatCents(f.completedAndStoredCents)],
    ["5", `Retainage (${formatBps(app.retainageBps)} on each ${residential ? "" : "prime "}line)`, formatCents(f.retainageCents)],
    ["6", "Total earned less retainage", formatCents(f.earnedLessRetainageCents)],
    ["7", terms.previousCertificates, formatCents(f.previousCertificatesCents)],
    ["8", residential ? terms.drawColumns.thisDraw : "Current payment due", formatCents(f.currentPaymentDueCents)],
    ["9", "Balance to finish, including retainage", formatCents(f.balanceToFinishInclRetainageCents)],
  ];
  const summary = (
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
  if (!residential) return summary;
  return (
    <div className="space-y-2">
      <h3 className="text-base font-semibold">{terms.summary}</h3>
      {summary}
    </div>
  );
}

/** One line's name plus the trade source; shared by the commercial and residential sheets. */
function SheetLineDescription({ line }: { line: Detail["lines"][number] }) {
  return (
    <td className="py-2 pr-2">
      {line.kind === "trade" ? tradeLineDisplay(line.description) : line.description}
      {line.kind === "trade" ? <span className="block text-xs text-ink-subtle">From approved sub pay apps</span> : null}
    </td>
  );
}

/**
 * The line-item sheet of the owner pay app. Commercial keeps the AIA continuation sheet verbatim.
 * Residential is a draw breakdown with exactly four money columns — Work completed, Previously
 * paid, This draw and Retainage — and never renders a stored-materials column.
 */
export function PrimeSheet({
  app,
  amounts,
  onAmount,
  errors,
  bare = false,
}: {
  app: Detail;
  amounts: Record<string, number | null>;
  onAmount?: (key: string, cents: number | null) => void;
  errors: Record<string, string>;
  /** The wrapper already names the sheet (for example a disclosure summary). */
  bare?: boolean;
}) {
  const terms = termsForKind(app.projectKind);
  const residential = terms.kind === "residential";
  const editable = onAmount !== undefined && app.controls.edit;
  if (residential) {
    return (
      <div className="space-y-2">
        {bare ? null : <h3 className="text-base font-semibold">{terms.breakdown}</h3>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm" data-testid="owner-g703">
            <caption className="sr-only">{terms.breakdown}</caption>
            <thead className="text-left text-xs text-ink-subtle">
              <tr>
                <th scope="col" className="py-2 pr-2 font-medium">#</th>
                <th scope="col" className="py-2 pr-2 font-medium">Description of work</th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">Scheduled value</th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">{terms.drawColumns.workCompleted}</th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">{terms.drawColumns.previouslyPaid}</th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">{terms.drawColumns.thisDraw}</th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">{terms.drawColumns.retainage}</th>
              </tr>
            </thead>
            <tbody>
              {app.lines.map((l) => (
                <tr key={l.key} className="border-t border-line align-top" data-testid="owner-g703-row" data-kind={l.kind}>
                  <td className="py-2 pr-2 tabular-nums">{l.lineNo}</td>
                  <SheetLineDescription line={l} />
                  <td className="py-2 pr-2 text-right tabular-nums">{formatCents(l.scheduledValueCents)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{formatCents(l.totalCents)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{formatCents(l.previousWorkCents + l.previousStoredCents)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {editable && l.kind !== "trade" ? (
                      <MoneyInput
                        label={<span className="sr-only">This draw for {l.description}</span>}
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
      </div>
    );
  }
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
              <SheetLineDescription line={l} />
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

/** Approved change orders billed with "Invoice now", which owner pay apps leave off. */
function DirectlyInvoicedNote({ app }: { app: Detail }) {
  const terms = termsForKind(app.projectKind);
  if (app.directlyInvoicedChangeOrders.length === 0) return null;
  return (
    <div className="rounded-lg border border-line px-3 py-2 text-sm" data-testid="owner-direct-invoiced">
      <p className="font-medium">Change orders invoiced separately</p>
      <p className="text-xs text-ink-subtle">
        {terms.kind === "residential"
          ? "These approved change orders were billed with their own PayPal invoice, so this draw leaves them off."
          : "These approved prime change orders were billed with their own PayPal invoice, so this pay app leaves them off."}
      </p>
      <ul className="mt-1 space-y-0.5">
        {app.directlyInvoicedChangeOrders.map((co) => (
          <li key={co._id} className="flex justify-between gap-3">
            <span>
              {co.label} – {co.title}
            </span>
            <span className="tabular-nums">{signedCents(co.amountCents)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the current roll-up would change on the saved draft (for example a sub pay app approved since). */
function RefreshPanel({ app, busy, onRefresh }: { app: Detail; busy: boolean; onRefresh: () => void }) {
  const terms = termsForKind(app.projectKind);
  const r = app.refresh;
  if (r === null) return null;
  const pair = (from: number, to: number) => `${formatCents(from)} → ${formatCents(to)}`;
  return (
    <div className="space-y-2 rounded-lg border border-sky-700 bg-sky-950/40 px-3 py-3 text-sm text-sky-100" role="status" data-testid="owner-refresh-panel">
      <p className="font-medium">
        The roll-up changed since this {terms.ownerBillLower} was saved. Review the new figures and refresh before submitting.
      </p>
      <ul className="space-y-0.5" data-testid="owner-refresh-changes">
        {r.lines.map((l) => (
          <li key={l.key} className="flex flex-wrap justify-between gap-3">
            <span>
              {l.description}
              {l.change === "added" ? " (new line)" : l.change === "removed" ? " (removed)" : ""}
            </span>
            <span className="tabular-nums">Completed & stored {pair(l.fromToDateCents, l.toToDateCents)}</span>
          </li>
        ))}
        {r.pendingSubPayApps.from !== r.pendingSubPayApps.to ? (
          <li>
            Sub pay apps not yet approved: {r.pendingSubPayApps.from} → {r.pendingSubPayApps.to}
          </li>
        ) : null}
        <li className="flex flex-wrap justify-between gap-3">
          <span>Contract sum to date</span>
          <span className="tabular-nums">{pair(r.contractSumToDate.fromCents, r.contractSumToDate.toCents)}</span>
        </li>
        <li className="flex flex-wrap justify-between gap-3 font-semibold">
          <span>{terms.drawColumns.thisDraw}</span>
          <span className="tabular-nums" data-testid="owner-refresh-due">
            {pair(r.currentPaymentDue.fromCents, r.currentPaymentDue.toCents)}
          </span>
        </li>
      </ul>
      <Button size="sm" loading={busy} onClick={onRefresh} data-testid="owner-pay-app-refresh">
        Refresh figures
      </Button>
    </div>
  );
}

function History({ app }: { app: Detail }) {
  return (
    <ol className="space-y-1 text-xs text-ink-subtle" data-testid="owner-pay-app-history">
      {app.history.map((h, i) => (
        <li key={i}>
          <StatusPill status={h.status} kind={app.projectKind} /> {formatDate(h.at)} by {demoDisplayName(h.byName)}
          {h.comment ? <span className="block pl-2 text-ink">“{h.comment}”</span> : null}
        </li>
      ))}
    </ol>
  );
}

function InvoicePanel({ app, linkVariant = "secondary" }: { app: Detail; linkVariant?: LinkButtonVariant }) {
  const terms = termsForKind(app.projectKind);
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
  const recipient = maskSandboxEmail(app.recipientEmail) ?? "the owner's billing email";
  return (
    <div className="space-y-2 rounded-lg border border-line p-3 text-sm" data-testid="owner-invoice-panel">
      <p className="font-medium">PayPal invoice</p>
      {app.paypalInvoiceId ? (
        <p>
          Invoice <span className="font-mono text-xs" data-testid="owner-invoice-id">{app.paypalInvoiceId}</span>
          {app.recipientEmail ? ` · sent to ${maskSandboxEmail(app.recipientEmail)}` : null}
        </p>
      ) : null}
      {app.paypalInvoiceStatus ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-ink-subtle">
          PayPal status <StatusPill status={app.paypalInvoiceStatus} />
        </p>
      ) : null}
      {app.payerViewUrl ? (
        <div>
          <LinkButton
            variant={linkVariant}
            size={linkVariant === "primary" ? "md" : "sm"}
            href={app.payerViewUrl}
            target="_blank"
            rel="noreferrer"
            data-testid="owner-invoice-payer-link"
          >
            Open the invoice in PayPal (sandbox)
          </LinkButton>
        </div>
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
        title={`Send the PayPal invoice for ${terms.ownerBill.toLowerCase()} #${app.applicationNo}?`}
        amountCents={app.figures.currentPaymentDueCents}
        amountLabel={terms.kind === "residential" ? "Invoice amount (this draw)" : "Invoice amount (current payment due)"}
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
  const terms = termsForKind(app.projectKind);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h3 className="text-base font-semibold">
        {terms.ownerBill} #{app.applicationNo} · period ending {formatDate(app.periodEnd)}
      </h3>
      <StatusPill status={app.status} kind={app.projectKind} />
      <CommercialReferenceBadge kind={app.projectKind} />
      <span className="text-sm text-ink-subtle">{percent(app.percentCompleteHundredths)} complete</span>
      <DocumentDownloadButton kind="owner_pay_app_pdf" relatedId={app._id} label="Download PDF" testId="owner-pay-app-download-pdf" />
    </div>
  );
}

// ---- GC ------------------------------------------------------------------------------------------

function GcOwnerPayApp({ ownerPayAppId }: { ownerPayAppId: string }) {
  const app = useQuery(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId });
  const save = useMutation(api.billing.ownerPayApps.saveOwnerPayApp);
  const refreshSheet = useMutation(api.billing.ownerPayApps.refreshOwnerPayApp);
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
  const terms = termsForKind(app.projectKind);
  const dirty = app.lines.some((l) => l.kind !== "trade" && (amounts[l.key] ?? 0) !== l.workThisPeriodCents);

  async function refreshFigures() {
    setSaving(true);
    try {
      // Unsaved amounts are saved with the refresh; otherwise the saved amounts are kept.
      if (dirty) {
        if (await saveLines()) toast.success("Figures refreshed.");
      } else {
        await refreshSheet({ ownerPayAppId });
        toast.success("Figures refreshed.");
      }
    } catch (err) {
      toast.error(getErrorMessage(err, "The figures could not be refreshed."));
    } finally {
      setSaving(false);
    }
  }

  async function saveLines(): Promise<boolean> {
    setSaving(true);
    setErrors({});
    try {
      await save({ ownerPayAppId, entries: Object.entries(amounts).map(([key, cents]) => ({ key, workThisPeriodCents: cents ?? 0 })) });
      return true;
    } catch (err) {
      const data = (err as { data?: { lineErrors?: { key: string; message: string }[] } }).data;
      if (data?.lineErrors) setErrors(Object.fromEntries(data.lineErrors.map((e) => [e.key, e.message])));
      toast.error(getErrorMessage(err, terms.kind === "residential" ? `The ${terms.ownerBillLower} could not be saved.` : "The owner pay app could not be saved."));
      return false;
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="owner-pay-app">
      <AppHeader app={app} />
      {app.readOnlyReference ? <ReferenceNotice title="Preserved reference job · read-only." /> : null}
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
      <RefreshPanel app={app} busy={saving} onRefresh={() => void refreshFigures()} />
      <G702Summary app={app} />
      <PrimeSheet app={app} amounts={amounts} errors={errors} onAmount={(key, cents) => setAmounts((a) => ({ ...a, [key]: cents }))} />
      <DirectlyInvoicedNote app={app} />
      <div className="flex flex-wrap gap-2">
        {app.controls.edit ? (
          <Button variant="secondary" loading={saving} disabled={!dirty} onClick={() => void saveLines().then((ok) => ok && toast.success("Saved."))} data-testid="owner-pay-app-save">
            Save
          </Button>
        ) : null}
        {app.controls.submit ? (
          <Button
            onClick={() => setConfirm("submit")}
            disabled={app.controls.refresh}
            title={app.controls.refresh ? "Refresh the figures before submitting." : undefined}
            data-testid="owner-pay-app-submit"
          >
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
        title={`Submit ${terms.ownerBill.toLowerCase()} #${app.applicationNo} to the owner?`}
        amountCents={app.figures.currentPaymentDueCents}
        amountLabel={terms.kind === "residential" ? "This draw" : "Current payment due"}
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
          toast.success(`${terms.ownerBill} #${app.applicationNo} submitted to the owner.`);
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        title={`Delete draft ${terms.ownerBill.toLowerCase()} #${app.applicationNo}?`}
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
  const terms = termsForKind(list.projectKind);
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
              {terms.ownerBill} #{r.applicationNo} · {formatDate(r.periodEnd)}
            </span>
            <span className="flex items-center gap-2">
              <span className="tabular-nums">{formatCents(r.currentPaymentDueCents)}</span>
              <StatusPill status={r.status} kind={list.projectKind} />
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
  const terms = termsForKind(list.projectKind);
  const current = pickCurrent(list.rows, selected);
  const totals = ownerMoneyTotals(list.rows);
  return (
    <div className="space-y-4">
      {list.readOnlyReference ? <ReferenceNotice title="Preserved reference job · read-only." /> : null}
      <CommercialReferenceBadge kind={list.projectKind} />
      <ProjectMoneyStrip projectId={projectId} />
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-subtle">{terms.kind === "residential" ? "Contract value" : "Prime contract value"}</dt>
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
      <dl className="grid gap-3 text-sm sm:grid-cols-3" data-testid="owner-money-strip">
        <div>
          <dt className="text-xs text-ink-subtle">Billed, awaiting the owner</dt>
          <dd className="font-semibold tabular-nums" data-testid="owner-money-submitted">{formatCents(totals.submittedCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-subtle">Approved, not yet paid</dt>
          <dd className="font-semibold tabular-nums" data-testid="owner-money-owed">{formatCents(totals.owedCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-subtle">Paid by the owner</dt>
          <dd className="font-semibold tabular-nums" data-testid="owner-money-paid">{formatCents(totals.paidCents)}</dd>
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
                toast.success(`${terms.ownerBill} created from the approved sub pay apps.`);
              } catch (err) {
                toast.error(getErrorMessage(err, `The ${terms.ownerBill.toLowerCase()} could not be created.`));
              } finally {
                setCreating(false);
              }
            }}
            data-testid="owner-pay-app-new"
          >
            New {terms.ownerBill.toLowerCase()}
          </Button>
          <span className="text-xs text-ink-subtle">
            {list.create.allowed && list.create.nextPeriodEnd ? `For the period ending ${formatDate(list.create.nextPeriodEnd)}` : list.create.reason}
          </span>
        </div>
      ) : null}
      {list.rows.length === 0 ? (
        <EmptyState
          title={terms.kind === "residential" ? "No draws yet" : "No owner pay apps yet"}
          description={
            terms.kind === "residential"
              ? "A draw bills the owner for the trades (from approved sub pay apps), your own GC lines and approved change orders."
              : "An owner pay app bills the owner for the trade packages (from approved sub pay apps), your GC lines and approved prime change orders."
          }
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
  const terms = termsForKind(app.projectKind);
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
      title={`Request changes to ${terms.ownerBill.toLowerCase()} #${app.applicationNo}?`}
      description={`The GC sees your comment and resubmits the ${terms.ownerBillLower}.`}
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
  const terms = termsForKind(app.projectKind);
  const residential = terms.kind === "residential";
  const dueNote =
    app.status === "paid"
      ? "Paid by PayPal"
      : app.status === "approved_invoiced"
        ? "Invoice sent to you"
        : app.status === "submitted_to_owner"
          ? "Waiting for your approval"
          : null;
  return (
    <div className="space-y-4" data-testid="owner-pay-app">
      <AppHeader app={app} />
      <MoneyTrail
        testId="owner-draw-money-trail"
        ariaLabel="Money trail"
        hero={{
          label: "Current payment due",
          valueCents: app.figures.currentPaymentDueCents,
          valueTestId: "owner-draw-payment-due",
          note: dueNote,
        }}
        steps={[
          { label: "Contract to date", valueCents: app.figures.contractSumToDateCents },
          {
            label: residential ? terms.drawColumns.workCompleted : "Completed & stored",
            valueCents: app.figures.completedAndStoredCents,
          },
          {
            label: "Retainage held",
            valueCents: app.figures.retainageCents,
            note: `${formatBps(app.retainageBps)} on each ${residential ? "" : "prime "}line`,
          },
          { label: residential ? "Previous draws" : "Previous payments", valueCents: app.figures.previousCertificatesCents },
        ]}
      />
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
      <InvoicePanel app={app} linkVariant={app.controls.approve ? "secondary" : "primary"} />
      <G702Summary app={app} />
      <details className="rounded-lg border border-line bg-surface px-3 py-2" data-testid="owner-draw-breakdown">
        <summary className="cursor-pointer py-1 text-sm font-medium text-ink">{terms.breakdown}</summary>
        <div className="mt-2">
          <PrimeSheet app={app} amounts={{}} errors={{}} bare />
        </div>
      </details>
      <DirectlyInvoicedNote app={app} />
      <History app={app} />
      <ConfirmDialog
        open={open === "approve"}
        title={`Approve ${terms.ownerBill.toLowerCase()} #${app.applicationNo}?`}
        amountCents={app.figures.currentPaymentDueCents}
        amountLabel={terms.kind === "residential" ? "This draw" : "Current payment due"}
        payee={maskSandboxEmail(app.recipientEmail) ?? "No billing email set"}
        payeeLabel="Invoice to"
        details={[{ label: "Retainage held", value: formatCents(app.figures.retainageCents) }]}
        effect={
          terms.kind === "residential"
            ? "Approves this draw and creates a PayPal invoice for this draw, sent to your company's billing email. An approved draw can't be changed."
            : "Approves the application and creates a PayPal invoice for the current payment due, sent to your company's billing email. An approved application can't be changed."
        }
        confirmLabel="Approve"
        onCancel={() => setOpen(null)}
        onConfirm={async () => {
          await approve({ ownerPayAppId: app._id as Id<"ownerPayApps"> });
          toast.success(`${terms.ownerBill} #${app.applicationNo} approved and invoiced.`);
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
  const terms = termsForKind(list.projectKind);
  const current = pickCurrent(list.rows, selected);
  return (
    <div className="space-y-4">
      {list.readOnlyReference ? <ReferenceNotice title="Preserved reference job · read-only." /> : null}
      <CommercialReferenceBadge kind={list.projectKind} />
      <p className="text-sm" data-testid="owner-prime-retainage">
        Retainage you hold on this contract:{" "}
        <span className="font-semibold tabular-nums">{list.primeRetainageHeldCents === null ? "None yet" : formatCents(list.primeRetainageHeldCents)}</span>
      </p>
      {list.rows.length === 0 ? (
        <EmptyState
          title={terms.kind === "residential" ? "No draws yet" : "No owner pay apps yet"}
          description={terms.kind === "residential" ? "Draws from your GC appear here once they are submitted to you." : "Pay applications from your GC appear here once they are submitted to you."}
          headingLevel={3}
        />
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

/** Owner → Owner draws: review, approve (PayPal invoice) or return the GC's applications. */
export function OwnerPayAppsPage() {
  const { loading, empty, selected, selectedKind, picker } = useOwnerBillingProject("owner");
  const terms = termsForKind(selectedKind);
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title={terms.ownerBills}
        description={
          terms.kind === "residential"
            ? "Your GC's draws on the contract. Approving one sends you a PayPal invoice for this draw."
            : "Your GC's pay applications on the prime contract. Approving one sends you a PayPal invoice for the current payment due."
        }
        meta={<CommercialReferenceBadge kind={selectedKind} />}
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
