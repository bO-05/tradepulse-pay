import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { DateText } from "../ui";

/** The GC's view of the package's addenda and which bidders acknowledged each. Addenda are uploaded in Files. */
export function PackageAddendaPanel({ tradePackageId }: { tradePackageId: Id<"tradePackages"> }) {
  const addenda = useQuery(api.addenda.listPackageAddenda, { tradePackageId });
  if (addenda === undefined) return null;
  return (
    <section aria-label="Addenda" className="space-y-2">
      <h4 className="text-sm font-semibold">Addenda ({addenda.length})</h4>
      {addenda.length === 0 ? (
        <p className="text-xs text-ink-subtle">No addenda yet. Upload one in Files with the type "Project Addendum"; invited bidders see it in the bid portal.</p>
      ) : (
        <ul className="divide-y divide-line text-sm" data-testid="package-addenda">
          {addenda.map((a) => (
            <li key={a._id} className="space-y-1 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="break-all font-medium">{a.fileName}</span>
                <span className="text-xs text-ink-subtle">
                  Issued <DateText value={a.uploadedAt} withTime />
                </span>
              </div>
              <p className="text-xs text-ink-subtle">
                {a.acknowledgments.length === 0
                  ? "No bidder has acknowledged it yet."
                  : a.acknowledgments.map((ack) => `${ack.bidderName} (${ack.userName})`).join(", ") + " acknowledged."}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
