import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import type { ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import { RoleShell } from "./RoleShell";
import { SignInPage } from "./SignInPage";

function FullScreenStatus({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center font-sans" role="status">
      {children}
    </div>
  );
}

/** Nothing but the sign-in page renders until Convex Auth confirms a session. */
export function AuthGate({ procurementApp }: { procurementApp: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useQuery(api.profiles.me, isAuthenticated ? {} : "skip");
  const { signOut } = useAuthActions();

  if (isLoading) {
    return <FullScreenStatus>Checking your session…</FullScreenStatus>;
  }
  if (!isAuthenticated) {
    return <SignInPage />;
  }
  if (me === undefined) {
    return <FullScreenStatus>Loading your workspace…</FullScreenStatus>;
  }
  if (me === null || me.role === null) {
    return (
      <FullScreenStatus>
        <div className="max-w-md text-center space-y-3 px-4">
          <h1 className="text-lg font-semibold">No access yet</h1>
          <p className="text-sm text-slate-400">
            {me?.email ?? "This account"} is signed in but has no TradePulse role. Ask your general contractor to grant
            access.
          </p>
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
          >
            Sign out
          </button>
        </div>
      </FullScreenStatus>
    );
  }
  return <RoleShell me={{ ...me, role: me.role }} procurementApp={procurementApp} />;
}
