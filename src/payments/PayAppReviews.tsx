import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { readableError } from "./FundMilestone";
import { formatCents, formatDate } from "./format";
import { LicenseCheckPanel } from "./LicenseCheck";

type PayAppWithReview = FunctionReturnType<typeof api.payApps.review.listAgreementPayApps>[number];

const VERDICT_STYLE: Record<string, string> = {
  ok: "bg-emerald-950 border-emerald-800 text-emerald-200",
  overbilled: "bg-rose-950 border-rose-800 text-rose-200",
  excluded_scope: "bg-amber-950 border-amber-800 text-amber-200",
  front_loaded: "bg-orange-950 border-orange-800 text-orange-200",
  out_of_sequence: "bg-violet-950 border-violet-800 text-violet-200",
};

const VERDICT_LABEL: Record<string, string> = {
  ok: "ok",
  overbilled: "overbilled",
  excluded_scope: "excluded scope",
  front_loaded: "front-loaded",
  out_of_sequence: "out of sequence",
};

const LICENSE_FLAG_TEXT: Record<string, string> = {
  none: "No license check yet",
  unverified: "Unverified",
  expired: "Expired",
  suspended: "Suspended",
  inactive: "Inactive",
  not_found: "Not found at CSLB",
};

const pct = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`;

/** Provenance line: the provider and model that actually ran, or the offline rules engine. */
function ReviewSource({ review }: { review: NonNullable<PayAppWithReview["review"]> }) {
  if (review.provider === "Anthropic") {
    return (
      <p className="text-xs text-slate-300" data-testid="payapp-review-source">
        Reviewed by {review.provider} · model {review.model} · {formatDate(review.reviewedAt)}
      </p>
    );
  }
  return (
    <p className="text-xs text-amber-200" data-testid="payapp-review-source">
      Reviewed by the {review.provider}: deterministic rules, no AI model ran
      {review.fallbackReason ? ` (${review.fallbackReason})` : ""} · {formatDate(review.reviewedAt)}
    </p>
  );
}

function RerunReviewButton({ payAppId, label }: { payAppId: string; label: string }) {
  const rerun = useAction(api.payApps.review.rerunPayAppReview);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      await rerun({ payAppId });
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="rounded-lg border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800 disabled:opacity-50"
      >
        {busy ? "Reviewing…" : label}
      </button>
      {error ? (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** One pay application with its per-line review. Dollar amounts come from code, never from the model. */
export function PayAppReviewCard({ payApp, canRerun }: { payApp: PayAppWithReview; canRerun: boolean }) {
  const review = payApp.review;
  const rerunnable = ["submitted", "under_review", "reviewed"].includes(payApp.status);
  return (
    <article className="border border-slate-800 rounded-xl p-4 space-y-3" data-testid="payapp-review-card">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{payApp.periodLabel}</h3>
          <p className="text-xs text-slate-400">
            Submitted {formatDate(payApp.createdAt)} by{" "}
            {payApp.submittedBy.actorType === "agent"
              ? `billing agent ${payApp.submittedBy.agentEmail ?? ""}${payApp.submittedBy.onBehalfOf ? ` on behalf of ${payApp.submittedBy.onBehalfOf}` : ""}`
              : "the subcontractor"}
            {" · "}status <span data-testid="payapp-review-status">{payApp.status}</span>
          </p>
        </div>
        <dl className="flex gap-4 text-sm">
          <div>
            <dt className="text-xs text-slate-400">Requested</dt>
            <dd className="tabular-nums" data-testid="payapp-requested-total">{formatCents(payApp.requestedTotalCents)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Recommended (code-computed)</dt>
            <dd className="tabular-nums font-semibold" data-testid="payapp-approved-total">
              {review ? formatCents(review.approvedTotalCents) : "—"}
            </dd>
          </div>
          {payApp.finalApproval ? (
            <div>
              <dt className="text-xs text-slate-400">Final approved (GC)</dt>
              <dd className="tabular-nums font-semibold text-emerald-200" data-testid="payapp-final-approved-total">
                {formatCents(payApp.finalApproval.totalCents)}
              </dd>
            </div>
          ) : null}
        </dl>
      </header>

      {payApp.status === "rejected" && payApp.rejectionReason ? (
        <p className="text-xs text-rose-300" data-testid="payapp-rejection-reason">
          Rejected: {payApp.rejectionReason}
        </p>
      ) : null}
      {review ? (
        <>
          <ReviewSource review={review} />
          <div className="flex flex-wrap gap-2 text-xs">
            {review.flags.lienWaiverMissing ? (
              <span className="rounded-full border border-rose-800 bg-rose-950 px-2 py-0.5 text-rose-200" data-testid="flag-lien-waiver-missing">
                Lien waiver missing
              </span>
            ) : null}
            {review.flags.licenseIssue ? (
              <span className="rounded-full border border-rose-800 bg-rose-950 px-2 py-0.5 text-rose-200" data-testid="flag-license-issue">
                License issue: {LICENSE_FLAG_TEXT[review.flags.licenseStatus ?? "none"] ?? "Unverified"}
              </span>
            ) : review.flags.licenseStatus === "active" ? (
              <span className="rounded-full border border-emerald-800 bg-emerald-950 px-2 py-0.5 text-emerald-200" data-testid="flag-license-active">
                License: CSLB active
              </span>
            ) : null}
          </div>
          {review.flags.notes ? <p className="text-xs text-slate-300">{review.flags.notes}</p> : null}
        </>
      ) : (
        <p className="text-xs text-slate-400" role="status">
          {payApp.status === "under_review" ? "Review in progress…" : "Not reviewed yet."}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="payapp-review-lines">
          <thead className="text-xs text-slate-400 text-left">
            <tr>
              <th className="py-2 pr-3 font-medium">Line</th>
              <th className="py-2 pr-3 font-medium text-right">Claimed to date</th>
              <th className="py-2 pr-3 font-medium text-right">Recommended to date</th>
              <th className="py-2 pr-3 font-medium text-right">Requested</th>
              <th className="py-2 pr-3 font-medium text-right">Recommended</th>
              {payApp.finalApproval ? <th className="py-2 pr-3 font-medium text-right">Final approved</th> : null}
              <th className="py-2 pr-3 font-medium">Verdict and reason</th>
            </tr>
          </thead>
          <tbody>
            {payApp.lines.map((l) => (
              <tr key={l.sovLineId} className="border-t border-slate-800 align-top" data-testid="payapp-review-line">
                <td className="py-2 pr-3">
                  {l.lineNo}. {l.description}
                  {l.excludedScope ? <span className="block text-xs text-amber-300">Excluded scope</span> : null}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{l.pctCompleteToDate}%</td>
                <td className="py-2 pr-3 text-right tabular-nums">{l.review ? pct(l.review.recommendedPctToDate) : "—"}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatCents(l.requestedCents)}</td>
                <td className="py-2 pr-3 text-right tabular-nums" data-testid="payapp-line-approved">
                  {l.review ? formatCents(l.review.approvedCents) : "—"}
                </td>
                {payApp.finalApproval ? (
                  <td className="py-2 pr-3 text-right tabular-nums" data-testid="payapp-line-final-approved">
                    {formatCents(l.finalApprovedCents ?? 0)}
                  </td>
                ) : null}
                <td className="py-2 pr-3">
                  {l.review ? (
                    <>
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-xs ${VERDICT_STYLE[l.review.verdict] ?? ""}`}
                        data-testid="payapp-line-verdict"
                      >
                        {VERDICT_LABEL[l.review.verdict] ?? l.review.verdict}
                      </span>
                      <span className="block text-xs text-slate-300 mt-1">{l.review.reason}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canRerun && rerunnable ? (
        <div className="flex justify-end">
          <RerunReviewButton payAppId={payApp._id} label={review ? "Re-run review" : "Run review"} />
        </div>
      ) : null}
    </article>
  );
}

/** GC section of the agreement ledger: every pay application and its review. */
export function AgreementPayAppReviews({ agreementId, contractorId }: { agreementId: string; contractorId: string }) {
  const payApps = useQuery(api.payApps.review.listAgreementPayApps, { agreementId });
  return (
    <section aria-labelledby="ledger-payapps" className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
      <h2 id="ledger-payapps" className="text-base font-semibold">
        Pay applications and reviews
      </h2>
      <p className="text-xs text-slate-400">
        Each submitted pay application is reviewed line by line. The reviewer recommends a percent complete; approved
        amounts are computed by code as round(scheduled value × recommended %) − previously billed, capped at the request.
      </p>
      <LicenseCheckPanel contractorId={contractorId} />
      {payApps === undefined ? (
        <p className="text-sm text-slate-400" role="status">Loading pay applications…</p>
      ) : payApps.length === 0 ? (
        <p className="text-sm text-slate-400">No pay applications on this agreement yet.</p>
      ) : (
        <div className="space-y-4">
          {payApps.map((p) => (
            <PayAppReviewCard key={p._id} payApp={p} canRerun />
          ))}
        </div>
      )}
    </section>
  );
}
