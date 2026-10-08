/**
 * Invite rules shared by convex/invites.ts and the UI. Pure TS (Web Crypto only), no Convex imports.
 * The plaintext token exists only in the link; the database keeps its sha256 hex.
 */

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type InviteKind = "teammate" | "sub" | "owner";
export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";
export type InviteEmailStatus = "sent" | "failed" | "skipped_budget" | "not_sent";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 256 random bits, base64url (43 characters). */
export function newInviteToken(): string {
  const bytes = new Uint8Array(INVITE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export function isWellFormedInviteToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function inviteLink(siteUrl: string, token: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/#/invite/${token}`;
}

const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Lowercased, trimmed address, or null when it is not a usable email. */
export function normalizeInviteEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

export const INVALID_EMAIL_MESSAGE = "Enter a valid email address, like name@company.com.";

/** "t***@maxxspace.com" */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

/** The status a reader should see: a pending invite past its expiry reads as expired. */
export function effectiveInviteStatus(invite: { status: InviteStatus; expiresAt: number }, now: number): InviteStatus {
  if (invite.status === "pending" && invite.expiresAt <= now) return "expired";
  return invite.status;
}

/** Plain-words status for People and Company settings lists. Never a raw code. */
export function inviteStatusLabel(
  invite: { status: InviteStatus; expiresAt: number; emailStatus: InviteEmailStatus },
  now: number,
): string {
  const status = effectiveInviteStatus(invite, now);
  if (status === "accepted") return "Accepted";
  if (status === "revoked") return "Revoked";
  if (status === "expired") return "Expired";
  switch (invite.emailStatus) {
    case "sent":
      return "Pending · Email sent";
    case "skipped_budget":
      return "Pending · Not emailed (daily limit)";
    case "failed":
      return "Pending · Email failed";
    default:
      return "Pending · Not emailed";
  }
}

/** What the create/resend dialog says about the email right after the call. */
export function inviteEmailOutcome(emailStatus: InviteEmailStatus, error?: string | null): { tone: "success" | "info" | "warning" | "danger"; text: string } {
  switch (emailStatus) {
    case "sent":
      return { tone: "success", text: "Email sent" };
    case "skipped_budget":
      return { tone: "warning", text: "Email limit reached for today — copy the invite link instead" };
    case "failed":
      return { tone: "danger", text: `Email failed — copy the link or resend${error ? ` (${error})` : ""}` };
    default:
      return { tone: "info", text: "Not emailed — share the link" };
  }
}

export const INVITE_KIND_LABEL: Record<InviteKind, string> = {
  teammate: "Teammate",
  sub: "Subcontractor",
  owner: "Owner",
};

const CSI_DIVISIONS: Record<string, string> = {
  "01": "General Requirements",
  "02": "Existing Conditions",
  "03": "Concrete",
  "04": "Masonry",
  "05": "Metals",
  "06": "Wood & Plastics",
  "07": "Thermal & Moisture",
  "08": "Openings",
  "09": "Finishes",
  "10": "Specialties",
  "11": "Equipment",
  "12": "Furnishings",
  "13": "Special Construction",
  "14": "Conveying Equipment",
  "21": "Fire Suppression",
  "22": "Plumbing",
  "23": "HVAC",
  "25": "Integrated Automation",
  "26": "Electrical",
  "27": "Communications",
  "28": "Electronic Safety & Security",
  "31": "Earthwork",
  "32": "Exterior Improvements",
  "33": "Utilities",
};

// Keys like "10" are integer-like, so object order would list them before "01"; sort explicitly.
export const CSI_DIVISION_OPTIONS = Object.entries(CSI_DIVISIONS)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([code, name]) => ({
    value: `${code} 00 00`,
    label: `${code} 00 00 · ${name}`,
  }));

/** "26 00 00" -> "Electrical"; unknown codes are returned as given. */
export function tradeName(csi: string): string {
  const code = csi.trim().slice(0, 2);
  return CSI_DIVISIONS[code] ?? csi.trim();
}

export const COMPANY_KIND_LABEL: Record<"gc" | "sub" | "owner", string> = {
  gc: "General contractor",
  sub: "Subcontractor",
  owner: "Owner",
};
