import type { AnchorHTMLAttributes, ReactNode } from "react";
import { cx, focusRing } from "./cx";

export type LinkButtonVariant = "primary" | "secondary";
export type LinkButtonSize = "sm" | "md";

const VARIANTS: Record<LinkButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover border border-transparent",
  secondary: "bg-surface-raised text-ink border border-line-strong hover:bg-slate-700",
};

const SIZES: Record<LinkButtonSize, string> = {
  sm: "min-h-9 px-3 text-xs gap-1.5",
  md: "min-h-touch px-4 text-sm gap-2",
};

export interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: LinkButtonVariant;
  size?: LinkButtonSize;
  children: ReactNode;
}

/**
 * A real link that looks like a button. Use it for navigation and external receipts where the
 * action opens another page; product actions stay `Button` elements.
 */
export function LinkButton({ variant = "secondary", size = "md", className, children, ...rest }: LinkButtonProps) {
  return (
    <a
      className={cx(
        "inline-flex items-center justify-center rounded-lg font-semibold transition-colors",
        VARIANTS[variant],
        SIZES[size],
        focusRing,
        className,
      )}
      {...rest}
    >
      {children}
    </a>
  );
}
