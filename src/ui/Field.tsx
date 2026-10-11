import { useId, type ReactNode } from "react";
import { cx } from "./cx";

export interface FieldControlProps {
  id: string;
  required?: boolean;
  "aria-required"?: boolean;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}

export interface FieldProps {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  id?: string;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}

/** Label, required marker, hint and inline error wired to the control through ids and ARIA. */
export function Field({ label, required, hint, error, id, className, children }: FieldProps) {
  const autoId = useId();
  const controlId = id ?? `field-${autoId}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={controlId} className="text-sm font-medium text-ink">
        {label}
        {required && (
          <>
            <span aria-hidden="true" className="ml-0.5 text-rose-300">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </label>
      {children({
        id: controlId,
        required,
        "aria-required": required || undefined,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy,
      })}
      {hint && !error && (
        <p id={hintId} className="text-xs text-ink-subtle">
          {hint}
        </p>
      )}
      {hint && error && (
        <p id={hintId} className="sr-only">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs font-medium text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}

/** Moves focus to the first invalid control inside a form; call after setting errors on submit. */
export function focusFirstInvalid(container: HTMLElement | null): void {
  if (!container) return;
  // Errors render on the next paint, so wait for React to commit aria-invalid first.
  requestAnimationFrame(() => {
    const el = container.querySelector<HTMLElement>('[aria-invalid="true"]');
    el?.focus();
  });
}

export const inputClass = (invalid: boolean, extra?: string) =>
  cx(
    "min-h-touch w-full rounded-lg border bg-surface-sunken px-3 text-sm text-ink placeholder:text-slate-400",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
    "disabled:cursor-not-allowed disabled:opacity-60",
    invalid ? "border-rose-400" : "border-line-strong",
    extra,
  );
