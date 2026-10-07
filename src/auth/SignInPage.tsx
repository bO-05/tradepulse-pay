import { useAuthActions } from "@convex-dev/auth/react";
import { FormEvent, useState } from "react";
import { signInErrorMessage } from "./navigation";

export function SignInPage() {
  const { signIn } = useAuthActions();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await signIn("password", { email: email.trim().toLowerCase(), password, flow: "signIn" });
    } catch (err) {
      setError(signInErrorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4 font-sans">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-700 border border-emerald-400/30" />
          <div>
            <h1 className="text-lg font-bold tracking-tight">TradePulse Pay</h1>
            <p className="text-xs text-slate-400">Subcontract procurement and payments</p>
          </div>
        </div>
        <form
          onSubmit={onSubmit}
          aria-label="Sign in"
          className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-xl"
        >
          <h2 className="text-base font-semibold">Sign in</h2>
          <div className="space-y-1.5">
            <label htmlFor="signin-email" className="block text-xs font-medium text-slate-300">
              Email
            </label>
            <input
              id="signin-email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="signin-password" className="block text-xs font-medium text-slate-300">
              Password
            </label>
            <input
              id="signin-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-rose-300 bg-rose-950/60 border border-rose-800/70 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-sm font-semibold py-2"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="text-[11px] text-slate-500 mt-4 leading-relaxed">
          Demo environment. The demo accounts and their shared password are listed in the project README.
        </p>
      </div>
    </div>
  );
}
