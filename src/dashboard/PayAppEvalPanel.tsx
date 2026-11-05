import React from "react";
import { formatFullDateTime } from "../lib/datetime.ts";
import { reviewAttribution } from "../lib/aiProvenance.ts";

export type PayAppEvalRun = {
  runId: string;
  provider?: string;
  model?: string;
  overallScore: number;
  passedCases: number;
  totalCases: number;
  createdAt?: number;
  reviewMetrics?: {
    totalCases: number;
    totalLines: number;
    totalIssues: number;
    lineAccuracy: number;
    issuePrecision: number;
    issueRecall: number;
    issueF1: number;
    macroF1: number;
    casePassRate: number;
    perVerdict: { verdict: string; support: number; tp: number; fp: number; fn: number; precision: number; recall: number; f1: number }[];
  };
  fixtureScores?: { fixtureId: string; score: number; passed: boolean; provider: string; model: string; checks: string[] }[];
};

const FIXTURE_NAMES: Record<string, string> = {
  payapp_honest: "Honest pay app",
  payapp_overbilled: "Overbilled line",
  payapp_excluded_scope: "Excluded scope billed",
  payapp_front_loaded: "Front-loaded closeout",
  payapp_out_of_sequence: "Closeout out of sequence",
  payapp_closeout_over_ceiling: "Closeout sequence over ceiling",
  payapp_excluded_over_ceiling: "Excluded over ceiling",
  payapp_overbilled_over_front: "Overbilled over front-loaded",
  payapp_at_ceiling: "Exactly at ceiling",
  payapp_stored_materials: "Stored materials",
  payapp_early_phase: "Early-phase exemption",
  payapp_no_tranche_stored: "No tranche, stored gear",
  payapp_no_tranche_complete: "No tranche, complete",
  payapp_multiple_exclusions: "Two excluded scopes",
  payapp_missing_lien_waiver: "Missing lien waiver",
  payapp_expired_license: "Expired license",
  payapp_prompt_injection: "Prompt injection ignored",
  payapp_zero_progress: "Zero progress",
  payapp_prior_baseline: "Prior approved baseline",
  payapp_overbilled_third_line: "Third line overbilled",
  payapp_unbilled_closeout: "Closeout unbilled",
  payapp_excluded_sov_line: "Excluded SOV line",
  payapp_mixed_findings: "Mixed findings",
  payapp_front_loaded_no_tranche: "Front-loaded, no tranche",
};

const pct = (value: number) => `${Math.round(value * 1000) / 10}%`;

function modelLabel(provider: string | undefined, model: string | undefined): string {
  if (!provider) return "Unknown provider";
  return reviewAttribution({ provider, model: model ?? "none" });
}

/** Pay-app review cases scored by the same evals:executeEvalSuite run as bid leveling. */
export const PayAppEvalPanel: React.FC<{ run: PayAppEvalRun | null | undefined }> = ({ run }) => {
  if (!run) return null;
  return (
    <div className="space-y-2" data-testid="payapp-eval-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300">Pay-app review cases</h4>
        <span className="text-[11px] text-slate-400">
          Run ID: <code className="font-mono text-slate-300">{run.runId}</code>
          {run.createdAt ? ` • ${formatFullDateTime(run.createdAt)}` : ""}
        </span>
      </div>
      <div className="text-xs text-slate-300">
        Overall score <span className="font-mono font-bold text-emerald-400">{run.overallScore}%</span> • {run.passedCases} / {run.totalCases} cases
        passed • {modelLabel(run.provider, run.model)}
      </div>
      {run.reviewMetrics ? (
        <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
          <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-5">
            <div>
              <div className="text-slate-500">Line accuracy</div>
              <div className="font-mono text-slate-200">{pct(run.reviewMetrics.lineAccuracy)}</div>
            </div>
            <div>
              <div className="text-slate-500">Issue precision</div>
              <div className="font-mono text-slate-200">{pct(run.reviewMetrics.issuePrecision)}</div>
            </div>
            <div>
              <div className="text-slate-500">Issue recall</div>
              <div className="font-mono text-slate-200">{pct(run.reviewMetrics.issueRecall)}</div>
            </div>
            <div>
              <div className="text-slate-500">Issue F1</div>
              <div className="font-mono text-slate-200">{pct(run.reviewMetrics.issueF1)}</div>
            </div>
            <div>
              <div className="text-slate-500">Macro F1</div>
              <div className="font-mono text-slate-200">{pct(run.reviewMetrics.macroF1)}</div>
            </div>
          </div>
          <div className="text-[11px] text-slate-400">
            {run.reviewMetrics.totalCases} cases • {run.reviewMetrics.totalLines} lines • {run.reviewMetrics.totalIssues} issue lines •{" "}
            {pct(run.reviewMetrics.casePassRate)} of cases exact
          </div>
          <details className="text-[11px] text-slate-400">
            <summary className="cursor-pointer text-slate-300">Per-verdict precision and recall</summary>
            <table className="mt-2 w-full text-left">
              <thead className="text-[10px] uppercase text-slate-500">
                <tr>
                  <th className="py-1">Verdict</th>
                  <th className="py-1">Support</th>
                  <th className="py-1">TP</th>
                  <th className="py-1">FP</th>
                  <th className="py-1">FN</th>
                  <th className="py-1">Precision</th>
                  <th className="py-1">Recall</th>
                  <th className="py-1">F1</th>
                </tr>
              </thead>
              <tbody>
                {run.reviewMetrics.perVerdict.map((m) => (
                  <tr key={m.verdict} className="border-t border-slate-800">
                    <td className="py-1 text-slate-200">{m.verdict.split("_").join(" ")}</td>
                    <td className="py-1 font-mono">{m.support}</td>
                    <td className="py-1 font-mono">{m.tp}</td>
                    <td className="py-1 font-mono">{m.fp}</td>
                    <td className="py-1 font-mono">{m.fn}</td>
                    <td className="py-1 font-mono">{pct(m.precision)}</td>
                    <td className="py-1 font-mono">{pct(m.recall)}</td>
                    <td className="py-1 font-mono">{pct(m.f1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      ) : null}
      <div className="max-h-96 overflow-auto rounded-lg border border-slate-800">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-900 text-[10px] uppercase text-slate-400">
            <tr>
              <th className="px-3 py-2">Case</th>
              <th className="px-3 py-2">Score</th>
              <th className="px-3 py-2">Result</th>
              <th className="px-3 py-2">Reviewed by</th>
            </tr>
          </thead>
          <tbody>
            {(run.fixtureScores ?? []).map((f) => (
              <tr key={f.fixtureId} className="border-t border-slate-800 bg-slate-950">
                <td className="px-3 py-2 text-slate-200" title={f.checks.join("\n")}>
                  {FIXTURE_NAMES[f.fixtureId] ?? "Pay-app review case"}
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
