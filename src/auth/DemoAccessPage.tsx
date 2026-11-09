import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth } from "convex/react";
import { useState } from "react";
import { describeAuthError } from "./authErrors";
import { FormAlert } from "./AuthLayout";
import { DEMO_SEATS, type DemoSeat } from "./demoSeats";
import { ResidentialHeroIntro, ResidentialOutcomes } from "./ResidentialHero";
import { useSignOutAndReset } from "./signOutAndReset";
import { BuildStamp } from "../ui/BuildStamp";

export const DEMO_ACCESS_HASH = "#/demo";
export const DEMO_PASSWORD = "TradePulseDemo!2026";

/** Public instructions; every role still signs in through the ordinary password provider. */
export function DemoAccessPage() {
  const { signIn } = useAuthActions();
  const signOutAndReset = useSignOutAndReset();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function enter(seat: DemoSeat) {
    if (pending || isAuthenticated) return;
    setPending(seat.email);
    setError(null);
    try {
      const result = await signIn("password", { email: seat.email, password: DEMO_PASSWORD, flow: "signIn" });
      if (!result.signingIn) throw new Error("The demo account needs verification. Use normal sign-in or report this to the project owner.");
      window.location.hash = seat.hash;
    } catch (err) {
      setError(describeAuthError(err, "signIn").message);
    } finally {
      setPending(null);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 px-5 py-8 sm:px-10 sm:py-10" data-testid="demo-access-page">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-700 pb-5">
          <a href="#" className="text-lg font-bold tracking-tight">TradePulse Pay</a>
          <span className="font-mono text-xs uppercase tracking-widest text-amber-200">Residential remodel GCs · PayPal sandbox</span>
        </header>

        {/*
         * The seat picker is the first action: a judge should not scroll past a pitch or expand a
         * disclosure to start. On a 390px screen the compact headline and the three seats fit the
         * first viewport; everything manual lives in one collapsed disclosure below.
         */}
        <div className="grid gap-7 py-8 lg:grid-cols-[1fr_1.3fr] lg:items-start lg:gap-14 lg:py-10">
          <ResidentialHeroIntro headingId="demo-heading" level={1} compact />
          <section aria-labelledby="choose-demo-role" className="space-y-3">
            <h2 id="choose-demo-role" tabIndex={-1} className="text-xl font-semibold">Choose your seat</h2>
            <p className="max-w-xl text-sm text-slate-400">
              Start with the GC seat. No signup or sponsor account is needed for the core demo.
            </p>
            <p
              className="rounded-lg border border-emerald-900/70 bg-emerald-950/30 px-3 py-2 text-sm leading-relaxed text-emerald-100"
              data-testid="demo-money-proof"
            >
              Settled Lopez draw: <strong className="tabular-nums">$5,400.00</strong> requested,{" "}
              <strong className="tabular-nums">$4,000.00</strong> approved,{" "}
              <strong className="tabular-nums">$3,800.00</strong> paid after{" "}
              <strong className="tabular-nums">$200.00</strong> retainage.
            </p>
            {error && <FormAlert>{error}</FormAlert>}
            {isAuthenticated ? (
              <div className="rounded-xl border border-emerald-800 bg-emerald-950/30 p-5 space-y-3">
                <p>You are already signed in. Your current account will not be replaced.</p>
                <div className="flex flex-wrap gap-4 text-sm text-emerald-300">
                  <a href="#" className="underline">Open your workspace</a>
                  <button type="button" className="underline" onClick={async () => { await signOutAndReset(); window.location.hash = DEMO_ACCESS_HASH; }}>Sign out to choose a demo role</button>
                </div>
              </div>
            ) : (
              <div className="grid gap-2 sm:gap-3">
                {DEMO_SEATS.map((seat) => {
                  const primarySeat = seat.testId === "gc";
                  return (
                    <button
                      key={seat.email}
                      type="button"
                      onClick={() => void enter(seat)}
                      disabled={isLoading || pending !== null}
                      data-testid={`demo-enter-${seat.testId}`}
                      data-primary={primarySeat ? "true" : undefined}
                      className={`w-full rounded-xl border px-4 py-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-50 sm:p-5 ${
                        primarySeat
                          ? "border-transparent bg-accent text-accent-fg hover:bg-accent-hover"
                          : "border-slate-700 bg-slate-900 hover:border-emerald-400"
                      }`}
                    >
                      <span className="flex items-center justify-between gap-3 text-base font-semibold sm:text-lg">
                        <span>{seat.title}</span>
                        <span aria-hidden="true" className={primarySeat ? undefined : "text-emerald-300"}>→</span>
                      </span>
                      <span className={`mt-1 block text-sm ${primarySeat ? "text-accent-fg/90" : "text-slate-300"}`}>{seat.detail}</span>
                      <span className={`mt-2 block break-all font-mono text-xs ${primarySeat ? "text-accent-fg/90" : "text-emerald-300"}`}>
                        {pending === seat.email ? "Signing in…" : seat.email}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <p className="max-w-xl text-xs leading-relaxed text-slate-400" data-testid="demo-defence">
              These buttons use ordinary demo-account sign-in, not an authentication bypass. Funding and invoice
              payment still need sandbox browser approval.
            </p>
            <a href="#" className="inline-block text-sm text-emerald-300 underline">Normal sign-in / create a GC account</a>
          </section>
        </div>

        <div className="max-w-3xl space-y-1 rounded-lg border border-amber-800/70 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-100">
          <p><strong>PayPal sandbox · no real money</strong> moves here, and every demo account is shared.</p>
          <p><strong>Rules set the amount. Mistral explains it. You decide.</strong></p>
        </div>

        <div className="mt-4 max-w-3xl">
          <ManualSandboxDetails />
        </div>

        <section className="space-y-5 border-t border-slate-800 py-8 mt-8" aria-label="How TradePulse Pay works">
          <ResidentialOutcomes />
          <details className="group rounded-xl border border-slate-800 bg-slate-900/50">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-slate-200 [&::-webkit-details-marker]:hidden">
              <span>Judge walkthrough: inspect a settled run or create a new one</span>
              <span aria-hidden="true" className="text-lg leading-none text-emerald-300 transition group-open:rotate-45">+</span>
            </summary>
            <div className="space-y-3 border-t border-slate-800 px-4 py-4 text-sm text-slate-300">
              <p><strong className="text-white">2-minute inspection.</strong> Enter as General contractor. Choose a previous run, inspect its steps, open the agreement ledger and compare capture, payout and invoice IDs.</p>
              <p><strong className="text-white">5–10-minute hands-on run.</strong> Choose “Run TradePulse Pay demo.” It creates a separate $55,000 award. You authorize $5,500 in PayPal; the guided run then submits labeled example filings and approves the displayed proposals as the GC.</p>
              <p><strong className="text-white">Owner step.</strong> Open a separate private browser as Project owner, pay the $1,850 change-order invoice, then refresh its status in the GC tab. A submitted payout is not a settled payout.</p>
            </div>
          </details>
        </section>

        <section className="grid gap-6 border-t border-slate-700 py-7 md:grid-cols-3 text-sm" aria-label="Demo ground rules">
          <div>
            <h2 className="font-semibold text-amber-200">Sandbox payment</h2>
            <p className="mt-2 text-slate-300">Funding and invoice payment still require real sandbox browser approval. This is not a claim of full-contract completion.</p>
          </div>
          <div>
            <h2 className="font-semibold text-amber-200">What to verify</h2>
            <p className="mt-2 text-slate-300">Read the rules-computed amounts and the model’s explanations in the approval inbox. Check PayPal captures are COMPLETED, payout items are SUCCESS, and the Owner invoice is PAID. Dashboard and agreement-ledger totals must agree. Pending, unclaimed or failed is not paid.</p>
          </div>
          <div>
            <h2 className="font-semibold text-amber-200">Honest limits</h2>
            <p className="mt-2 text-slate-300">Model or browser-service failures are surfaced, not presented as successful live calls. Compliance documents, sub submissions and Owner change-order approval are explicitly labeled as examples.</p>
          </div>
        </section>

        <footer className="border-t border-slate-800 py-6 text-xs leading-relaxed text-slate-400">
          <p>
            Canonical:{" "}
            <a href="https://tradepulse-pay.asynchronope.tech/#/demo" className="text-emerald-300 underline underline-offset-2">
              tradepulse-pay.asynchronope.tech/#/demo
            </a>
          </p>
        </footer>
      </div>
    </main>
  );
}

/**
 * The single collapsed manual fallback. VAL-JUDGE-001 pins exactly six items here: the demo
 * password, the test card, the mirror host, the build commit, the Recovery-dev note and the Studio
 * license note. Nothing in this disclosure is repeated elsewhere on the screen.
 */
function ManualSandboxDetails() {
  return (
    <details
      className="group rounded-xl border border-slate-800 bg-slate-900/50"
      data-testid="demo-manual-details"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-slate-200 after:ml-3 after:text-lg after:leading-none after:text-emerald-300 after:content-['+'] group-open:after:content-['–'] [&::-webkit-details-marker]:hidden">
        <span>Manual sign-in and sandbox details</span>
      </summary>
      <dl className="space-y-4 border-t border-slate-800 px-4 py-4 text-sm text-slate-300">
        <div>
          <dt className="font-semibold text-white">Demo password</dt>
          <dd className="mt-1 leading-relaxed">
            All three seats use <code className="text-slate-100">{DEMO_PASSWORD}</code>. Use a separate browser context per role.
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-white">Test card</dt>
          <dd className="mt-1 leading-relaxed">
            Choose United States and pay as guest. Card <code className="text-slate-100">4032031427005060</code>, expiry{" "}
            <code className="text-slate-100">01/29</code>, CVV <code className="text-slate-100">480</code>. Use synthetic
            details: Sandbox Buyer, 123 Test Street, San Jose, CA 95131, 2025550100, and a unique{" "}
            <code className="text-slate-100">@example.com</code> email.
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-white">Mirror URL</dt>
          <dd className="mt-1 break-all leading-relaxed">
            <a
              href="https://cheery-axolotl-689.convex.site/#/demo"
              className="text-emerald-300 underline underline-offset-2"
            >
              cheery-axolotl-689.convex.site/#/demo
            </a>{" "}
            — both addresses serve the same build. Backend, health checks and webhooks stay on the .convex.site deployment.
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-white">Commit hash</dt>
          <dd className="mt-1"><BuildStamp /></dd>
        </div>
        <div>
          <dt className="font-semibold text-white">Recovery-dev</dt>
          <dd className="mt-1 leading-relaxed">
            Recovery-dev email signup needs an allowlisted test inbox. For immediate judge access, use the three
            seats above instead of your personal email.
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-white">Studio license</dt>
          <dd className="mt-1 leading-relaxed">
            AgentID needs owner-approved OAuth setup in this demo. The ordinary dashboard works without a Studio
            license; its optional layout editor needs a valid license.
          </dd>
        </div>
      </dl>
    </details>
  );
}
