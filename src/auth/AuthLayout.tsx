import { useEffect, useRef, type ReactNode } from "react";
import { cx, focusRing } from "../ui";

/** Shared frame for the signed-out screens: brand, one card, optional footer, optional marketing hero. */
export function AuthLayout({ title, description, children, footer, hero }: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** The residential pitch shown beside the card on wide screens and above it on phones. */
  hero?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // The signed-in shell disappears on sign-out; land focus on the new screen's heading instead of <body>.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const Heading = hero ? "h2" : "h1";
  const headingProps = { ref: heading, tabIndex: -1, className: "text-base font-semibold outline-none" };
  return (
    <div className="min-h-screen bg-surface-sunken text-ink flex items-center justify-center px-4 py-10 font-sans">
      <div className={hero ? "w-full max-w-6xl grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-start lg:gap-16" : "w-full max-w-sm"}>
        {hero ? <div className="pt-1">{hero}</div> : null}
        <div className={hero ? "w-full max-w-sm lg:justify-self-end" : "w-full"}>
          <div className="flex items-center gap-3 mb-6">
            <div aria-hidden="true" className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-700 border border-emerald-400/30" />
            <div>
              <p className="text-lg font-bold tracking-tight">TradePulse Pay</p>
              <p className="text-xs text-ink-subtle">Pay apps for residential remodel GCs. Checked before you pay.</p>
            </div>
          </div>
          <p className="mb-4 rounded-xl border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-100" data-testid="auth-sandbox-notice">
            <strong>PayPal sandbox · no real money.</strong> This test build uses synthetic data and sandbox payments only.
          </p>
          <main className="bg-surface border border-line rounded-2xl p-6 shadow-xl">
            <Heading {...headingProps}>{title}</Heading>
            {description && <div className="mt-1 text-sm text-ink-subtle">{description}</div>}
            <div className="mt-4">{children}</div>
          </main>
          {footer && <div className="mt-4 text-sm text-ink-subtle text-center">{footer}</div>}
        </div>
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
