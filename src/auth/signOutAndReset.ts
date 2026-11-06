import { useAuthActions } from "@convex-dev/auth/react";
import { useCallback } from "react";
import { clearAllQuickStartProgress } from "../projects/gc/quickStartProgress";

export const SELECTION_STORAGE_KEYS = ["tradepulse.selectedProjectId", "tradepulse.selectedPackageId"] as const;

/**
 * Drops the previous user's route (hash, `?project`, `?tab`), remembered selections and any saved
 * Quick start draft, so whoever signs in next lands on their own home and never resumes someone
 * else's half-created job.
 */
export function resetRouteState(win: Pick<Window, "history" | "location" | "localStorage"> = window): void {
  try {
    win.history.replaceState(null, "", win.location.pathname);
  } catch {
    // URL reset is best-effort in restricted browser contexts.
  }
  for (const key of SELECTION_STORAGE_KEYS) {
    try {
      win.localStorage.removeItem(key);
    } catch {
      // Storage can be unavailable in restricted browser contexts.
    }
  }
  try {
    clearAllQuickStartProgress({ storage: win.localStorage });
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

export function useSignOutAndReset(): () => Promise<void> {
  const { signOut } = useAuthActions();
  return useCallback(async () => {
    resetRouteState();
    await signOut();
  }, [signOut]);
}
