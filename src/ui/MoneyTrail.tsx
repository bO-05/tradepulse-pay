import type { ReactNode } from "react";
import { Card } from "./Card";
import { cx } from "./cx";
import { formatCents } from "./format";

/**
 * The shared money trail: an ordered set of labeled cents, with no math of its own.
 *
 * Sub, GC and owner surfaces pass the stored figures they already have, so one component renders
 * every trail and no screen re-derives a dollar. Values sit in `<dd>` elements, which keeps the
 * pinned hooks (`proposal-amount`, `proposal-net`, ...) on the element type they had before.
 */
export interface MoneyTrailStep {
  label: string;
  valueCents: number | null;
  /** Small print under the figure, for a milestone, status word or date. */
  note?: ReactNode;
  /** Pinned test id on the value element. */
  valueTestId?: string;
  tone?: "default" | "warning" | "positive";
}

export interface MoneyTrailProps {
  steps: readonly MoneyTrailStep[];
  /**
   * The number the screen exists to show. Rendered above the stages at `text-3xl` — the largest
   * figure on the page — so a phone reader sees the outcome before the derivation.
   */
  hero?: MoneyTrailStep;
  title?: ReactNode;
  description?: ReactNode;
  testId?: string;
  ariaLabel?: string;
  /** `compact` drops the Card and shrinks the type for use inside a proposal card. */
  variant?: "default" | "compact";
  /** Fine print under the steps: the retainage held, the edit note, a receipt link. */
  footer?: ReactNode;
  className?: string;
}

const VALUE_TONE: Record<NonNullable<MoneyTrailStep["tone"]>, string> = {
  default: "text-ink",
  warning: "text-amber-200",
  positive: "text-emerald-200",
};

export function MoneyTrail({
  steps,
  hero,
  title,
  description,
  testId,
  ariaLabel = "Money trail",
  variant = "default",
  footer,
  className,
}: MoneyTrailProps) {
  const compact = variant === "compact";
  const headline = hero && !compact ? (
    <dl className="mb-2 rounded-lg border border-line-strong bg-surface-raised px-4 py-3">
      <dt className="text-[11px] uppercase tracking-wide text-ink-subtle">{hero.label}</dt>
      <dd
        data-testid={hero.valueTestId}
        className={cx("text-3xl font-bold leading-tight tabular-nums", VALUE_TONE[hero.tone ?? "default"])}
      >
        {formatCents(hero.valueCents)}
        {hero.note ? <span className="mt-0.5 block text-xs font-normal text-ink-muted">{hero.note}</span> : null}
      </dd>
    </dl>
  ) : null;

  const list = (
    <dl aria-label={ariaLabel} className="flex flex-wrap items-stretch gap-2">
      {steps.map((step, index) => (
        <div
          key={`${step.label}-${index}`}
          className={cx(
            "min-w-[8rem] flex-1 rounded-lg border border-line bg-surface-raised",
            compact ? "px-2.5 py-1.5" : "px-3 py-2",
          )}
        >
          <dt className="text-[11px] uppercase tracking-wide text-ink-subtle">
            {index > 0 ? (
              <span aria-hidden="true" className="mr-1">
                →
              </span>
            ) : null}
            {step.label}
          </dt>
          <dd
            data-testid={step.valueTestId}
            className={cx("tabular-nums font-semibold", compact ? "text-sm" : "text-lg", VALUE_TONE[step.tone ?? "default"])}
          >
            {formatCents(step.valueCents)}
            {step.note ? <span className="mt-0.5 block text-xs font-normal text-ink-subtle">{step.note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );

  const body = (
    <>
      {headline}
      {list}
      {footer ? <div className="mt-3 space-y-1">{footer}</div> : null}
    </>
  );

  if (title !== undefined || description !== undefined) {
    return (
      <Card data-testid={testId} title={title} description={description} className={className}>
        {body}
      </Card>
    );
  }
  return (
    <div data-testid={testId} className={className}>
      {body}
    </div>
  );
}
