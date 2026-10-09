const PENDING_KEY = "tradepulse.pendingNewProject";

/**
 * Asks the procurement workspace to open its "New project" dialog. The dialog's listener only exists
 * while that workspace is mounted, so callers on other screens leave a one-shot flag and navigate there.
 */
export function requestNewProject(procurementHash = "#/procurement"): void {
  try {
    window.sessionStorage.setItem(PENDING_KEY, "1");
  } catch {
    // Without storage the user still lands on Procurement, which has its own create button.
  }
  window.location.hash = procurementHash;
}

/** Reads and clears the flag set by requestNewProject. */
export function consumeNewProjectRequest(): boolean {
  try {
    const pending = window.sessionStorage.getItem(PENDING_KEY) === "1";
    window.sessionStorage.removeItem(PENDING_KEY);
    return pending;
  } catch {
    return false;
  }
}
