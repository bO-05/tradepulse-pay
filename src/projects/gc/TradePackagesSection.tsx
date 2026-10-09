import { useMutation, useQuery } from "convex/react";
import { FormEvent, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { getErrorMessage } from "../../lib/errors";
import { Button, Card, DateInput, EmptyState, MoneyInput, StatusPill, TextInput, useToast } from "../../ui";
import { openProcurementPackages, openSpecBreakdown } from "./specBreakdownRequest";

const CSI_FORMAT = /^\d{2} \d{2} \d{2}$/;

function isoDateInDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Manual trade package form: CSI division, trade name, budget, bid due date, optional scope. */
export function AddTradePackageForm({
  projectId,
  projectTitle,
  onDone,
  onCancel,
}: {
  projectId: Id<"projects">;
  projectTitle: string;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const create = useMutation(api.tradePackages.createTradePackage);
  const toast = useToast();
  const [csiDivision, setCsiDivision] = useState("");
  const [tradeName, setTradeName] = useState("");
  const [budgetCents, setBudgetCents] = useState<number | null>(null);
  const [bidDeadline, setBidDeadline] = useState(() => isoDateInDays(14));
  const [scopeSummary, setScopeSummary] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const csi = csiDivision.trim().replace(/\s+/g, " ");
    const next: Record<string, string> = {};
    if (!CSI_FORMAT.test(csi)) next.csiDivision = "Use the CSI format NN NN NN, for example 26 00 00.";
    if (!tradeName.trim()) next.tradeName = "Enter the trade name.";
    if (budgetCents === null || budgetCents <= 0) next.budget = "Enter a budget estimate greater than $0.00.";
    if (!bidDeadline) next.bidDeadline = "Choose the bid due date.";
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;
    setSaving(true);
    try {
      await create({
        projectId,
        csiDivision: csi,
        tradeName: tradeName.trim(),
        budgetEstimate: (budgetCents ?? 0) / 100,
        scopeSummary: scopeSummary.trim() || `${tradeName.trim()} scope for ${projectTitle}.`,
        mandatoryInclusions: [],
        bidDeadline,
      });
      toast.success(`Trade package ${csi} ${tradeName.trim()} added.`);
      setCsiDivision("");
      setTradeName("");
      setBudgetCents(null);
      setScopeSummary("");
      onDone?.();
    } catch (err) {
      setFormError(getErrorMessage(err, "We couldn't add the trade package. Try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Add a trade package manually" className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
        <TextInput
          id="pkg-csi"
          label="CSI division"
          required
          value={csiDivision}
          onChange={setCsiDivision}
          error={errors.csiDivision}
          placeholder="26 00 00"
          maxLength={8}
        />
        <TextInput
          id="pkg-trade"
          label="Trade name"
          required
          value={tradeName}
          onChange={setTradeName}
          error={errors.tradeName}
          placeholder="e.g. Electrical"
          maxLength={120}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <MoneyInput id="pkg-budget" label="Budget estimate" required value={budgetCents} onChange={setBudgetCents} error={errors.budget} />
        <DateInput id="pkg-deadline" label="Bid due date" required value={bidDeadline} onChange={setBidDeadline} error={errors.bidDeadline} />
      </div>
      <TextInput
        id="pkg-scope"
        label="Scope summary"
        value={scopeSummary}
        onChange={setScopeSummary}
        hint="Optional. You can refine scope and inclusions in Procurement."
        maxLength={500}
      />
      {formError && (
        <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
          {formError}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={saving} loadingLabel="Adding…">
          Add package
        </Button>
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** The project's trade packages with the two ways to add them: manually or by AI spec breakdown. */
export function TradePackagesSection({
  projectId,
  projectTitle,
  readOnly,
}: {
  projectId: Id<"projects">;
  projectTitle: string;
  readOnly?: boolean;
}) {
  const packages = useQuery(api.tradePackages.listByProject, { projectId });
  const [adding, setAdding] = useState(false);
  const addButtons = readOnly ? null : (
    <>
      <Button onClick={() => setAdding(true)}>Add trade package</Button>
      <Button variant="secondary" onClick={() => openSpecBreakdown(projectId)}>
        AI spec breakdown
      </Button>
    </>
  );

  return (
    <Card
      title="Trade packages"
      actions={packages && packages.length > 0 && !adding ? addButtons : undefined}
    >
      {packages === undefined ? (
        <p role="status" className="text-sm text-ink-subtle">
          Loading trade packages…
        </p>
      ) : (
        <div className="space-y-4">
          {adding && (
            <AddTradePackageForm projectId={projectId} projectTitle={projectTitle} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
          )}
          {packages.length === 0 && !adding && (
            <EmptyState
              headingLevel={3}
              title="No trade packages yet"
              description="Add packages manually, or let AI break the project specification into CSI MasterFormat packages."
              action={addButtons}
            />
          )}
          {packages.length > 0 && (
            <ul className="divide-y divide-line text-sm">
              {packages.map((p) => (
                <li key={p._id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <span className="font-mono text-ink-subtle">{p.csiDivision}</span> <span className="font-semibold">{p.tradeName}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusPill status={p.status} />
                    {!readOnly && (
                      <button
                        type="button"
                        className="text-sm text-emerald-300 underline-offset-2 hover:underline"
                        onClick={() => openProcurementPackages(projectId)}
                      >
                        Open in Procurement
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
