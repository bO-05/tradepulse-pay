import { milestoneFundingLabel, type MilestoneFundingState } from "../../convex/payments/milestoneFundingState";
import { formatCents } from "./format";

export type MilestoneFundingRow = {
  _id: string;
  name: string;
  amountCents: number;
  state: MilestoneFundingState;
  capturedCents: number;
};

const TONE: Record<MilestoneFundingState, string> = {
  not_funded: "bg-slate-800 text-slate-300 border-slate-700",
  funded: "bg-sky-950 text-sky-300 border-sky-800",
  captured: "bg-amber-950 text-amber-300 border-amber-800",
  paid: "bg-emerald-950 text-emerald-300 border-emerald-800",
};

/** Read-only milestone funding table; it has no funding or release controls. */
export function MilestoneFundingTable({ milestones, label }: { milestones: MilestoneFundingRow[]; label: string }) {
  if (milestones.length === 0) return <p className="text-sm text-slate-400">No milestones yet.</p>;
  return (
    <table className="w-full text-sm" aria-label={label} data-testid="sub-milestone-funding-table">
      <thead className="text-xs text-slate-400 text-left">
        <tr>
          <th className="py-2 pr-3 font-medium">Milestone</th>
          <th className="py-2 pr-3 font-medium text-right">Amount</th>
          <th className="py-2 pr-3 font-medium">Funding</th>
        </tr>
      </thead>
      <tbody>
        {milestones.map((m) => (
          <tr key={m._id} className="border-t border-slate-800" data-testid="sub-milestone-row">
            <td className="py-2 pr-3">{m.name}</td>
            <td className="py-2 pr-3 text-right tabular-nums">{formatCents(m.amountCents)}</td>
            <td className="py-2 pr-3">
              <span
                className={`text-xs rounded-full px-2 py-0.5 border ${TONE[m.state]}`}
                data-testid="sub-milestone-funding"
                data-state={m.state}
              >
                {milestoneFundingLabel(m.state)}
              </span>
              {m.state === "captured" && m.capturedCents > 0 ? (
                <span className="ml-2 text-xs text-slate-400 tabular-nums">{formatCents(m.capturedCents)} captured</span>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
