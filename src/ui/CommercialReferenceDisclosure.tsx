import type { ReactNode } from "react";
import { cx } from "./cx";

export interface CommercialReferenceDisclosureProps {
  /** The true number of commercial records inside — the count in the summary is never an estimate. */
  count: number;
  /** Every commercial record, in the server's order. */
  children: ReactNode;
  /** The screen-specific hook on the `<details>` element, e.g. `projects-commercial`. */
  testId: string;
  /** The screen-specific hook on the `<summary>` element, e.g. `projects-commercial-summary`. */
  summaryTestId?: string;
  /** Spacing between the records inside the disclosure; each screen's rows set their own. */
  contentClassName?: string;
  className?: string;
}

/**
 * One initially closed, counted `Commercial reference job (n)` disclosure, shared by every GC
 * worklist. Residential rows render outside it and first; this element holds all of the remaining
 * rows in server order and puts the real record count in its summary. A native `<details>` keeps
 * every record and link in the DOM, keyboard-reachable and unchanged on expansion — the partition
 * is presentation only and changes no result set.
 */
export function CommercialReferenceDisclosure({
  count,
  children,
  testId,
  summaryTestId,
  contentClassName,
  className,
}: CommercialReferenceDisclosureProps) {
  return (
    <details
      className={cx("group rounded-2xl border border-slate-800 bg-slate-900/40", className)}
      data-testid={testId}
      data-record-count={count}
    >
      <summary
        className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden"
        data-testid={summaryTestId}
      >
        <span className="text-base font-semibold">Commercial reference job ({count})</span>
        <span aria-hidden="true" className="text-xs text-slate-400 group-open:hidden">
          Show
        </span>
        <span aria-hidden="true" className="hidden text-xs text-slate-400 group-open:inline">
          Hide
        </span>
      </summary>
      <div className={cx("border-t border-slate-800 p-3", contentClassName)}>{children}</div>
    </details>
  );
}
