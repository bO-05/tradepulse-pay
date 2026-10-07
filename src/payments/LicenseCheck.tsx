import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { readableError } from "./FundMilestone";

export type LicenseBadgeStatus = "active" | "expired" | "suspended" | "inactive" | "not_found" | "unverified" | "none";

const RUNNING_STALE_MS = 3 * 60 * 1000;

const BADGE: Record<LicenseBadgeStatus, { label: string; style: string }> = {
  active: { label: "CSLB: Active", style: "border-emerald-800 bg-emerald-950 text-emerald-200" },
  expired: { label: "CSLB: Expired", style: "border-rose-800 bg-rose-950 text-rose-200" },
  suspended: { label: "CSLB: Suspended", style: "border-rose-800 bg-rose-950 text-rose-200" },
  inactive: { label: "CSLB: Inactive", style: "border-rose-800 bg-rose-950 text-rose-200" },
  not_found: { label: "CSLB: Not found", style: "border-rose-800 bg-rose-950 text-rose-200" },
  unverified: { label: "License unverified", style: "border-amber-800 bg-amber-950 text-amber-200" },
  none: { label: "No license check yet", style: "border-slate-700 bg-slate-800 text-slate-200" },
};

/** License status badge. Only an "active" result from CSLB is shown as positive. */
export function LicenseBadge({ status, running = false }: { status: LicenseBadgeStatus; running?: boolean }) {
  if (running) {
    return (
      <span className="rounded-full border border-sky-800 bg-sky-950 px-2 py-0.5 text-xs text-sky-200" data-testid="license-badge" data-status="running">
        Checking CSLB…
      </span>
    );
  }
  const b = BADGE[status] ?? BADGE.unverified;
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs ${b.style}`} data-testid="license-badge" data-status={status}>
      {b.label}
    </span>
  );
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * GC panel for a contractor's California license: latest CSLB result, a
 * "Check license" control, and the KERNEL live view while a lookup runs.
 */
export function LicenseCheckPanel({ contractorId }: { contractorId: string }) {
  const data = useQuery(api.kernel.licenseChecks.getContractorLicense, { contractorId });
  const request = useMutation(api.kernel.licenseChecks.requestLicenseCheck);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (data === undefined) return <p className="text-sm text-slate-400" role="status">Loading license…</p>;
  if (data === null) return null;

  const latest = data.latest;
  const stale = latest !== null && latest.phase === "running" && Date.now() - latest.startedAt > RUNNING_STALE_MS;
  const running = latest !== null && latest.phase === "running" && !stale;
  const completed = data.history.find((h) => h.phase !== "running") ?? null;
  const shown: LicenseBadgeStatus = stale ? "unverified" : completed ? completed.status : "none";

  async function check() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await request({ contractorId });
      if (res.kind === "cached") setNote("A CSLB result from the last 24 hours was reused; no new lookup ran.");
      if (res.kind === "in_flight") setNote("A lookup for this license is already running.");
      if (res.kind === "no_license") setNote("No license number is on file for this contractor.");
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border border-slate-800 rounded-xl p-4 space-y-3" data-testid="license-check-panel" aria-label="Contractor license check">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">California contractor license (CSLB)</h3>
          <p className="text-xs text-slate-400">
            {data.contractor.companyName} · CA license #<span data-testid="license-number">{data.contractor.licenseNumber}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <LicenseBadge status={shown} running={running} />
            {completed && !running ? (
              <span className="text-xs text-slate-400" data-testid="license-checked-at">
                Checked {formatDateTime(completed.checkedAt)} via a KERNEL hosted browser ·{" "}
                {completed.status === "unverified" ? "not cached, the next check runs a new lookup" : "cached 24 h"}
              </span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void check()}
          disabled={busy || running}
          className="rounded-lg border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800 disabled:opacity-50"
          data-testid="license-check-button"
        >
          {running ? "Checking…" : "Check license"}
        </button>
      </div>

      {running ? (
        latest?.liveViewUrl ? (
          <div className="space-y-1">
            <p className="text-xs text-sky-200">Live view of the CSLB lookup in a KERNEL hosted browser</p>
            <iframe
              src={latest.liveViewUrl}
              title="KERNEL live view of the CSLB license lookup"
              className="w-full h-96 rounded-lg border border-slate-700 bg-black"
              data-testid="license-live-view"
            />
          </div>
        ) : (
          <p className="text-xs text-slate-400" role="status">Starting the KERNEL browser…</p>
        )
      ) : null}

      {!running && stale ? (
        <p className="text-xs text-amber-200">The last lookup did not finish, so the license is unverified.</p>
      ) : null}
      {!running && completed ? (
        <p className="text-xs text-slate-300 whitespace-pre-line" data-testid="license-summary">
          {completed.rawSummary}
        </p>
      ) : null}
      {note ? <p className="text-xs text-slate-300" role="status" data-testid="license-check-note">{note}</p> : null}
      {error ? <p role="alert" className="text-xs text-red-300">{error}</p> : null}
    </section>
  );
}
