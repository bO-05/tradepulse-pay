import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { cx, focusRing } from "./cx";

export interface PageHeaderProps {
  /** Rendered as the page's single h1. */
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
  meta?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, back, meta, className }: PageHeaderProps) {
  return (
    <header className={cx("mb-6 flex flex-col gap-3", className)}>
      {back && (
        <a
          href={back.href}
          className={cx("inline-flex w-fit items-center gap-1.5 rounded text-sm text-ink-subtle hover:text-ink", focusRing)}
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          {back.label}
        </a>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-ink sm:text-2xl">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-sm text-ink-subtle">{description}</p>}
          {meta && <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-muted">{meta}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
