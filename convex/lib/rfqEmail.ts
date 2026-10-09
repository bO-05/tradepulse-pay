/**
 * RFQ email content and recipient rules. Pure helpers shared by the send action, the recipient preview
 * and tests; the RFQ itself is sent only through convex/lib/mailer.ts.
 */
import { escapeHtml } from "./mailer";

const PACIFIC = { iana: "America/Los_Angeles", label: "Pacific Time (PT)" };
const MOUNTAIN = { iana: "America/Denver", label: "Mountain Time (MT)" };
const ARIZONA = { iana: "America/Phoenix", label: "Arizona Time (MST)" };
const CENTRAL = { iana: "America/Chicago", label: "Central Time (CT)" };
const EASTERN = { iana: "America/New_York", label: "Eastern Time (ET)" };
const ALASKA = { iana: "America/Anchorage", label: "Alaska Time (AKT)" };
const HAWAII = { iana: "Pacific/Honolulu", label: "Hawaii Time (HT)" };

const ZONE_BY_STATE: Record<string, { iana: string; label: string }> = {
  CA: PACIFIC, NV: PACIFIC, OR: PACIFIC, WA: PACIFIC,
  AZ: ARIZONA,
  CO: MOUNTAIN, ID: MOUNTAIN, MT: MOUNTAIN, NM: MOUNTAIN, UT: MOUNTAIN, WY: MOUNTAIN,
  AL: CENTRAL, AR: CENTRAL, IA: CENTRAL, IL: CENTRAL, KS: CENTRAL, LA: CENTRAL, MN: CENTRAL, MO: CENTRAL,
  MS: CENTRAL, ND: CENTRAL, NE: CENTRAL, OK: CENTRAL, SD: CENTRAL, TN: CENTRAL, TX: CENTRAL, WI: CENTRAL,
  AK: ALASKA, HI: HAWAII,
};

/** The project's time zone from its 2-letter state; unknown states fall back to Eastern. */
export function timeZoneForState(state: string | undefined): { iana: string; label: string } {
  return ZONE_BY_STATE[(state ?? "").trim().toUpperCase()] ?? EASTERN;
}

/** "Oct 30, 2026, 2:00 PM Pacific Time (PT)"; a date-only deadline reads "Oct 30, 2026, end of day Pacific Time (PT)". */
export function formatBidDue(bidDeadline: string, state: string | undefined): string {
  const zone = timeZoneForState(state);
  const raw = bidDeadline.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(raw);
  if (!m) return raw ? `${raw} (${zone.label})` : `not set (${zone.label})`;
  const [, y, mo, d, hh, mm] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), 12));
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  if (hh === undefined) return `${day}, end of day ${zone.label}`;
  const hour = Number(hh);
  const time = `${hour % 12 === 0 ? 12 : hour % 12}:${mm} ${hour < 12 ? "AM" : "PM"}`;
  return `${day}, ${time} ${zone.label}`;
}

/** Where a bidder with a TradePulse Pay account views the invitation and submits a bid. */
export function rfqPortalLink(siteUrl: string | undefined, tradePackageId?: string): string {
  const base = `${(siteUrl?.trim() || "http://localhost:3150").replace(/\/$/, "")}/#/bids`;
  return tradePackageId ? `${base}/${encodeURIComponent(tradePackageId)}` : base;
}

export interface RfqEmailInput {
  gcName: string;
  projectTitle: string;
  projectLocation?: string;
  projectState?: string;
  csiDivision: string;
  tradeName: string;
  scopeSummary?: string;
  mandatoryInclusions: string[];
  bidDeadline: string;
  bidderName: string;
  ref: string;
  siteUrl?: string;
  tradePackageId?: string;
}

export function rfqSubject(input: Pick<RfqEmailInput, "gcName" | "projectTitle" | "csiDivision" | "tradeName" | "ref">): string {
  return `Invitation to bid: ${input.csiDivision} ${input.tradeName} - ${input.projectTitle} (${input.gcName}) [TP-${input.ref}]`;
}

export function buildRfqEmail(input: RfqEmailInput): { subject: string; text: string; html: string; portalLink: string } {
  const portalLink = rfqPortalLink(input.siteUrl, input.tradePackageId);
  const due = formatBidDue(input.bidDeadline, input.projectState);
  const where = input.projectLocation?.trim() ? ` in ${input.projectLocation.trim()}` : "";
  const inclusions = input.mandatoryInclusions.filter((s) => s.trim());
  const lines = [
    `Dear ${input.bidderName} estimating team,`,
    "",
    `${input.gcName} invites you to submit a proposal for ${input.csiDivision} ${input.tradeName} on ${input.projectTitle}${where}.`,
    "",
    ...(input.scopeSummary?.trim() ? [`Scope: ${input.scopeSummary.trim()}`, ""] : []),
    ...(inclusions.length > 0 ? ["Required inclusions:", ...inclusions.map((inc) => `- ${inc}`), ""] : []),
    `Bids are due ${due}.`,
    "",
    "How to bid:",
    `- Reply to this email with your proposal or pre-bid questions. Keep the reference [TP-${input.ref}] in the subject.`,
    `- Or, if ${input.gcName} has invited your company to this project in TradePulse Pay, open the bid portal: ${portalLink}`,
    "",
    `${input.gcName}`,
    "Sent with TradePulse Pay",
  ];
  const text = lines.join("\n");
  const paragraphs = escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;line-height:1.5"><p style="margin:0 0 16px;font-weight:bold;font-size:16px">${escapeHtml(input.gcName)}</p>${paragraphs}</div>`;
  return { subject: rfqSubject(input), text, html, portalLink };
}

