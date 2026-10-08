import { formatDate, formatDateTime } from "./format";

export interface DateTextProps {
  /** Epoch milliseconds or a calendar date `YYYY-MM-DD`. */
  value: number | string | null | undefined;
  withTime?: boolean;
  className?: string;
}

function toIso(value: number | string): string | undefined {
  if (typeof value === "string") return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
  return Number.isFinite(value) ? new Date(value).toISOString() : undefined;
}

export function DateText({ value, withTime = false, className }: DateTextProps) {
  if (value === null || value === undefined || value === "") return <span className={className}>—</span>;
  const text = withTime && typeof value === "number" ? formatDateTime(value) : formatDate(value);
  return (
    <time dateTime={toIso(value)} className={className}>
      {text}
    </time>
  );
}
