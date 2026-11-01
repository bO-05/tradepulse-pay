import type { ReactNode } from "react";
import { cx } from "./cx";

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  /** Primary next step, e.g. a <Button> "Create your first project". */
  action?: ReactNode;
  secondaryAction?: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
}

export function EmptyState({ title, description, icon, action, secondaryAction, headingLevel = 2, className }: EmptyStateProps) {
  const Heading = `h${headingLevel}` as "h2" | "h3";
  return (
    <div className={cx("flex flex-col items-center rounded-xl border border-dashed border-line px-6 py-10 text-center", className)}>
      {icon && (
        <div aria-hidden="true" className="mb-3 text-ink-subtle">
          {icon}
        </div>
      )}
      <Heading className="text-base font-semibold text-ink">{title}</Heading>
      {description && <p className="mt-1 max-w-md text-sm text-ink-subtle">{description}</p>}
      {(action || secondaryAction) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
