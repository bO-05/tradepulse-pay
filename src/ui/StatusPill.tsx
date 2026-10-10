import { cx } from "./cx";
import { TONE_CLASSES, statusMeta, type StatusTone } from "./statusLabels";

export interface StatusPillProps {
  status: string | null | undefined;
  /** Overrides the mapped label for context-specific wording; the code still picks the color. */
  label?: string;
  tone?: StatusTone;
  className?: string;
}

export function StatusPill({ status, label, tone, className }: StatusPillProps) {
  const meta = statusMeta(status);
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
