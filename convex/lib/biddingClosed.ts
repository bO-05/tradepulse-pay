import type { Doc } from "../_generated/dataModel";

/**
 * Why bidding on a package is closed, or null while it is open. Every bid writer (portal, GC on
 * behalf, parsed email and quote file) checks this inside its own transaction.
 */
export function biddingClosedReason(
  pkg: Pick<Doc<"tradePackages">, "status">,
  project: Pick<Doc<"projects">, "status" | "archived"> | null,
): string | null {
  if (pkg.status === "awarded") return "Bidding on this package is closed: it has been awarded.";
  if (project && (project.status === "closed" || project.status === "archived" || project.archived === true)) {
    return "Bidding on this package is closed: the project is closed.";
  }
  return null;
}
