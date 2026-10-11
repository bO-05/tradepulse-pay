import { useAuthActions } from "@convex-dev/auth/react";
import { useCallback } from "react";

export const SELECTION_STORAGE_KEYS = ["tradepulse.selectedProjectId", "tradepulse.selectedPackageId"] as const;

/**
 * Drops the previous user's route (hash, `?project`, `?tab`) and remembered selections, so whoever
 * signs in next lands on their own home instead of a page their role cannot open.
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
}

export function useSignOutAndReset(): () => Promise<void> {
  const { signOut } = useAuthActions();
  return useCallback(async () => {
    resetRouteState();
    await signOut();
  }, [signOut]);
}
