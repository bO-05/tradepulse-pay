import { useAuthActions } from "@convex-dev/auth/react";
import { useState } from "react";

/** Official AgentID mark, served unmodified from public/ (see public/brand/agentid/SOURCE.md). */
export const AGENTID_MARK_SRC = "/brand/agentid/icon-white.svg";

export function AgentIdButton() {
  const { signIn } = useAuthActions();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      // Convex Auth redirects the window to AgentID; the promise only settles on failure.
      await signIn("agentid");
    } catch {
      setError("Could not start AgentID sign-in. Try again.");
      setPending(false);
    }
  };

  return (
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
  );
}
