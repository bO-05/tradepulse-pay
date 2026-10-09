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
export function rfqPortalLink(siteUrl: string | undefined): string {
  return `${(siteUrl?.trim() || "http://localhost:3150").replace(/\/$/, "")}/#/portal`;
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
}

export function rfqSubject(input: Pick<RfqEmailInput, "gcName" | "projectTitle" | "csiDivision" | "tradeName" | "ref">): string {
  return `Invitation to bid: ${input.csiDivision} ${input.tradeName} - ${input.projectTitle} (${input.gcName}) [TP-${input.ref}]`;
}

export function buildRfqEmail(input: RfqEmailInput): { subject: string; text: string; html: string; portalLink: string } {
  const portalLink = rfqPortalLink(input.siteUrl);
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
    `- Or, if your company has a TradePulse Pay account, open the bid portal: ${portalLink}`,
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
};

/** Web discovery stores this when a page publishes no address. */
export function isUnpublishedPlaceholder(email: string): boolean {
  return /@verify-required\.invalid$/i.test(email.trim());
}

/** Rows from before `emailSource` existed are recognised by the license text web discovery writes. */
const LEGACY_DISCOVERY_LICENSE = /from web search result|Verified in listing \(registry page\)/i;

/** True when the address came from web discovery and no GC member has confirmed or edited it. */
export function emailNeedsConfirmation(c: ContractorEmailFields): boolean {
  if (c.emailConfirmedAt !== undefined) return false;
  if (c.emailSource === "web_discovery") return true;
  return c.emailSource === undefined && LEGACY_DISCOVERY_LICENSE.test(c.licenseStatus);
}

export type RfqRecipientState = "ready" | "already_sent" | "no_email" | "email_unconfirmed" | "blocked_recipient";

export function rfqRecipientState(
  c: ContractorEmailFields & { rfqEmailStatus?: string; rfqEmailTo?: string },
  allowed: (email: string) => boolean,
): RfqRecipientState {
  const email = c.contactEmail.trim().toLowerCase();
  if (!email.includes("@") || isUnpublishedPlaceholder(email)) return "no_email";
  if (emailNeedsConfirmation(c)) return "email_unconfirmed";
  if (!allowed(email)) return "blocked_recipient";
  if ((c.rfqEmailStatus === "sent" || c.rfqEmailStatus === "replied") && c.rfqEmailTo === email) return "already_sent";
  return "ready";
}
