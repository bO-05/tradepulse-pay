import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { OWNER_BILLING_HASH, ledgerHash, payAppHash } from "../auth/navigation";
import { Card, EmptyState, formatCents } from "../ui";

/** Billing → Retainage: per project, retainage the GC holds from each sub, kept apart from what the owner holds. */
export function RetainageView() {
  const data = useQuery(api.billing.retainage.projectRetainage, {});
  if (data === undefined) {
    return (
      <p className="text-sm text-slate-400" role="status">
        Loading retainage…
      </p>
    );
  }
  if (data.projects.length === 0) {
    return <EmptyState title="No retainage yet" description="Retainage appears here once a sub's approved pay app is paid." headingLevel={3} />;
  }
  return (
    <div className="space-y-4" data-testid="retainage-view">
      {data.projects.map((p) => (
        <Card key={p.projectId} title={p.projectTitle} headingLevel={3} data-testid="retainage-project">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-line p-3" data-testid="retainage-sub-total">
              <p className="text-xs text-ink-subtle">Retainage we hold from subs</p>
              <p className="text-lg font-semibold tabular-nums">{formatCents(p.subHeldCents)}</p>
            </div>
            <div className="rounded-lg border border-line p-3" data-testid="retainage-prime">
              <p className="text-xs text-ink-subtle">Retainage held by owner</p>
              {p.prime.heldCents !== null ? (
                <>
                  <p className="text-lg font-semibold tabular-nums">{formatCents(p.prime.heldCents)}</p>
                  <a href={OWNER_BILLING_HASH} className="text-xs text-emerald-400 hover:text-emerald-300">
                    {p.prime.note}
                  </a>
                </>
              ) : (
                <p className="text-sm text-ink-subtle">{p.prime.note}</p>
              )}
            </div>
          </div>
          {p.prime.tradeLines.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm" data-testid="retainage-prime-trades">
                <caption className="sr-only">Owner-level versus sub-level retainage per trade package</caption>
                <thead className="text-left text-xs text-ink-subtle">
                  <tr>
                    <th scope="col" className="py-2 pr-3 font-medium">Trade package</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Owner holds (prime line)</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">We hold (sub pay apps)</th>
                  </tr>
                </thead>
                <tbody>
                  {p.prime.tradeLines.map((l) => (
                    <tr key={l.description} className="border-t border-line" data-testid="retainage-prime-trade-row">
                      <td className="py-2 pr-3">{l.description}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatCents(l.ownerRetainageCents)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{l.subRetainageCents === null ? "–" : formatCents(l.subRetainageCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {p.prime.roundingNote ? (
                <p className="mt-2 text-xs text-ink-subtle" data-testid="retainage-rounding-note">
                  {p.prime.roundingNote}
                </p>
              ) : null}
            </div>
          ) : null}
          {p.agreements.length === 0 ? (
            <p className="mt-4 text-sm text-ink-muted">No subcontracts on this project yet.</p>
          ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm" data-testid="retainage-agreements">
              <caption className="sr-only">Retainage held per subcontract</caption>
              <thead className="text-left text-xs text-ink-subtle">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">Subcontractor</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Trade</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Pay apps</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Held</th>
                </tr>
              </thead>
              <tbody>
                {p.agreements.map((a) => (
                  <tr key={a.agreementId} className="border-t border-line" data-testid="retainage-agreement-row">
                    <td className="py-2 pr-3">
                      <a href={ledgerHash(a.agreementId)} className="text-emerald-400 hover:text-emerald-300">
                        {a.subcontractorName}
                      </a>
                      <span className="block text-xs text-ink-subtle">{a.agreementNumber}</span>
                    </td>
                    <td className="py-2 pr-3">{a.trade}</td>
                    <td className="py-2 pr-3 text-xs">
                      {a.entries.length === 0
                        ? "None paid yet"
                        : a.entries.map((e, i) => (
                            <span key={i} className="block tabular-nums">
                              {e.deltaCents > 0 ? "+" : ""}
                              {formatCents(e.deltaCents)}{" "}
                              {e.payAppId ? (
                                <a href={payAppHash(e.payAppId)} className="text-emerald-400 hover:text-emerald-300">
                                  {e.applicationNo !== null ? `Pay app #${e.applicationNo}` : "Pay app"}
                                </a>
                              ) : (
                                "Earlier release"
                              )}
                            </span>
                          ))}
                    </td>
                    <td className="py-2 pr-3 text-right font-semibold tabular-nums">{formatCents(a.heldCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
          <p className="mt-3 text-xs text-ink-subtle">
            Sub retainage is rounded per schedule-of-values line on each sub pay app; the owner's retainage is rounded per prime line, so the
            two can differ by a cent for the same work.
          </p>
        </Card>
      ))}
      {data.truncated ? <p className="text-xs text-ink-subtle">Showing the newest subcontracts only.</p> : null}
    </div>
  );
}
