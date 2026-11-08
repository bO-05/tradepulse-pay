import { cx } from "./cx";
import { TONE_CLASSES, statusMetaFor, type StatusTone } from "./statusLabels";
import type { ProjectKind } from "../lib/terms";

export interface StatusPillProps {
  status: string | null | undefined;
  /** Overrides the mapped label for context-specific wording; the code still picks the color. */
  label?: string;
  /** Kind-aware label overrides (for example "Signed" for an executed agreement on a residential job). */
  kind?: ProjectKind | null;
  tone?: StatusTone;
  className?: string;
}

export function StatusPill({ status, label, kind, tone, className }: StatusPillProps) {
  const meta = statusMetaFor(status, kind);
  return (
    <span
      data-status={status ?? undefined}
      className={cx(
        "inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium",
        TONE_CLASSES[tone ?? meta.tone],
        className,
      )}
    >
      {label ?? meta.label}
    </span>
  );
}
