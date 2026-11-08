import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { termsForKind, type ProjectKind } from "../../lib/terms";
import { MoneyTrail, formatDate, statusLabelFor, type MoneyTrailStep } from "../../ui";

/**
 * The owner side of the GC project page: the contract, the latest draw, the retainage the owner
 * holds and what the owner has actually paid. Every figure is a stored cent from
 * `billing/ownerPayApps.listOwnerPayApps`; the component derives only a sum of paid rows.
 */
export function ProjectMoneyTrail({
  projectId,
  projectTitle,
  projectKind,
  contractValueCents,
}: {
  projectId: Id<"projects">;
  projectTitle: string;
  projectKind?: ProjectKind | null;
  contractValueCents?: number;
}) {
  const list = useQuery(api.billing.ownerPayApps.listOwnerPayApps, { projectId });
  if (list === undefined || list.rows.length === 0) return null;

  const terms = termsForKind(list.projectKind ?? projectKind);
  const latest = list.rows[0];
  const paidByOwnerCents = list.rows
    .filter((row) => row.status === "paid")
    .reduce((sum, row) => sum + row.currentPaymentDueCents, 0);
  const latestNote = [
    statusLabelFor(latest.status, list.projectKind ?? projectKind),
    latest.paidAt ? `paid ${formatDate(latest.paidAt)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const steps: MoneyTrailStep[] = [
    {
      label: "Contract",
      valueCents: contractValueCents ?? list.contractValueCents,
      note: projectTitle,
    },
    {
      label: `${terms.ownerBillTitle} #${latest.applicationNo}`,
      valueCents: latest.currentPaymentDueCents,
      note: latestNote,
    },
    {
      label: "Retainage held",
      valueCents: list.primeRetainageHeldCents ?? 0,
    },
    {
      label: list.projectKind === "residential" ? "Paid by the homeowner" : "Paid by the owner",
      valueCents: paidByOwnerCents,
      tone: paidByOwnerCents > 0 ? "positive" : "default",
    },
  ];

  return (
    <MoneyTrail
      testId="gc-money-trail"
      title="Money trail"
      description={`The owner's position on this job: the contract, the latest ${terms.ownerBillLower}, retainage and what the owner has paid.`}
      steps={steps}
    />
  );
}
