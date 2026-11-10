import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import type { ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { billingTabHash, ledgerHash, payAppHash } from "../auth/navigation";
import { demoAgreementNumber, demoProjectName } from "../lib/demoCopy";
import { termsForKind, type ProjectKind } from "../lib/terms";
import { Card, formatBps, formatCents, formatDate } from "../ui";

/**
 * The GC money strip: collected from the owner, paid to subs, subcontract retainage held,
 * owner retainage held from the GC and approved work owed this week. Every figure is the stored
 * cents `billing/projectMoney.getProjectMoney` returned — this component adds no money math, it
 * only labels the buckets and links each one to the rows behind it.
 *
 * Omit `projectId` for the portfolio scope (the GC home). Portfolio keeps the neutral plural
 * "Collected from owners"; a project scope uses the kind-keyed singular, so commercial jobs never
 * read "homeowner" and residential jobs never read the commercial owner label.
 */

type Money = FunctionReturnType<typeof api.billing.projectMoney.getProjectMoney>;
type OwnerReceipt = Money["receipts"]["ownerPayApps"][number];
type PayoutReceipt = Money["receipts"]["payouts"][number];
type RetainageReceipt = Money["receipts"]["retainage"][number];
type OwedReceipt = Money["receipts"]["owed"][number];

/** The owner-facing route for draws and owner pay apps (architecture §6.2). */
const OWNER_PAY_APPS_HASH = "#/owner-pay-apps";
const RECEIPT_LINK = "inline-flex min-h-6 items-center rounded text-emerald-300 underline underline-offset-2";

export interface ProjectMoneyStripProps {
  /** The job to scope to. Omit for the portfolio across every job where the caller is the GC. */
  projectId?: string;
  className?: string;
}

function collectedLabel(kind: "portfolio" | "project", projectKind: ProjectKind | null): string {
  if (kind === "portfolio") return "Collected from owners";
  return termsForKind(projectKind).moneyStrip.collected;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

function MoneyCell({
  label,
  testId,
  cents,
  href,
  note,
  zeroSentence,
  zeroAction,
  zeroHref,
}: {
  label: string;
  testId: string;
  cents: number;
  href: string;
  note: ReactNode;
  zeroSentence: ReactNode;
  zeroAction: string;
  zeroHref: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface-sunken p-2.5 sm:p-3">
      <dl>
        <dt className="text-xs font-medium text-ink-subtle">{label}</dt>
        <dd className="mt-1 text-xl font-semibold tabular-nums text-ink sm:text-2xl" data-testid={testId}>
          <a href={href} className="rounded hover:underline">
            {formatCents(cents)}
          </a>
        </dd>
      </dl>
      {cents === 0 ? (
        <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
          {zeroSentence}{" "}
          <a href={zeroHref} className={RECEIPT_LINK}>
            {zeroAction}
          </a>
        </p>
      ) : (
        <div className="mt-1 space-y-0.5 text-xs leading-snug text-ink-subtle">{note}</div>
      )}
    </div>
  );
}

function ReceiptList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-1">
      <h3 className="text-xs font-semibold text-ink-muted">{title}</h3>
      <ul className="space-y-1 text-xs text-ink-subtle">{children}</ul>
    </section>
  );
}

