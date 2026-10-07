import React from "react";
import { formatFullDateTime } from "../lib/datetime.ts";

export type PayAppEvalRun = {
  runId: string;
  provider?: string;
  model?: string;
  overallScore: number;
  passedCases: number;
  totalCases: number;
  createdAt?: number;
  fixtureScores?: { fixtureId: string; score: number; passed: boolean; provider: string; model: string; checks: string[] }[];
};

const FIXTURE_NAMES: Record<string, string> = {
  payapp_honest: "Honest pay app",
  payapp_overbilled: "Overbilled line",
  payapp_excluded_scope: "Excluded scope billed",
  payapp_front_loaded: "Front-loaded closeout",
};

function modelLabel(provider: string | undefined, model: string | undefined): string {
  if (!provider) return "Unknown provider";
  if (!model || model === "none") return provider;
  return `${provider} · ${model}`;
}

/** Pay-app review fixtures scored by the same evals:executeEvalSuite run as bid leveling. */
export const PayAppEvalPanel: React.FC<{ run: PayAppEvalRun | null | undefined }> = ({ run }) => {
  if (!run) return null;
  return (
    <div className="space-y-2" data-testid="payapp-eval-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300">Pay-App Review Fixtures</h4>
        <span className="text-[11px] text-slate-400">
          Run ID: <code className="font-mono text-slate-300">{run.runId}</code>
          {run.createdAt ? ` • ${formatFullDateTime(run.createdAt)}` : ""}
        </span>
      </div>
      <div className="text-xs text-slate-300">
        Overall score <span className="font-mono font-bold text-emerald-400">{run.overallScore}%</span> • {run.passedCases} / {run.totalCases} fixtures
        passed • {modelLabel(run.provider, run.model)}
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-900 text-[10px] uppercase text-slate-400">
            <tr>
              <th className="px-3 py-2">Fixture</th>
              <th className="px-3 py-2">Score</th>
              <th className="px-3 py-2">Result</th>
              <th className="px-3 py-2">Reviewed by</th>
            </tr>
          </thead>
          <tbody>
            {(run.fixtureScores ?? []).map((f) => (
              <tr key={f.fixtureId} className="border-t border-slate-800 bg-slate-950">
                <td className="px-3 py-2 text-slate-200" title={f.checks.join("\n")}>
                  {FIXTURE_NAMES[f.fixtureId] ?? f.fixtureId}
                </td>
                <td className="px-3 py-2 font-mono text-slate-200">{Math.round(f.score * 100)}%</td>
                <td className={`px-3 py-2 font-bold ${f.passed ? "text-emerald-400" : "text-rose-400"}`}>{f.passed ? "PASS" : "FAIL"}</td>
                <td className="px-3 py-2 text-slate-400">{modelLabel(f.provider, f.model)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
