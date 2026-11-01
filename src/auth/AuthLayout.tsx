import type { ReactNode } from "react";
import { cx, focusRing } from "../ui";

/** Shared frame for the signed-out screens: brand, one h1 card, optional footer. */
export function AuthLayout({ title, description, children, footer }: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-surface-sunken text-ink flex items-center justify-center px-4 py-10 font-sans">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-6">
          <div aria-hidden="true" className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-700 border border-emerald-400/30" />
          <div>
            <p className="text-lg font-bold tracking-tight">TradePulse Pay</p>
            <p className="text-xs text-ink-subtle">Subcontract procurement and payments</p>
          </div>
        </div>
        <main className="bg-surface border border-line rounded-2xl p-6 shadow-xl">
          <h1 className="text-base font-semibold">{title}</h1>
          {description && <div className="mt-1 text-sm text-ink-subtle">{description}</div>}
          <div className="mt-4">{children}</div>
        </main>
        {footer && <div className="mt-4 text-sm text-ink-subtle text-center">{footer}</div>}
      </div>
    </div>
  );
}

export function TextLink({ onClick, children, className }: { onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx("rounded text-sm font-medium text-emerald-300 underline-offset-2 hover:underline", focusRing, className)}
    >
      {children}
    </button>
  );
}

export function FormAlert({ tone = "error", children }: { tone?: "error" | "info"; children: ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cx(
        "text-sm rounded-lg px-3 py-2 border",
        tone === "error" ? "text-rose-200 bg-rose-950/60 border-rose-800/70" : "text-sky-100 bg-sky-950/50 border-sky-800/70",
      )}
    >
      {children}
    </p>
  );
}
