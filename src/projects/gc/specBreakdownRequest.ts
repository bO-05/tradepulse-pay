const PENDING_KEY = "tradepulse.pendingSpecBreakdown";

/**
 * Opens the procurement workspace on the project's trade packages with the AI spec breakdown dialog.
 * The dialog lives in that workspace, so this leaves a one-shot flag it consumes on mount.
 */
export function openSpecBreakdown(projectId: string): void {
  try {
    window.sessionStorage.setItem(PENDING_KEY, projectId);
  } catch {
    // Without storage the user still lands on the packages tab, which has the AI button.
  }
  openProcurementPackages(projectId);
}

/** The procurement workspace's trade packages tab for one project. */
export function openProcurementPackages(projectId: string): void {
  const params = new URLSearchParams({ project: projectId, tab: "packages" });
  window.history.pushState(null, "", `${window.location.pathname}?${params.toString()}#/procurement`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** True once when the AI spec breakdown was requested for this project. */
export function consumeSpecBreakdownRequest(projectId: string | undefined): boolean {
  if (!projectId) return false;
  try {
    const pending = window.sessionStorage.getItem(PENDING_KEY);
    if (pending !== projectId) return false;
    window.sessionStorage.removeItem(PENDING_KEY);
    return true;
  } catch {
    return false;
  }
}
