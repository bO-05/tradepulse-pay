export const CSLB_SEARCH_URL = "https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx";

export type CslbStatus = "active" | "expired" | "suspended" | "inactive" | "not_found" | "unverified";
export type LicenseStatus = CslbStatus;

/** Pause before and after the lookup so the embedded live view has time to connect and show the result. */
export const VIEWER_PAUSE_MS = 2500;

export const LICENSE_CACHE_MS = 24 * 60 * 60 * 1000;
/** A running row older than this is treated as abandoned (the action has a hard stop well below it). */
export const RUNNING_STALE_MS = 3 * 60 * 1000;

/** Statuses that come from a CSLB page and are safe to reuse for 24 hours. Failures are never cached. */
export const CACHEABLE_STATUSES: ReadonlySet<CslbStatus> = new Set(["active", "expired", "suspended", "inactive", "not_found"]);

export const STATUS_LABEL: Record<CslbStatus, string> = {
  active: "Active",
  expired: "Expired",
  suspended: "Suspended",
  inactive: "Inactive",
  not_found: "Not found",
  unverified: "Unverified",
};

export function normalizeLicenseNumber(raw: string): string {
  return raw.trim().replace(/\s+/g, "");
}

/**
 * Playwright code run inside the KERNEL browser. Detail pages (found or
 * "does not exist") load LicenseDetail.aspx; a non-numeric entry stays on the
 * search form with a validation message, so both are awaited.
 */
export function buildCslbScript(licenseNumber: string, viewerPauseMs = VIEWER_PAUSE_MS): string {
  const lic = JSON.stringify(licenseNumber);
  const pause = Math.max(0, Math.round(viewerPauseMs));
  return `await page.waitForTimeout(${pause});
for (let attempt = 0; ; attempt++) {
  try { await page.goto(${JSON.stringify(CSLB_SEARCH_URL)}, { waitUntil: "domcontentloaded", timeout: 25000 }); break; }
  catch (e) { if (attempt >= 1) throw e; }
}
await page.fill("#MainContent_LicNo", ${lic});
await page.click("#MainContent_Contractor_License_Number_Search");
await Promise.race([
  page.waitForURL(/LicenseDetail/, { timeout: 30000 }),
  page.waitForFunction(() => /Please enter a valid number/i.test(document.body.innerText), null, { timeout: 30000 }),
]).catch(() => {});
await page.waitForLoadState("domcontentloaded").catch(() => {});
await page.waitForTimeout(${pause});
return { url: page.url(), text: await page.innerText("body") };`;
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
}

const SECTION_HEADERS = new Set([
  "Business Information",
  "License Status",
  "Additional Status",
  "Classifications",
  "Bonding Information",
  "Workers' Compensation",
  "Workers’ Compensation",
]);

function section(all: string[], header: string): string[] {
  const start = all.indexOf(header);
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < all.length; i++) {
    if (SECTION_HEADERS.has(all[i])) break;
    out.push(all[i]);
  }
  return out;
}

function field(all: string[], name: string): string | undefined {
  const line = all.find((l) => l.startsWith(`${name} `));
  return line?.slice(name.length).trim() || undefined;
}

export type CslbParse = { status: CslbStatus; rawSummary: string };

/** Maps the CSLB page text to a status. Anything not recognised is "unverified", never active. */
export function parseCslbPage(page: { url: string; text: string }, licenseNumber: string): CslbParse {
  const all = lines(page.text ?? "");
  const joined = all.join("\n");
  if (/License Number does not exist/i.test(joined)) {
    return { status: "not_found", rawSummary: `CSLB license #${licenseNumber}: License Number does not exist.` };
  }
  if (!/LicenseDetail/i.test(page.url) && /Please enter a valid number/i.test(joined)) {
    return {
      status: "not_found",
      rawSummary: `CSLB license #${licenseNumber}: CSLB rejected the entry ("Please enter a valid number"); California license numbers are digits only, so no CA record exists for it.`,
    };
  }
  const statusLines = section(all, "License Status");
  if (!/LicenseDetail/i.test(page.url) || statusLines.length === 0) {
    return { status: "unverified", rawSummary: `CSLB license #${licenseNumber}: the CSLB detail page could not be read.` };
  }
  const statusText = statusLines.join(" ");
  let status: CslbStatus;
  if (/suspen|revoked/i.test(statusText)) status = "suspended";
  else if (/\bexpired\b/i.test(statusText)) status = "expired";
  else if (/\binactive\b/i.test(statusText)) status = "inactive";
  else if (/current and active/i.test(statusText)) status = "active";
  else status = "unverified";

  const business = section(all, "Business Information");
  const name = business[0] ?? "Unknown business";
  const cityLine = business.find((l) => /, [A-Z]{2} \d{5}/.test(l));
  const classifications = section(all, "Classifications").filter((l) => /^[A-Z]/.test(l)).slice(0, 6);
  const parts = [
    `CSLB license #${licenseNumber}: ${name}${cityLine ? `, ${cityLine}` : ""}.`,
    field(all, "Entity") ? `Entity: ${field(all, "Entity")}.` : "",
    field(all, "Issue Date") ? `Issued ${field(all, "Issue Date")}.` : "",
    field(all, "Expire Date") ? `Expires ${field(all, "Expire Date")}.` : "",
    `License Status: ${statusText}`,
    classifications.length > 0 ? `Classifications: ${classifications.join("; ")}.` : "",
  ];
  const rawSummary = parts.filter(Boolean).join(" ").slice(0, 1500);
  return { status, rawSummary };
}

/** Secret-free reason for a failed lookup. Never includes the API key or response bodies. */
export function describeKernelFailure(error: unknown, secret?: string): string {
  const e = error as { status?: unknown; name?: unknown; message?: unknown } | null;
  const status = typeof e?.status === "number" ? e.status : undefined;
  let reason: string;
  if (status === 401 || status === 403) reason = `KERNEL rejected the API key (HTTP ${status}).`;
  else if (status === 429) reason = "KERNEL rate limit reached (HTTP 429).";
  else if (status !== undefined) reason = `KERNEL API error (HTTP ${status}).`;
  else if (e?.name === "LicenseCheckTimeout") reason = String(e.message);
  else if (/timeout|timed out/i.test(String(e?.message ?? ""))) reason = "KERNEL request timed out.";
  else reason = `KERNEL request failed (${typeof e?.name === "string" ? e.name : "error"}).`;
  return scrub(reason, secret);
}

export function scrub(text: string, secret?: string): string {
  let out = text;
  if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
  return out.replace(/sk_[A-Za-z0-9_-]{8,}/g, "[redacted]");
}
