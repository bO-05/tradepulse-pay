import { useMutation, useQuery } from "convex/react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../convex/_generated/api";
import { fromDollars, percentageOfCents, toDollarString } from "../../convex/lib/money";
import { validatePayApp, type PayAppLineInput } from "../../convex/payApps/validation";
import { readableError } from "./FundMilestone";
import { formatCents } from "./format";

type AgreementOption = { _id: string; agreementNumber: string; projectTitle: string; status: string };

type LineDraft = { thisPeriod: string; toDate: string; requested: string; requestedEdited: boolean; toDateEdited: boolean };

const EMPTY_LINE: LineDraft = { thisPeriod: "", toDate: "", requested: "", requestedEdited: false, toDateEdited: false };

function parsePercent(text: string): number {
  const t = text.trim();
  if (t === "") return 0;
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : Number.NaN;
}

/** Sub portal form: per-SOV-line percentages and requested amounts, validated with the backend's rules. */
export function PayAppForm({ agreements }: { agreements: AgreementOption[] }) {
  const executed = agreements.filter((a) => a.status !== "superseded");
  const [agreementId, setAgreementId] = useState(executed[0]?._id ?? "");
  const context = useQuery(api.payApps.submit.payAppFormContext, agreementId ? { agreementId } : "skip");
  const submit = useMutation(api.payApps.submit.submitPayApplication);
  const [periodLabel, setPeriodLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [lienWaiver, setLienWaiver] = useState(false);
  const [lines, setLines] = useState<Record<string, LineDraft>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!agreementId && executed[0]) setAgreementId(executed[0]._id);
  }, [agreementId, executed]);

  if (executed.length === 0) {
    return <p className="text-sm text-slate-400">Pay applications open once the GC executes one of your agreements.</p>;
  }

  const blockedReason = context?.blockedReason ?? null;

  const sovLines = context?.sovLines ?? [];
  const draftFor = (id: string) => lines[id] ?? EMPTY_LINE;

  function update(id: string, field: "thisPeriod" | "toDate" | "requested", value: string, scheduledCents: number, prevPct: number) {
    setSuccess(null);
    setLines((prev) => {
      const cur = { ...(prev[id] ?? EMPTY_LINE), [field]: value };
      // Clearing a field hands it back to the auto-fill from % this period.
      if (field === "requested") cur.requestedEdited = value.trim() !== "";
      if (field === "toDate") cur.toDateEdited = value.trim() !== "";
      if (field === "thisPeriod") {
        const pct = parsePercent(value);
        if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
          if (!cur.requestedEdited) cur.requested = pct === 0 ? "" : toDollarString(percentageOfCents(scheduledCents, pct));
          if (!cur.toDateEdited) cur.toDate = pct === 0 ? "" : String(Math.min(100, Math.round((prevPct + pct) * 1e6) / 1e6));
        }
      }
      return { ...prev, [id]: cur };
    });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSuccess(null);
    const parseErrors: string[] = [];
    const input: PayAppLineInput[] = [];
    for (const s of sovLines) {
      const d = draftFor(s._id);
      if (d.thisPeriod.trim() === "" && d.toDate.trim() === "" && d.requested.trim() === "") continue;
      let requestedCents = 0;
      if (d.requested.trim() !== "") {
        try {
          requestedCents = fromDollars(d.requested);
        } catch {
          parseErrors.push(`Line ${s.lineNo} (${s.description}): requested amount must be a number.`);
          continue;
        }
      }
      const pctThis = parsePercent(d.thisPeriod);
      const pctToDate = parsePercent(d.toDate);
      if (Number.isNaN(pctThis) || Number.isNaN(pctToDate)) {
        parseErrors.push(`Line ${s.lineNo} (${s.description}): percentages must be numbers.`);
        continue;
      }
      input.push({ sovLineId: s._id, pctCompleteThisPeriod: pctThis, pctCompleteToDate: pctToDate, requestedCents });
    }
    const check = validatePayApp({ periodLabel, notes, lines: input }, sovLines);
    const all = [...parseErrors, ...check.errors.map((x) => x.message)];
    if (parseErrors.length > 0) {
      // A line that failed to parse was left out, so "no lines" would be misleading on its own.
      setErrors(all.filter((m) => !/at least one line/.test(m)));
      return;
    }
    if (all.length > 0) {
      setErrors(all);
      return;
    }
    setErrors([]);
    setBusy(true);
    try {
      await submit({ agreementId, periodLabel, lines: input, notes, lienWaiver });
      setSuccess(`Pay application "${periodLabel.trim()}" submitted for ${formatCents(check.requestedTotalCents)}.`);
      setPeriodLabel("");
      setNotes("");
      setLienWaiver(false);
      setLines({});
    } catch (err) {
      setErrors([readableError(err)]);
    } finally {
      setBusy(false);
    }
  }

  const inputCls = "w-24 rounded-lg bg-slate-950 border border-slate-700 px-2 py-1 text-right";

  return (
    <form onSubmit={onSubmit} className="space-y-4" aria-label="Submit pay application" noValidate>
      <div className="grid sm:grid-cols-2 gap-4 text-sm">
        <label className="block">
          <span className="text-xs text-slate-400">Agreement</span>
          <select
            id="payapp-agreement"
            value={agreementId}
            onChange={(e) => {
              setAgreementId(e.target.value);
              setLines({});
              setErrors([]);
            }}
            className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-2 py-1.5"
          >
            {executed.map((a) => (
              <option key={a._id} value={a._id}>
                {a.agreementNumber} · {a.projectTitle}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-slate-400">Period label</span>
          <input
            id="payapp-period"
            value={periodLabel}
            onChange={(e) => setPeriodLabel(e.target.value)}
            placeholder="e.g. Pay app #1 · October 2026"
            className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-2 py-1.5"
          />
        </label>
      </div>

      {context === undefined ? (
        <p className="text-sm text-slate-400" role="status">Loading schedule of values…</p>
      ) : blockedReason !== null ? (
        <div className="flex flex-wrap items-center gap-3" data-testid="payapp-blocked">
          <button
            type="button"
            disabled
            aria-describedby="payapp-blocked-reason"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            New pay app
          </button>
          <p id="payapp-blocked-reason" role="status" className="text-sm text-amber-200">
            {blockedReason}
          </p>
        </div>
      ) : context === null || sovLines.length === 0 ? (
        <p className="text-sm text-slate-400">This agreement has no schedule of values yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="payapp-lines">
            <thead className="text-xs text-slate-400 text-left">
              <tr>
                <th className="py-2 pr-3 font-medium">SOV line</th>
                <th className="py-2 pr-3 font-medium text-right">Scheduled</th>
                <th className="py-2 pr-3 font-medium text-right">Previously billed</th>
                <th className="py-2 pr-3 font-medium text-right">Remaining</th>
                <th className="py-2 pr-3 font-medium text-right">% this period</th>
                <th className="py-2 pr-3 font-medium text-right">% to date</th>
                <th className="py-2 pr-3 font-medium text-right">Requested ($)</th>
              </tr>
            </thead>
            <tbody>
              {sovLines.map((s) => {
                const d = draftFor(s._id);
                return (
                  <tr key={s._id} className="border-t border-slate-800">
                    <td className="py-2 pr-3">
                      {s.lineNo}. {s.description}
                      {s.excludedScope ? <span className="ml-2 text-xs text-amber-300">excluded scope</span> : null}
                    </td>
                    <td className="py-2 pr-3 text-right">{formatCents(s.scheduledValueCents)}</td>
                    <td className="py-2 pr-3 text-right">
                      {formatCents(s.previouslyBilledCents)}
                      {s.previousPctToDate > 0 ? (
                        <span className="block text-xs text-slate-400">{s.previousPctToDate}% approved to date</span>
                      ) : null}
                      {s.pendingRequestedCents > 0 ? (
                        <span className="block text-xs text-amber-300/80">{formatCents(s.pendingRequestedCents)} pending review</span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 text-right">{formatCents(s.remainingCents)}</td>
                    <td className="py-2 pr-3 text-right">
                      <input
                        aria-label={`Line ${s.lineNo} % complete this period`}
                        inputMode="decimal"
                        value={d.thisPeriod}
                        onChange={(e) => update(s._id, "thisPeriod", e.target.value, s.scheduledValueCents, s.previousPctToDate)}
                        className={inputCls}
                      />
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <input
                        aria-label={`Line ${s.lineNo} % complete to date`}
                        inputMode="decimal"
                        value={d.toDate}
                        onChange={(e) => update(s._id, "toDate", e.target.value, s.scheduledValueCents, s.previousPctToDate)}
                        className={inputCls}
                      />
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <input
                        aria-label={`Line ${s.lineNo} amount requested`}
                        inputMode="decimal"
                        value={d.requested}
                        onChange={(e) => update(s._id, "requested", e.target.value, s.scheduledValueCents, s.previousPctToDate)}
                        className={`${inputCls} w-32`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <label className="block text-sm">
        <span className="text-xs text-slate-400">Notes</span>
        <textarea
          id="payapp-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-2 py-1.5"
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input id="payapp-lien-waiver" type="checkbox" checked={lienWaiver} onChange={(e) => setLienWaiver(e.target.checked)} />
        Conditional lien waiver attached for this period
      </label>

      {errors.length > 0 ? (
        <div role="alert" className="rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-200" data-testid="payapp-errors">
          <p className="font-semibold">The pay application was not submitted:</p>
          <ul className="list-disc pl-5">
            {errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {success ? (
        <p role="status" className="text-sm text-emerald-300" data-testid="payapp-success">
          {success}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy || !context || blockedReason !== null || sovLines.length === 0}
        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-50"
      >
        {busy ? "Submitting…" : "Submit pay application"}
      </button>
    </form>
  );
}
