import { cx } from "./cx";
import { formatCents } from "./format";

export interface MoneyProps {
  cents: number | null | undefined;
  showPlus?: boolean;
  className?: string;
}

export function Money({ cents, showPlus, className }: MoneyProps) {
  return <span className={cx("tabular-nums", className)}>{formatCents(cents, { showPlus })}</span>;
}
