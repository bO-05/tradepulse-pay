import { cx } from "./cx";
import { termsForKind, type ProjectKind } from "../lib/terms";

export interface CommercialReferenceBadgeProps {
  /** The job's kind. A missing kind means commercial, matching every other reader. */
  kind?: ProjectKind | null;
  className?: string;
}

/**
 * "Commercial reference job" on commercial screens only. The commercial reference keeps its AIA
 * vocabulary; residential jobs never render this badge (and never render commercial wording).
 */
export function CommercialReferenceBadge({ kind, className }: CommercialReferenceBadgeProps) {
  const terms = termsForKind(kind);
  if (!terms.commercialBadge) return null;
  return (
    <span
      data-testid="commercial-reference-badge"
      className={cx(
        "inline-flex items-center whitespace-nowrap rounded-full border border-sky-700 bg-sky-950 px-2.5 py-0.5 text-xs font-medium text-sky-200",
        className,
      )}
    >
      {terms.commercialBadgeLabel}
    </span>
  );
}
