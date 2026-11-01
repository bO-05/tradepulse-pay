/** Only a completed, unrefunded capture proves collected funds. Keep this helper safe for client imports. */
export function isCaptureCollected(status: string): boolean {
  return status === "COMPLETED";
}
