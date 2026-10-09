import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { LevelingRow } from "../../convex/lib/levelingSummary";
import { getErrorMessage } from "../lib/errors";
import { buildCsv } from "../lib/csv";
import { Button, ConfirmDialog, DateText, Dialog, Money, MoneyInput, StatusPill, TextInput, formatCents, useToast } from "../ui";

export const PLUGS_NOT_INCLUDED = "Leveling plugs are not included in the contract sum.";

type PlugTarget = { row: LevelingRow; index: number };
type AwardTarget = { row: LevelingRow; accepted: number[] };

/** Contract sum preview; the server recomputes it from the stored bid (convex/lib/awardMath.ts). */
export function awardPreviewCents(row: Pick<LevelingRow, "baseAmountCents" | "alternates" | "veDeductCents">, accepted: readonly number[]): number {
  return row.baseAmountCents + accepted.reduce((s, i) => s + (row.alternates[i]?.amountCents ?? 0), 0) - row.veDeductCents;
}

/** Leveling CSV rows; amounts are the same formatted strings the screen shows. */
export function levelingCsv(rows: readonly LevelingRow[]): string {
  const headers = [
    "Bidder",
    "Base bid",
    "Leveling plugs (comparison only)",
    "Lead-time penalty",
    "COI penalty",
    "Accepted VE deducts",
    "Leveled (comparison only)",
    "Apparent low",
    "Leveled low",
    "Status",
    "Plug detail",
  ];
  const status = { awarded: "Awarded", not_awarded: "Not awarded", under_review: "Under review" } as const;
  return buildCsv(
    headers,
    rows.map((r) => [
      r.subcontractorName,
      formatCents(r.baseAmountCents),
      formatCents(r.plugTotalCents),
      formatCents(r.leadTimePenaltyCents),
      formatCents(r.coiPenaltyCents),
      formatCents(r.veDeductCents),
      formatCents(r.leveledTotalCents),
      r.isApparentLow ? "Yes" : "",
      r.isLeveledLow ? "Yes" : "",
      status[r.status],
      r.exclusions
        .filter((e) => e.amountCents > 0)
        .map((e) => `${e.description}: ${formatCents(e.amountCents)}${e.enteredByName ? ` (entered by ${e.enteredByName})` : ""}`)
        .join("; "),
    ]),
  );
}