export function ProjectMoneyStrip({ projectId, className }: ProjectMoneyStripProps) {
  const args: { projectId?: Id<"projects"> } = projectId ? { projectId: projectId as Id<"projects"> } : {};
  const money = useQuery(api.billing.projectMoney.getProjectMoney, args);
  // Paid change-order receipts already have a project-scoped reader. Only the residential project
  // strip needs them for its inclusive collected figure; portfolio and commercial reads stay as-is.
  const changeOrders = useQuery(
    api.billing.changeOrders.listForProject,
    projectId !== undefined && money?.scope.projectKind === "residential" ? { projectId } : "skip",
  );

  if (money === undefined) {
    return (
      <Card className={className} data-testid="project-money-strip" aria-busy="true">
        <p role="status" className="text-sm text-ink-subtle">
          Loading the money…
        </p>
      </Card>
    );
  }

  const scope = money.scope;
  const portfolio = scope.kind === "portfolio";
  const projectKind: ProjectKind | null = scope.projectKind;
  const residentialProject = !portfolio && projectKind === "residential";
  const terms = termsForKind(projectKind);
  const ownerBillTitle = portfolio ? "Owner pay app" : terms.ownerBillTitle;
  const ownerBillLower = portfolio ? "owner pay app" : terms.ownerBillLower;
  const ownerBillPlural = portfolio ? "owner pay apps" : terms.ownerBillsLower;

  const ownerReceipts = money.receipts.ownerPayApps;
  const payoutReceipts = money.receipts.payouts;
  const retainageReceipts = money.receipts.retainage;
  const owedReceipts = money.receipts.owed;
  const paidChangeOrderReceipts = residentialProject
    ? (changeOrders?.prime?.changeOrders ?? []).filter((receipt) => receipt.status === "paid")
    : [];
  const retainageAgreements = new Set(retainageReceipts.map((entry) => entry.agreementId)).size;
  // The two rates behind the two retainage figures: the owner's rate on the project(s) and the
  // subcontract rate on the retainage ledger. Only label a rate when every contributing row agrees.
  const uniqueBps = (values: Array<number | null | undefined>): number[] =>
    [...new Set(values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)))];
  const ownerRates = uniqueBps(scope.projects.map((entry) => entry.ownerRetainageBps));
  const subRates = uniqueBps(retainageReceipts.map((entry) => entry.retainageBps));
  // A project-scoped commercial strip keeps the owner word; everything else uses the residential one.
  const ownerNoun = scope.kind === "project" && projectKind !== "residential" ? "owner" : "homeowner";
  const ownerRateLabel = ownerRates.length === 1 ? `${formatBps(ownerRates[0])} from the ${ownerNoun}` : null;
  const subRateLabel = subRates.length === 1 ? `${formatBps(subRates[0])} to the sub` : null;

  const paidToSubsHref =
    !portfolio && payoutReceipts.length > 0
      ? ledgerHash(payoutReceipts[0].agreementId)
      : "#/payments";

  const projectTitleById = new Map<string, string>(scope.projects.map((entry) => [entry.projectId, entry.projectTitle]));
  const receiptProject = (id: string) =>
    portfolio ? `${demoProjectName(projectTitleById.get(id) ?? "Job")} · ` : "";

  const changeOrderNote = paidChangeOrderReceipts.length > 0
    ? ` and ${paidChangeOrderReceipts.length} paid ${plural(paidChangeOrderReceipts.length, "change order", "change orders")}`
    : "";
  const collectedNote = (
    <>
      <span className="hidden sm:inline">From {ownerReceipts.length} paid {plural(ownerReceipts.length, ownerBillLower, ownerBillPlural)}{changeOrderNote}.</span>
      <span className="sm:hidden">{ownerReceipts.length} paid {portfolio ? "app" : ownerBillLower}{ownerReceipts.length === 1 ? "" : "s"}{changeOrderNote}.</span>
    </>
  );
  const paidToSubsNote = (
    <>
      <span className="hidden sm:inline">Net of retainage, from {payoutReceipts.length} successful {plural(payoutReceipts.length, "payout", "payouts")}.</span>
      <span className="sm:hidden">{payoutReceipts.length} {plural(payoutReceipts.length, "payout", "payouts")}, net.</span>
    </>
  );
  const retainageNote =
    retainageAgreements > 0
      ? `Held on ${retainageAgreements} subcontract${retainageAgreements === 1 ? "" : "s"}.`
      : "Held from subcontract retainage.";
  const owedNote = `Due by ${formatDate(money.weekEnd)}.`;

  const title = portfolio
    ? "Money across your jobs"
    : projectKind === "residential" && scope.projectTitle
      ? `Money on this job · ${demoProjectName(scope.projectTitle)}`
      : "Money on this job";
  const description = portfolio
    ? "Across every job where you are the general contractor, including the separate commercial reference job: collected from owners, paid to subs, retainage held and owed this week."
    : terms.moneyStrip.description;

  const hasReceipts =
    ownerReceipts.length > 0 || payoutReceipts.length > 0 || retainageReceipts.length > 0 || owedReceipts.length > 0 || paidChangeOrderReceipts.length > 0;

  return (
    <Card
      className={className}
      data-testid="project-money-strip"
      data-money-scope={scope.kind}
      data-project-kind={projectKind ?? undefined}
      title={title}
      description={portfolio ? (
        <>
          <span className="sm:hidden">Includes the separate commercial reference job.</span>
          <span className="hidden sm:inline">{description}</span>
        </>
      ) : <span className="hidden sm:inline">{description}</span>}
    >
      <div className={residentialProject ? "grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 xl:grid-cols-5" : "grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4"}>
        <MoneyCell
          label={collectedLabel(scope.kind, projectKind)}
          testId="project-money-collected"
          cents={residentialProject ? money.collectedFromOwnerInclChangeOrdersCents : money.collectedFromOwnerCents}
          href={OWNER_PAY_APPS_HASH}
          note={collectedNote}
          zeroSentence={
            <>
              <span className="hidden sm:inline">
                {portfolio ? "No owner pay app has been paid yet." : `No ${ownerBillLower} has been paid yet.`}
              </span>
              <span className="sm:hidden">Nothing yet.</span>
            </>
          }
          zeroAction={portfolio ? "Open owner pay apps" : `Open ${terms.ownerBills.toLowerCase()}`}
          zeroHref={OWNER_PAY_APPS_HASH}
        />
        <MoneyCell
          label="Paid to subs"
          testId="project-money-paid-subs"
          cents={money.paidToSubsCents}
          href={paidToSubsHref}
          note={paidToSubsNote}
          zeroSentence={<><span className="hidden sm:inline">No subcontractor payout has succeeded yet.</span><span className="sm:hidden">Nothing yet.</span></>}
          zeroAction="Open payments"
          zeroHref="#/payments"
        />
        <MoneyCell
          label={terms.moneyStrip.subRetainage}
          testId="project-money-retainage"
          cents={money.retainageHeldCents}
          href={billingTabHash("retainage")}
          note={
            <>
              <span className="block">{subRateLabel ?? <><span className="hidden sm:inline">{retainageNote}</span><span className="sm:hidden">{retainageAgreements} subcontract{retainageAgreements === 1 ? "" : "s"}.</span></>}</span>
              {!residentialProject && money.ownerRetainageHeldCents > 0 ? (
                <span className="block" data-testid="project-money-owner-retainage">
                  {formatCents(money.ownerRetainageHeldCents)}
                  {ownerRateLabel ? ` at ${ownerRateLabel}` : ` held from the ${ownerNoun}`}
                </span>
              ) : null}
            </>
          }
          zeroSentence={<><span className="hidden sm:inline">No subcontract retainage is held yet.</span><span className="sm:hidden">Nothing yet.</span></>}
          zeroAction="Open retainage"
          zeroHref={billingTabHash("retainage")}
        />
        {residentialProject ? (
          <MoneyCell
            label={terms.moneyStrip.ownerRetainage}
            testId="project-money-retainage-held-from-you"
            cents={money.ownerRetainageHeldCents}
            href={billingTabHash("owner-billing")}
            note={
              <span className="block" data-testid="project-money-owner-retainage">
                {formatCents(money.ownerRetainageHeldCents)}
                {ownerRateLabel ? ` at ${ownerRateLabel}` : ` held from the ${ownerNoun}`}
              </span>
            }
            zeroSentence={<><span className="hidden sm:inline">No retainage is held from you yet.</span><span className="sm:hidden">Nothing held from you.</span></>}
            zeroAction="Open owner billing"
            zeroHref={billingTabHash("owner-billing")}
          />
        ) : null}
        <MoneyCell
          label="Owed this week"
          testId="project-money-owed"
          cents={money.owedThisWeekCents}
          href="#/billing"
          note={owedNote}
          zeroSentence={<><span className="hidden sm:inline">No approved pay app is due this week.</span><span className="sm:hidden">Nothing due this week.</span></>}
          zeroAction="Open billing"
          zeroHref="#/billing"
        />
      </div>

      {hasReceipts ? (
        <details className="mt-3 rounded-lg border border-line bg-surface-sunken" data-testid="project-money-receipts">
          <summary className="min-h-6 cursor-pointer px-3 py-2 text-xs font-semibold text-ink-muted">
            Receipts behind these numbers
          </summary>
          <div className="space-y-3 border-t border-line px-3 py-3">
            {ownerReceipts.length > 0 ? (
              <ReceiptList title={portfolio ? "Paid owner pay apps" : `Paid ${terms.ownerBillsLower}`}>
                {ownerReceipts.slice(0, 4).map((receipt: OwnerReceipt) => (
                  <li key={receipt.ownerPayAppId}>
                    <a href={billingTabHash("owner-billing")} className={RECEIPT_LINK}>
                      {receiptProject(receipt.projectId)}
                      {ownerBillTitle} #{receipt.applicationNo}
                    </a>{" "}
                    · <span className="tabular-nums">{formatCents(receipt.amountCents)}</span>
                    {receipt.paidAt ? ` · paid ${formatDate(receipt.paidAt)}` : ""}
                    {receipt.paypalInvoiceId ? ` · invoice ${receipt.paypalInvoiceId}` : ""}
                    {residentialProject && receipt.retainageCents > 0 ? ` · ${formatCents(receipt.retainageCents)} retainage held from you` : ""}
                  </li>
                ))}
                {ownerReceipts.length > 4 ? (
                  <li>
                    <a href={OWNER_PAY_APPS_HASH} className={RECEIPT_LINK}>
                      View all {ownerReceipts.length} {ownerBillPlural}
                    </a>
                  </li>
                ) : null}
              </ReceiptList>
            ) : null}

            {paidChangeOrderReceipts.length > 0 ? (
              <ReceiptList title="Paid change orders">
                {paidChangeOrderReceipts.slice(0, 4).map((receipt) => (
                  <li key={receipt._id}>
                    <a href={`#/change-orders/${encodeURIComponent(receipt._id)}`} className={RECEIPT_LINK}>
                      {receipt.label} · {receipt.title}
                    </a>{" "}
                    · <span className="tabular-nums">{formatCents(receipt.amountCents)}</span>
                    {receipt.paidAt ? ` · paid ${formatDate(receipt.paidAt)}` : ""}
                    {receipt.paypalInvoiceId ? ` · invoice ${receipt.paypalInvoiceId}` : ""}
                  </li>
                ))}
              </ReceiptList>
            ) : null}

            {payoutReceipts.length > 0 ? (
              <ReceiptList title="Sub payouts">
                {payoutReceipts.slice(0, 4).map((receipt: PayoutReceipt) => (
                  <li key={receipt.paymentId}>
                    <a href={ledgerHash(receipt.agreementId)} className={RECEIPT_LINK}>
                      {receiptProject(receipt.projectId)}
                      {demoAgreementNumber(receipt.agreementNumber)}
                    </a>{" "}
                    · <span className="tabular-nums">{formatCents(receipt.amountCents)}</span> net
                    {receipt.kind === "retainage_release" ? " retainage release" : " payout"}
                    {receipt.paidAt ? ` · ${formatDate(receipt.paidAt)}` : ""}
                  </li>
                ))}
                {payoutReceipts.length > 4 ? (
                  <li>
                    <a href="#/payments" className={RECEIPT_LINK}>
                      View all payouts in Payments
                    </a>
                  </li>
                ) : null}
              </ReceiptList>
            ) : null}

            {retainageReceipts.length > 0 ? (
              <ReceiptList title="Retainage ledger">
                {retainageReceipts.slice(0, 4).map((receipt: RetainageReceipt, index) => (
                  <li key={`${receipt.agreementId}-${index}`}>
                    <a href={billingTabHash("retainage")} className={RECEIPT_LINK}>
                      {receiptProject(receipt.projectId)}
                      {demoAgreementNumber(receipt.agreementNumber)}
                    </a>{" "}
                    · <span className="tabular-nums">{formatCents(receipt.amountCents)}</span>{" "}
                    {receipt.amountCents < 0 ? "released" : "held"}
                  </li>
                ))}
                {retainageReceipts.length > 4 ? (
                  <li>
                    <a href={billingTabHash("retainage")} className={RECEIPT_LINK}>
                      View all retainage rows
                    </a>
                  </li>
                ) : null}
              </ReceiptList>
            ) : null}

            {owedReceipts.length > 0 ? (
              <ReceiptList title="Due this week">
                {owedReceipts.slice(0, 4).map((receipt: OwedReceipt) => (
                  <li key={receipt.payAppId}>
                    <a href={payAppHash(receipt.payAppId)} className={RECEIPT_LINK}>
                      {receiptProject(receipt.projectId)}
                      {demoAgreementNumber(receipt.agreementNumber)} · due {formatDate(receipt.dueDate)}
                    </a>{" "}
                    · <span className="tabular-nums">{formatCents(receipt.amountCents)}</span>
                  </li>
                ))}
                {owedReceipts.length > 4 ? (
                  <li>
                    <a href="#/billing" className={RECEIPT_LINK}>
                      View all approved pay apps
                    </a>
                  </li>
                ) : null}
              </ReceiptList>
            ) : null}
          </div>
        </details>
      ) : null}

      {money.truncated ? (
        <p className="mt-3 text-xs text-amber-200">
          Some receipts are beyond this screen’s read limit, so a figure can understate the full ledger.
        </p>
      ) : null}
    </Card>
  );
}
