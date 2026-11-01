import type { Doc } from "../_generated/dataModel";

type Searchable = Pick<Doc<"vendors">, "name" | "email" | "trades" | "contactName">;

/**
 * Text for the vendors `search_text` index. Emails are also split at "@" and "." so that searching
 * a domain or the local part finds the vendor. Trades are indexed as one token ("260000"), since the
 * words of "26 00 00" would match every division ending in "00".
 */
export function vendorSearchText(v: Searchable): string {
  const email = v.email.trim().toLowerCase();
  const trades = v.trades.map((t) => t.replace(/\s+/g, ""));
  return [v.name, v.contactName, email, email.replace(/[@.]/g, " "), ...trades].join(" ").replace(/\s+/g, " ").trim();
}

/** A directory search as typed, with CSI divisions ("26 00 00") joined like the index ("260000"). */
export function vendorSearchQuery(raw: string): string {
  return raw
    .trim()
    .slice(0, 200)
    .replace(/\b(\d{2})\s+(\d{2})(?:\s+(\d{2}))?\b/g, (_m, a: string, b: string, c?: string) => `${a}${b}${c ?? ""}`);
}

/** `searchText` for a patch that changes searchable fields of an existing vendor. */
export function searchTextPatch(vendor: Doc<"vendors">, patch: Partial<Searchable>): { searchText: string } {
  return { searchText: vendorSearchText({ ...vendor, ...patch }) };
}
