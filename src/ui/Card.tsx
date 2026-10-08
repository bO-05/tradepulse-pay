import type { HTMLAttributes, ReactNode } from "react";
import { useId } from "react";
import { cx } from "./cx";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Heading level for the title; defaults to h2 so it nests under the PageHeader h1. */
  headingLevel?: 2 | 3 | 4;
  padded?: boolean;
}

export function Card({ title, description, actions, headingLevel = 2, padded = true, className, children, ...rest }: CardProps) {
  const headingId = useId();
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  return (
    <section
      aria-labelledby={title ? headingId : undefined}
      className={cx("rounded-xl border border-line bg-surface", padded && "p-4 sm:p-5", className)}
      {...rest}
    >
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && (
              <Heading id={headingId} className="text-base font-semibold text-ink">
                {title}
              </Heading>
            )}
            {description && <p className="mt-1 text-sm text-ink-subtle">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
