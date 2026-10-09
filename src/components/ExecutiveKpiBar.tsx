import React from "react";
import {
  DollarSign,
  TrendingDown,
  ShieldAlert,
  AlertTriangle,
  Award,
} from "lucide-react";
import { ProcurementMetrics } from "../leveling.ts";

interface ExecutiveKpiBarProps {
  metrics: ProcurementMetrics;
  projectTitle?: string;
}

/**
 * Every headline figure here comes from `computeProcurementMetrics` so the KPI band,
 * the header stepper, the demo tour and the contracts register always agree.
 */
export const ExecutiveKpiBar: React.FC<ExecutiveKpiBarProps> = ({ metrics, projectTitle }) => {
  const {
    totalBudget,
    totalLeveledBuyout,
    variance,
    variancePercent,
    isSavings,
    deceptiveBidsCount,
    gapsCaught,
    awardedPackages,
    totalPackages,
    buyoutProgressPercent,
    leveledBuyoutCaption,
    leveledBuyoutShort,
    varianceIsLeveled,
  } = metrics;

  const [isCompact, setIsCompact] = React.useState(true);
  const varianceTone = varianceIsLeveled ? (isSavings ? "text-emerald-400" : "text-rose-400") : "text-slate-300";

  if (isCompact) {
    return (
      <div className="bg-slate-900/95 border border-slate-800 rounded-xl px-4 lg:px-5 py-1.5 shadow-sm transition-all">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-2.5 sm:gap-3.5">
            <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 font-bold hidden sm:inline">
              Baseline:
            </span>
            <span className="text-slate-300 font-medium">
              Budget: <strong className="font-mono text-white font-bold">${totalBudget.toLocaleString()}</strong>
            </span>
            <span className="text-slate-700 hidden sm:inline">•</span>
            <span className="text-slate-300 font-medium" title={leveledBuyoutCaption}>
              Leveled Buyout: <strong className={`font-mono font-bold ${isSavings ? "text-emerald-400" : "text-rose-400"}`}>${totalLeveledBuyout.toLocaleString()}</strong>
              <span className="text-[10px] font-mono text-slate-400 ml-1">({leveledBuyoutShort})</span>
            </span>
            <span className="text-slate-700 hidden sm:inline">•</span>
            <span className="text-slate-300 font-medium">
              {varianceIsLeveled ? (
                <>
                  Variance: <strong className={`font-mono font-bold ${varianceTone}`}>{isSavings ? `+$${variance.toLocaleString()}` : `-$${Math.abs(variance).toLocaleString()}`}</strong>
                  <span className={`text-[10px] font-mono ml-1 font-bold ${varianceTone}`}>
                    ({variancePercent.toFixed(1)}%)
                  </span>
                </>
              ) : (
                <>
                  Budget vs scope estimate:{" "}
                  <strong className="font-mono font-bold text-slate-300">
                    {variance >= 0 ? `+$${variance.toLocaleString()}` : `-$${Math.abs(variance).toLocaleString()}`}
                  </strong>
                  <span className="text-[10px] font-mono ml-1 text-slate-400">(not bid-based)</span>
                </>
              )}
            </span>
            {deceptiveBidsCount > 0 && (
              <>
                <span className="text-slate-700 hidden md:inline">•</span>
                <span className="bg-amber-950/80 text-amber-300 border border-amber-800/80 px-2 py-0.5 rounded-full font-semibold text-[10px] flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3 text-amber-400" />
                  <span>{deceptiveBidsCount} apparent-low bid{deceptiveBidsCount === 1 ? "" : "s"} not leveled low</span>
                </span>
              </>
            )}
            {gapsCaught > 0 && (
              <>
                <span className="text-slate-700 hidden lg:inline">•</span>
                <span
                  className="bg-sky-950/80 text-sky-300 border border-sky-800/80 px-2 py-0.5 rounded-full font-semibold text-[10px] flex items-center gap-1"
                  title="Exclusions + lead-time + COI penalties − accepted VE credits on bids whose base is low but whose leveled total is not"
                >
                  <ShieldAlert className="w-3 h-3 text-sky-400" />
                  <span>Gaps Exposed: +${gapsCaught.toLocaleString()}</span>
                </span>
              </>
            )}
            <span className="text-slate-700 hidden xl:inline">•</span>
            <span className="text-slate-400 font-medium hidden xl:inline text-[11px]">
              Subcontracts: <strong className="font-mono text-white">{awardedPackages}/{totalPackages} Awarded</strong>
            </span>
          </div>

          <button
            onClick={() => setIsCompact(false)}
            className="text-[11px] font-semibold text-slate-400 hover:text-emerald-400 flex items-center gap-1 transition px-2 py-0.5 rounded hover:bg-slate-800"
            title="Expand into full 6-card financial dashboard"
          >
            <span>Expand 6-Card KPI View</span>
            <span className="text-[10px]">▼</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-slate-900/90 border border-slate-800/90 rounded-xl px-4 lg:px-6 py-2.5 shadow-md transition-all">
      <div className="max-w-7xl mx-auto mb-1.5 flex items-center justify-between text-xs text-slate-400">
        <span className="font-mono text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
          Commercial Procurement Financial Baseline • ADR-0003 Normalized
        </span>
        <button
          onClick={() => setIsCompact(true)}
          className="text-[11px] text-slate-400 hover:text-slate-200 flex items-center gap-1 transition"
        >
          <span>Compact Mode</span>
          <span className="text-[10px]">▲</span>
        </button>
      </div>
      <div className="max-w-7xl mx-auto grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
        {/* KPI 1: Total Project Budget */}
        <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-2.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-[10px] uppercase tracking-wider font-semibold">Total Budget</span>
            <DollarSign className="w-3.5 h-3.5 text-slate-400" />
          </div>
          <div>
            <div className="text-base sm:text-lg font-black font-mono text-white">
              ${totalBudget.toLocaleString()}
            </div>
            <div className="text-[10px] text-slate-400 font-medium truncate">
              {projectTitle || "Active project"}
            </div>
          </div>
        </div>

        {/* KPI 2: Leveled Buyout Forecast */}
        <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-2.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-[10px] uppercase tracking-wider font-semibold">Leveled Buyout</span>
            <span
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${isSavings ? "bg-emerald-950 text-emerald-400 border-emerald-800/60" : "bg-rose-950 text-rose-400 border-rose-800/60"}`}
              title="ADR-0003: leveled cost = base bid + scope-gap exclusions + lead-time penalty + COI penalty − accepted value-engineering credits."
            >
              ADR-0003
            </span>
          </div>
          <div>
            <div className={`text-base sm:text-lg font-black font-mono ${isSavings ? "text-emerald-400" : "text-rose-400"}`}>
              ${totalLeveledBuyout.toLocaleString()}
            </div>
            <div className="text-[10px] text-slate-400 font-medium" title={leveledBuyoutCaption}>
              {leveledBuyoutCaption}
            </div>
          </div>
        </div>

        {/* KPI 3: Buyout Savings / Variance */}
        <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-[10px] uppercase tracking-wider font-semibold">
              {varianceIsLeveled ? "Variance vs Budget" : "Budget vs Scope Estimate"}
            </span>
            <TrendingDown className={`w-3.5 h-3.5 ${varianceTone}`} />
          </div>
          <div>
            <div className={`text-base sm:text-lg font-black font-mono ${varianceTone}`}>
              {isSavings ? `+$${variance.toLocaleString()}` : `-$${Math.abs(variance).toLocaleString()}`}
            </div>
            <div className={`text-[10px] font-semibold ${varianceTone}`}>
              {varianceIsLeveled
                ? isSavings
                  ? `Savings: ${variancePercent.toFixed(1)}%`
                  : `Over Budget: ${Math.abs(variancePercent).toFixed(1)}%`
                : "Not a bid-based saving — no proposals leveled yet"}
            </div>
          </div>
        </div>

        {/* KPI 4: apparent-low bids that are not the leveled low */}
        <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-[10px] uppercase tracking-wider font-semibold">Apparent low ≠ leveled low</span>
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div>
            <div className="text-base sm:text-lg font-black font-mono text-amber-300 flex items-center gap-1.5">
              {deceptiveBidsCount} <span className="text-xs font-normal text-slate-400">proposals</span>
            </div>
            <div className="text-[10px] text-amber-400/80 font-medium">
              Hidden cost creep exposed
            </div>
          </div>
        </div>

        {/* KPI 5: Hidden Scope Gaps Exposed */}
        <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-[10px] uppercase tracking-wider font-semibold">Hidden Gaps Exposed</span>
            <ShieldAlert className="w-3.5 h-3.5 text-sky-400" />
          </div>
          <div>
            <div className="text-base sm:text-lg font-black font-mono text-sky-300">
              +${gapsCaught.toLocaleString()}
            </div>
            <div className="text-[10px] text-slate-400 font-medium">
              Exclusions + lead + COI on flagged bids
            </div>
          </div>
        </div>

        {/* KPI 6: Subcontract Award Progress */}
        <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-[10px] uppercase tracking-wider font-semibold">Subcontract Awards</span>
            <Award className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div>
            <div className="text-base sm:text-lg font-black font-mono text-white flex items-center gap-1.5">
              {awardedPackages} <span className="text-slate-400 font-normal text-xs">of</span> {totalPackages}
            </div>
            <div className="w-full bg-slate-800 h-1.5 rounded-full mt-1.5 overflow-hidden">
              <div
                className="bg-emerald-500 h-full rounded-full transition-all duration-500"
                style={{ width: `${buyoutProgressPercent}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};