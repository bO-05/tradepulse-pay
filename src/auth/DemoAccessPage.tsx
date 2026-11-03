import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth } from "convex/react";
import { useState } from "react";
import { describeAuthError } from "./authErrors";
import { FormAlert } from "./AuthLayout";
import { useSignOutAndReset } from "./signOutAndReset";
import { BuildStamp } from "../ui/BuildStamp";

export const DEMO_ACCESS_HASH = "#/demo";
export const DEMO_PASSWORD = "TradePulseDemo!2026";
const ROLES = [
  { email: "gc@demo.tradepulse", title: "General contractor", detail: "Review the evidence, run a scenario, approve payments.", hash: "#/judge-demo" },
  { email: "sub1@demo.tradepulse", title: "Subcontractor", detail: "Inspect agreements, pay applications and payment status.", hash: "#/portal" },
  { email: "owner@demo.tradepulse", title: "Project owner", detail: "Review change orders and open the PayPal invoice.", hash: "#/projects" },
] as const;

/** Public instructions; every role still signs in through the ordinary password provider. */
export function DemoAccessPage() {
  const { signIn } = useAuthActions();
  const signOutAndReset = useSignOutAndReset();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function enter(role: (typeof ROLES)[number]) {
    if (pending || isAuthenticated) return;
    setPending(role.email);
    setError(null);
    try {
      const result = await signIn("password", { email: role.email, password: DEMO_PASSWORD, flow: "signIn" });
      if (!result.signingIn) throw new Error("The demo account needs verification. Use normal sign-in or report this to the project owner.");
      window.location.hash = role.hash;
    } catch (err) {
      setError(describeAuthError(err, "signIn").message);
    } finally {
      setPending(null);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 px-5 py-8 sm:px-10 sm:py-12" data-testid="demo-access-page">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-700 pb-5">
          <a href="#" className="text-lg font-bold tracking-tight">TradePulse Pay</a>
          <span className="font-mono text-xs uppercase tracking-widest text-amber-200">PayPal sandbox · Judge field guide</span>
        </header>
        <div className="grid gap-10 py-10 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
          <section className="space-y-6">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-emerald-300">From awarded scope to auditable payment</p>
            <h1 className="max-w-xl font-serif text-5xl leading-[1.05] sm:text-6xl">Trust the receipt.<br /><span className="text-emerald-300">Not the promise.</span></h1>
            <p className="max-w-lg text-lg leading-relaxed text-slate-300">
              AI checks the pay application. Code computes the dollars. The GC decides.
              PayPal moves the sandbox funds, and the ledger shows what actually settled.
            </p>
            <button type="button" className="rounded-lg border border-emerald-500 px-4 py-3 text-sm font-semibold text-emerald-200 lg:hidden"
              onClick={() => {
                const target = document.getElementById("choose-demo-role");
                target?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
                target?.focus({ preventScroll: true });
              }}>
              Choose a demo role →
            </button>
            <div className="border-l-2 border-emerald-400 pl-5 space-y-3 text-sm text-slate-300">
              <p><strong className="text-white">2-minute inspection.</strong> Enter as General contractor. Choose a previous run, inspect its steps, open the agreement ledger and compare capture, payout and invoice IDs.</p>
              <p><strong className="text-white">5–10-minute hands-on run.</strong> Choose “Run TradePulse Pay demo.” It creates a separate $55,000 award. You authorize $5,500 in PayPal; the driver then submits labeled fixtures and approves the displayed demo proposals as the GC.</p>
              <p><strong className="text-white">Owner step.</strong> Open a separate private browser as Project owner, pay the $1,850 change-order invoice, then refresh its status in the GC tab. A submitted payout is not a settled payout.</p>
            </div>
            <p className="text-xs leading-relaxed text-amber-200">
              Shared, public demo accounts only. Do not enter personal, customer or banking information.
              Compliance documents, sub submissions and Owner change-order approval are explicitly labeled demo stand-ins.
              Funding and invoice payment still require real sandbox browser approval. This is not full-contract completion.
            </p>
          </section>
          <section aria-labelledby="choose-demo-role" className="space-y-4">
            <h2 id="choose-demo-role" tabIndex={-1} className="text-xl font-semibold">Choose your seat</h2>
            <p className="text-sm text-slate-400">No signup or sponsor account needed for the core demo. These buttons use normal demo-account sign-in, not an authentication bypass.</p>
            {error && <FormAlert>{error}</FormAlert>}
            {isAuthenticated ? (
              <div className="rounded-xl border border-emerald-800 bg-emerald-950/30 p-5 space-y-3">
                <p>You are already signed in. Your current account will not be replaced.</p>
                <div className="flex flex-wrap gap-4 text-sm text-emerald-300">
                  <a href="#" className="underline">Open your workspace</a>
                  <button type="button" className="underline" onClick={async () => { await signOutAndReset(); window.location.hash = DEMO_ACCESS_HASH; }}>Sign out to choose a demo role</button>
                </div>
              </div>
            ) : ROLES.map((role, index) => (
              <button key={role.email} type="button" onClick={() => void enter(role)} disabled={isLoading || pending !== null}
                data-testid={`demo-enter-${index === 0 ? "gc" : index === 1 ? "sub" : "owner"}`}
                className="w-full rounded-xl border border-slate-700 bg-slate-900 p-5 text-left transition hover:border-emerald-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-50">
                <span className="flex items-center justify-between gap-3 text-lg font-semibold"><span>{role.title}</span><span aria-hidden="true" className="text-emerald-300">→</span></span>
                <span className="mt-1 block text-sm text-slate-300">{role.detail}</span>
                <span className="mt-3 block break-all font-mono text-xs text-emerald-300">{pending === role.email ? "Signing in…" : role.email}</span>
              </button>
            ))}
            <p className="break-words text-xs text-slate-400">Manual sign-in password: <code className="text-slate-200">{DEMO_PASSWORD}</code>. Use a separate browser context per role. Bookmark your run-specific URL to return to the same run.</p>
            <a href="#" className="inline-block text-sm text-emerald-300 underline">Normal sign-in / create a GC account</a>
            <p className="text-xs text-slate-400">Recovery-dev email signup needs an allowlisted test inbox. For immediate judge access, use the public roles above instead of your personal email.</p>
          </section>
        </div>
        <section className="grid gap-6 border-t border-slate-700 py-7 md:grid-cols-3 text-sm" aria-label="Demo ground rules">
          <div><h2 className="font-semibold text-amber-200">Sandbox checkout</h2><p className="mt-2 text-slate-300">Choose United States and pay as guest. Card <code>4032031427005060</code>, expiry <code>01/29</code>, CVV <code>480</code>. Use synthetic details: Sandbox Buyer, 123 Test Street, San Jose, CA 95131, 2025550100, and a unique <code>@example.com</code> email.</p></div>
          <div><h2 className="font-semibold text-amber-200">What to verify</h2><p className="mt-2 text-slate-300">Read the AI provider and verdicts in the approval inbox. Check PayPal captures are COMPLETED, payout items are SUCCESS, and the Owner invoice is PAID. Dashboard and agreement-ledger totals must agree. Pending, unclaimed or failed is not paid.</p></div>
          <div><h2 className="font-semibold text-amber-200">Honest limits</h2><p className="mt-2 text-slate-300">AgentID needs owner-approved OAuth setup on this recovery build. The ordinary dashboard works without AG Studio; its optional licensed editor needs a valid license. Model or browser-service failures are surfaced, not presented as successful live calls.</p></div>
        </section>
        <footer className="border-t border-slate-800 py-6 text-xs leading-relaxed text-slate-400">
          <p>
            Canonical: <a href="https://tradepulse-pay.asynchronope.tech/#/demo" className="text-emerald-300 underline underline-offset-2">tradepulse-pay.asynchronope.tech/#/demo</a>
            <span aria-hidden="true"> · </span>
            Mirror: <a href="https://cheery-axolotl-689.convex.site/#/demo" className="text-emerald-300 underline underline-offset-2">cheery-axolotl-689.convex.site/#/demo</a>
          </p>
          <p className="mt-1">Both addresses serve the same build. Backend, health checks and webhooks stay on the .convex.site deployment.</p>
          <BuildStamp className="mt-2" />
        </footer>
      </div>
    </main>
  );
}
