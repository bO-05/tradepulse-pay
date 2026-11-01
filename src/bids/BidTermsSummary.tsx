import { DateText, Money, StatusPill } from "../ui";
import type { BidTermsValue } from "./bidForm";

/** Read-only view of a bid's bidder-facing terms. */
export function BidTermsSummary({ terms }: { terms: BidTermsValue }) {
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-xs text-ink-subtle">Base bid</dt>
        <dd className="text-base font-semibold" data-testid="bid-base">
          <Money cents={terms.baseAmountCents} />
        </dd>
      </div>
      <div>
        <dt className="text-xs text-ink-subtle">Valid until</dt>
        <dd>{terms.validUntil ? <DateText value={terms.validUntil} /> : "Not stated"}</dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="text-xs text-ink-subtle">Alternates</dt>
        <dd>
          {terms.alternates.length === 0 ? (
            "None"
          ) : (
            <ul className="space-y-1">
              {terms.alternates.map((a, i) => (
                <li key={i} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="break-words">{a.description}</span>
                  <span className="flex items-center gap-2">
                    {a.amountCents < 0 && <StatusPill status="deducted" label="Deduct" />}
                    <Money cents={a.amountCents} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>
      <TermList label="Exclusions" items={terms.exclusions} />
      <TermList label="Inclusions" items={terms.inclusions} />
      <div className="sm:col-span-2">
        <dt className="text-xs text-ink-subtle">Unit prices</dt>
        <dd>
          {terms.unitPrices.length === 0 ? (
            "None"
          ) : (
            <ul className="space-y-1">
              {terms.unitPrices.map((u, i) => (
                <li key={i} className="flex flex-wrap justify-between gap-2">
                  <span className="break-words">{u.item}</span>
                  <span>
                    <Money cents={u.unitPriceCents} /> / {u.unit}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>
      {terms.qualifications && (
        <div className="sm:col-span-2">
          <dt className="text-xs text-ink-subtle">Qualifications</dt>
          <dd className="whitespace-pre-wrap break-words">{terms.qualifications}</dd>
        </div>
      )}
    </dl>
  );
}

function TermList({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd>
        {items.length === 0 ? (
          "None"
        ) : (
          <ul className="list-disc space-y-0.5 pl-5">
            {items.map((x) => (
              <li key={x} className="break-words">
                {x}
              </li>
            ))}
          </ul>
        )}
      </dd>
    </div>
  );
}