/** Contractor stages an RFQ email outcome may overwrite; later bid stages are never rolled back. */
export const RFQ_PRE_REPLY_STATUSES = new Set(["discovered", "invited", "sent", "failed", "skipped_budget", "blocked_recipient", "bounced", "not_sent"]);

type ContractorEmailFields = {
  contactEmail: string;
  licenseStatus: string;
  emailSource?: "web_discovery" | "gc" | "directory" | "document";
  emailConfirmedAt?: number;
  emailConfirmedFor?: string;
};

type VendorEmailFields = {
  email: string;
  discoveredEmail?: string;
  emailConfirmedAt?: number;
  emailConfirmedFor?: string;
};

const normalized = (email: string) => email.trim().toLowerCase();

/**
 * True only when a GC member typed, edited or confirmed this bidder's current address.
 * `emailConfirmedFor` names the exact address; rows written before it existed count only when they
 * carry a GC confirmation or were GC-typed, because every write that changes the address of such a
 * row also records a fresh confirmation.
 */
export function bidderAddressConfirmed(c: ContractorEmailFields): boolean {
  const email = normalized(c.contactEmail);
  if (c.emailConfirmedFor !== undefined) return normalized(c.emailConfirmedFor) === email;
  return c.emailConfirmedAt !== undefined || c.emailSource === "gc";
}

/** True only when the directory entry's current email is `address` and a GC member entered or confirmed it. */
export function vendorAddressConfirmed(vendor: VendorEmailFields, address: string): boolean {
  const email = normalized(address);
  if (normalized(vendor.email) !== email) return false;
  if (vendor.discoveredEmail !== undefined && normalized(vendor.discoveredEmail) === email) return false;
  if (vendor.emailConfirmedFor !== undefined) return normalized(vendor.emailConfirmedFor) === email;
  return vendor.emailConfirmedAt !== undefined;
}

/** Fields recording that a GC member entered or confirmed `email` just now. */
export function gcConfirmedEmail(email: string, now = Date.now()): { emailConfirmedAt: number; emailConfirmedFor: string } {
  return { emailConfirmedAt: now, emailConfirmedFor: normalized(email) };
}

/** Web discovery stores this when a page publishes no address. */
export function isUnpublishedPlaceholder(email: string): boolean {
  return /@verify-required\.invalid$/i.test(email.trim());
}

/** Rows from before `emailSource` existed are recognised by the license text web discovery writes. */
const LEGACY_DISCOVERY_LICENSE = /from web search result|Verified in listing \(registry page\)/i;

/**
 * True when the address is known to come from web discovery and no GC member has confirmed or
 * edited it. Real companies use the stricter bidderAddressConfirmed rule; this one remains for the
 * Demo company, whose seeded bidders carry no confirmation and are never emailed.
 */
export function emailNeedsConfirmation(c: ContractorEmailFields): boolean {
  if (c.emailConfirmedAt !== undefined) return false;
  if (c.emailSource === "web_discovery") return true;
  return c.emailSource === undefined && LEGACY_DISCOVERY_LICENSE.test(c.licenseStatus);
}

export type RfqRecipientState = "ready" | "already_sent" | "no_email" | "email_unconfirmed" | "blocked_recipient";

/** `addressConfirmed`: a GC confirmation exists for this exact address (see lib/vendorDirectory.ts rfqAddressConfirmed). */
export function rfqRecipientState(
  c: ContractorEmailFields & { rfqEmailStatus?: string; rfqEmailTo?: string },
  allowed: (email: string) => boolean,
  addressConfirmed: boolean,
): RfqRecipientState {
  const email = c.contactEmail.trim().toLowerCase();
  if (!email.includes("@") || isUnpublishedPlaceholder(email)) return "no_email";
  if (!addressConfirmed) return "email_unconfirmed";
  if (!allowed(email)) return "blocked_recipient";
  if ((c.rfqEmailStatus === "sent" || c.rfqEmailStatus === "replied") && c.rfqEmailTo === email) return "already_sent";
  return "ready";
}
