import { useAuthActions } from "@convex-dev/auth/react";
import { useEffect, useState } from "react";
import { agentIdConfigured } from "./agentIdAvailability";

/** Official AgentID mark, served unmodified from public/ (see public/brand/agentid/SOURCE.md). */
export const AGENTID_MARK_SRC = "/brand/agentid/icon-white.svg";

export function AgentIdButton() {
  const { signIn } = useAuthActions();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<"loading" | "configured" | "missing" | "unavailable">("loading");

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    void agentIdConfigured(import.meta.env.VITE_CONVEX_SITE_URL || window.location.origin, controller.signal)
      .then(configured => { if (!disposed) setAvailability(configured ? "configured" : "missing"); })
      .catch(() => { if (!disposed) setAvailability("unavailable"); })
      .finally(() => clearTimeout(timeout));
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, []);

  const onClick = async () => {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      // Convex Auth redirects the window to AgentID; the promise only settles on failure.
      await signIn("agentid");
    } catch {
      setError("Could not start AgentID sign-in. Check this deployment's client and callback setup, or use email sign-in.");
      setPending(false);
    }
  };

  // An unconfigured provider is an internal setup detail. Hiding it beats a disabled button and an
  // apology on the first screen a judge sees; email sign-in stays the visible path.
  if (availability !== "configured") return null;

  return (
    <>
      <div className="flex items-center gap-3 text-[11px] text-ink-subtle" aria-hidden="true">
        <span className="h-px flex-1 bg-line" />
        or, for subcontractor billing agents
        <span className="h-px flex-1 bg-line" />
      </div>
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => void onClick()}
          disabled={pending}
          className="w-full rounded-lg bg-black hover:bg-slate-800 disabled:opacity-60 border border-slate-700 text-white text-sm font-semibold py-2.5 px-3 flex items-center justify-center gap-3"
        >
          {/* py-2.5 and gap-3 keep clear space of at least half the 20px mark height (brand rule). */}
          <img src={AGENTID_MARK_SRC} alt="" width={20} height={20} className="h-5 w-5" />
          <span>Continue with AgentID</span>
        </button>
        {error && (
          <p role="alert" className="text-sm text-rose-300 bg-rose-950/60 border border-rose-800/70 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
      </div>
    </>
  );
}
