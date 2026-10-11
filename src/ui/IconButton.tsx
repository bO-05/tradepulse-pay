import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx, focusRing } from "./cx";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> {
  /** Accessible name; required because the button has no visible text. */
  label: string;
  icon: ReactNode;
  size?: "sm" | "md";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = "md", className, type, title, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={title ?? label}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-60",
        size === "md" ? "h-11 w-11" : "h-9 w-9",
        focusRing,
        className,
      )}
      {...rest}
    >
      <span aria-hidden="true" className="inline-flex">
        {icon}
      </span>
    </button>
  );
});