function downloadCsv(csv: string, csiDivision: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `Leveling_${csiDivision.replace(/\s+/g, "")}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * GC leveling and award for one package (§15): base bids, GC-entered comparison plugs with who
 * entered them, apparent low vs leveled low, and an award confirmed in a dialog that shows the
 * contract sum (base + accepted alternates; plugs never included).
 */
export function LevelingAwardPanel({ tradePackageId, readOnly = false }: { tradePackageId: Id<"tradePackages">; readOnly?: boolean }) {
  const summary = useQuery(api.bids.getLevelingSummary, { tradePackageId });
  const setPlug = useMutation(api.bids.setExclusionPlug);
  const award = useMutation(api.agreements.generateAgreement);
  const toast = useToast();
  const [accepted, setAccepted] = useState<Record<string, number[]>>({});
  const [plugTarget, setPlugTarget] = useState<PlugTarget | null>(null);
  const [plugCents, setPlugCents] = useState<number | null>(null);
  const [plugNote, setPlugNote] = useState("");
  const [plugError, setPlugError] = useState<string | null>(null);
  const [plugSaving, setPlugSaving] = useState(false);
  const [awardTarget, setAwardTarget] = useState<AwardTarget | null>(null);

  if (summary === undefined) return <p className="text-sm text-ink-subtle">Loading leveling…</p>;
  if (summary.rows.length === 0) return null;
  const awarded = summary.packageStatus === "awarded" || summary.awardedTo !== null;
  const apparentLow = summary.rows.find((r) => r.isApparentLow) ?? null;
  const leveledLow = summary.rows.find((r) => r.isLeveledLow) ?? null;

  const toggleAlternate = (bidId: string, index: number) =>
    setAccepted((prev) => {
      const current = prev[bidId] ?? [];
      return { ...prev, [bidId]: current.includes(index) ? current.filter((i) => i !== index) : [...current, index].sort((a, b) => a - b) };
    });

  const openPlug = (row: LevelingRow, index: number) => {
    const e = row.exclusions[index];
    setPlugTarget({ row, index });
    setPlugCents(e.amountCents > 0 ? e.amountCents : null);
    setPlugNote(e.note ?? "");
    setPlugError(null);
  };

  const savePlug = async () => {
    if (!plugTarget) return;
    if (plugCents === null) {
      setPlugError("Enter the plug amount, or $0.00 to remove it.");
      return;
    }
    setPlugSaving(true);
    try {
      await setPlug({ bidId: plugTarget.row.bidId, exclusionIndex: plugTarget.index, amountCents: plugCents, note: plugNote });
      toast.success(plugCents > 0 ? `Plug of ${formatCents(plugCents)} saved for comparison.` : "Plug removed.");
      setPlugTarget(null);
    } catch (err) {
      setPlugError(getErrorMessage(err, "The plug was not saved."));
    } finally {
      setPlugSaving(false);
    }
  };

  const awardRow = awardTarget?.row ?? null;
  const awardAccepted = awardTarget?.accepted ?? [];

  return (
    <section aria-label="Leveling and award" className="space-y-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-ink">Leveling and award</h3>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Plugs are amounts you enter for excluded scope so bids compare on the same scope. They are for comparison only and
            never become part of the contract sum or the schedule of values.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {summary.awardedTo && <StatusPill status="awarded" label={`Awarded to ${summary.awardedTo}`} />}
          <Button size="sm" variant="secondary" onClick={() => downloadCsv(levelingCsv(summary.rows), summary.csiDivision)}>
            Export leveling CSV
          </Button>
        </div>
      </div>

      <dl className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-line px-3 py-2">
          <dt className="text-xs text-ink-subtle">Apparent low (lowest base bid)</dt>
          <dd className="text-sm font-medium text-ink" data-testid="apparent-low">
            {apparentLow ? (
              <>
                {apparentLow.subcontractorName} <Money cents={apparentLow.baseAmountCents} />
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div className="rounded-lg border border-line px-3 py-2">
          <dt className="text-xs text-ink-subtle">Leveled low (comparison only)</dt>
          <dd className="text-sm font-medium text-ink" data-testid="leveled-low">
            {leveledLow ? (
              <>
                {leveledLow.subcontractorName} <Money cents={leveledLow.leveledTotalCents} />
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>

      <ul className="space-y-3">
        {summary.rows.map((row) => {
          const picks = accepted[row.bidId] ?? [];
          const adjustments = row.leadTimePenaltyCents + row.coiPenaltyCents - row.veDeductCents;
          return (
            <li key={row.bidId} className="rounded-xl border border-line p-3" data-testid={`leveling-row-${row.subcontractorName}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">{row.subcontractorName}</span>
                  <span className="text-xs text-ink-subtle">Revision {row.revisionNumber}</span>
                  {row.isApparentLow && <StatusPill status="info" tone="info" label="Apparent low" />}
                  {row.isLeveledLow && <StatusPill status="success" tone="success" label="Leveled low" />}
                  <StatusPill status={row.status} />
                </div>
                {!readOnly && !awarded && (
                  <Button size="sm" onClick={() => setAwardTarget({ row, accepted: picks })}>
                    Award…
                  </Button>
                )}
              </div>

              <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                <div className="flex justify-between gap-2 sm:block">
                  <dt className="text-ink-subtle">Base bid</dt>
                  <dd className="font-medium">
                    <Money cents={row.baseAmountCents} />
                  </dd>
                </div>
                <div className="flex justify-between gap-2 sm:block">
                  <dt className="text-ink-subtle">Plugs (comparison only)</dt>
                  <dd className="font-medium">
                    <Money cents={row.plugTotalCents} />
                  </dd>
                </div>
                <div className="flex justify-between gap-2 sm:block">
                  <dt className="text-ink-subtle">Leveled (comparison only)</dt>
                  <dd className="font-semibold">
                    <Money cents={row.leveledTotalCents} />
                  </dd>
                </div>
              </dl>
              <p className="mt-1 text-xs text-ink-subtle">
                <Money cents={row.baseAmountCents} /> base + <Money cents={row.plugTotalCents} /> plugs
                {adjustments !== 0 && (
                  <>
                    {" "}
                    {adjustments > 0 ? "+" : "−"} <Money cents={Math.abs(adjustments)} /> penalties and VE
                  </>
                )}{" "}
                = <Money cents={row.leveledTotalCents} />
              </p>

              {row.exclusions.length > 0 && (
                <div className="mt-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Exclusions</h4>
                  <ul className="mt-1 divide-y divide-line">
                    {row.exclusions.map((e) => (
                      <li key={e.index} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                        <span className="min-w-0 flex-1 text-ink">{e.description}</span>
                        <span className="text-ink-muted">
                          {e.amountCents > 0 ? (
                            <>
                              Plug <Money cents={e.amountCents} />
                              {e.enteredByName && <> · entered by {e.enteredByName}</>}
                              {e.enteredAt && (
                                <>
                                  {" "}
                                  on <DateText value={e.enteredAt} />
                                </>
                              )}
                              {e.note && <> · {e.note}</>}
                            </>
                          ) : (
                            "No plug"
                          )}
                        </span>
                        {!readOnly && !awarded && (
                          <Button size="sm" variant="ghost" onClick={() => openPlug(row, e.index)}>
                            {e.amountCents > 0 ? "Edit plug" : "Add plug"}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {row.alternates.length > 0 && (
                <fieldset className="mt-3">
                  <legend className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Bid alternates</legend>
                  <ul className="mt-1 space-y-1">
                    {row.alternates.map((a, i) => {
                      const id = `alt-${row.bidId}-${i}`;
                      return (
                        <li key={id} className="flex items-center gap-2 text-sm">
                          <input
                            id={id}
                            type="checkbox"
                            className="h-5 w-5 accent-green-600"
                            checked={picks.includes(i)}
                            disabled={readOnly || awarded}
                            onChange={() => toggleAlternate(row.bidId, i)}
                          />
                          <label htmlFor={id} className="flex-1 text-ink">
                            Accept {a.description}
                          </label>
                          <Money cents={a.amountCents} showPlus />
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              )}
            </li>
          );
        })}
      </ul>

      <Dialog
        open={plugTarget !== null}
        title="Leveling plug (comparison only)"
        description={plugTarget ? `${plugTarget.row.subcontractorName}: ${plugTarget.row.exclusions[plugTarget.index].description}` : undefined}
        onClose={() => setPlugTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPlugTarget(null)} disabled={plugSaving}>
              Cancel
            </Button>
            <Button onClick={() => void savePlug()} loading={plugSaving}>
              Save plug
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <MoneyInput
            label="Plug amount"
            required
            value={plugCents}
            onChange={(v) => {
              setPlugCents(v);
              setPlugError(null);
            }}
            error={plugError ?? undefined}
            hint="Enter $0.00 to remove the plug. The plug changes only the leveled total."
          />
          <TextInput label="Note" value={plugNote} onChange={setPlugNote} maxLength={200} hint="For example, where the number came from." />
        </div>
      </Dialog>

      <ConfirmDialog
        open={awardRow !== null}
        title={awardRow ? `Award to ${awardRow.subcontractorName}?` : "Award"}
        payee={awardRow?.subcontractorName}
        payeeLabel="Bidder"
        amountCents={awardRow ? awardPreviewCents(awardRow, awardAccepted) : undefined}
        amountLabel="Contract sum"
        details={
          awardRow
            ? [
                { label: "Base bid", value: formatCents(awardRow.baseAmountCents) },
                {
                  label: "Accepted alternates",
                  value:
                    awardAccepted.length === 0
                      ? "None"
                      : awardAccepted.map((i) => `${awardRow.alternates[i].description} (${formatCents(awardRow.alternates[i].amountCents)})`).join("; "),
                },
                ...(awardRow.veDeductCents > 0 ? [{ label: "Accepted VE deducts", value: `−${formatCents(awardRow.veDeductCents)}` }] : []),
                { label: "Leveling plugs", value: "Not included" },
              ]
            : undefined
        }
        effect={
          <>
            {PLUGS_NOT_INCLUDED} The contract sum is the base bid plus the accepted alternates. Awarding generates the
            subcontract draft and marks the other bidders as not awarded.
          </>
        }
        confirmLabel="Award and generate subcontract"
        onConfirm={async () => {
          if (!awardRow) return;
          await award({ bidId: awardRow.bidId, tradePackageId, acceptedAlternateIndexes: awardAccepted });
          toast.success(`Awarded to ${awardRow.subcontractorName}. Contract sum ${formatCents(awardPreviewCents(awardRow, awardAccepted))}.`);
          setAwardTarget(null);
        }}
        onCancel={() => setAwardTarget(null)}
      />
    </section>
  );
}
