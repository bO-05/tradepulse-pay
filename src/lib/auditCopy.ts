/**
 * Reader-facing words for audit and activity rows.
 *
 * Audit rows are an internal trail: some historical rows carry deployment env var names, vendor
 * record ids or the name of the automation that wrote them. A signed-in GC, sub or owner never needs
 * those identifiers, so they are replaced before display. The rows themselves are not rewritten.
 */
import { demoDisplayName } from "./demoCopy";
import { maskSandboxEmail } from "./demoPrivacy";

const INTERNAL_ACTORS: Record<string, string> = {
  "Convex Automated Cron Engine": "TradePulse automation",
  "Convex Compliance Auditor Cron": "Compliance check",
  "KERNEL hosted browser": "Licence registry lookup",
  "system:demo-seed": "Demo setup",
  "TradePulse Pay (demo seed)": "Demo setup",
  "Procurement scenario fixture": "Sample procurement setup",
};

const CRON_NAMES: Record<string, string> = {
  "monitor-bid-deadlines": "Bid deadline check",
  "audit-contractor-compliance": "Contractor compliance check",
  "compliance-expiry-notifications": "Insurance and licence expiry reminders",
};

const CRON_DESCRIPTIONS: Record<string, string> = {
  "monitor-bid-deadlines": "Checks package bid deadlines and moves a package to leveling when it closes.",
  "audit-contractor-compliance": "Checks recorded contractor licence statuses and insurance flags. It does not call a registry.",
  "compliance-expiry-notifications": "Reminds subs and their GC when an insurance certificate or licence expires within 30 days.",
};

/** Old audit rows stored the seeded demo account names, including the company that used to sit in parentheses. */
const DEMO_ACTORS: readonly [RegExp, string][] = [
  [/^Demo Sub 1\b/i, "Rosendin Electric, Inc."],
  [/^Demo Sub 2\b/i, "TDIndustries, Inc."],
  [/^Demo Sub 3\b/i, "Clarke Kent Plumbing"],
  [/^Demo Sub 4\b/i, "Ortiz Plumbing"],
  [/^Demo GC\b/i, "Demo GC"],
  [/^Demo Owner\b/i, "Demo Owner"],
];

const DEMO_SEAT_ACTORS: Record<string, string> = {
  "gc@demo.tradepulse": "Demo GC",
  "sub1@demo.tradepulse": "Rosendin Electric, Inc.",
  "sub2@demo.tradepulse": "TDIndustries, Inc.",
  "sub3@demo.tradepulse": "Clarke Kent Plumbing",
  "sub4@demo.tradepulse": "Ortiz Plumbing",
  "owner@demo.tradepulse": "Demo Owner",
};

/** A human actor label: internal automation and old demo account names become plain language. */
export function auditActorLabel(actor: string | null | undefined): string {
  if (!actor) return "TradePulse";
  const internal = INTERNAL_ACTORS[actor];
  if (internal) return internal;
  const seat = DEMO_SEAT_ACTORS[actor.trim().toLowerCase()];
  if (seat) return seat;
  for (const [pattern, name] of DEMO_ACTORS) if (pattern.test(actor)) return name;
  const email = actor.includes("@") ? maskSandboxEmail(actor) : null;
  if (email) return email;
  return demoDisplayName(auditText(actor));
}

/** A human cron label and description; unknown names are left alone. */
export function auditCronLabel(name: string): { name: string; description: string | null } {
  return { name: CRON_NAMES[name] ?? name, description: CRON_DESCRIPTIONS[name] ?? null };
}

/** Environment names, record ids, vendor names and platform words removed from reader-facing text. */
export function auditText(value: string): string {
  let out = value;
  // Environment variable names (PAYPAL_SANDBOX_SUB4_EMAIL, CONVEX_SITE_URL, ...).
  out = out.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b/g, "the configured setting");
  // Convex document ids are 32 lowercase alphanumerics; they mean nothing to a reader.
  out = out.replace(/\b[a-z][a-z0-9]{31}\b/g, "the record on file");
  // Sandbox and example addresses are masked wherever they appear.
  out = out.replace(/[\w.+-]+@[\w.-]*example\.com/gi, (email) => maskSandboxEmail(email) ?? "a masked address");
  out = out.replace(/\bConvex Automated Cron Engine\b/g, "TradePulse automation");
  out = out.replace(/\bConvex Compliance Auditor Cron\b/g, "Compliance check");
  out = out.replace(/\bKERNEL hosted browser\b/g, "a licence registry lookup");
  out = out.replace(/\bConvex\b/g, "TradePulse");
  out = out.replace(/\.convex\.site\b/gi, "the hosted file service");
  out = out.replace(/\bJudge demo\s*·\s*/gi, "");
  out = out.replace(/\bjudge demo\b/gi, "sandbox run");
  // Historical rows written before the demo copy sweep.
  out = out.replace(/Demo pay-app review scenario seeded/gi, "Pay-app review scenario prepared");
  out = out.replace(/\bdemo agreement with excluded\b/gi, "sample agreement with excluded");
  out = out.replace(/The demo seed added/gi, "Setup added");
  out = out.replace(/Demo compliance records seeded/gi, "Example compliance records added");
  out = out.replace(/\bdemo compliance record(s?)\b/gi, "example compliance record$1");
  out = out.replace(/\bDemo sub companies\b/gi, "shared sandbox companies");
  out = out.replace(/\(filed by the guided demo for [^)]+\)/gi, "(filed in the guided demo for the linked billing agent)");
  out = out.replace(/\bCron Audit: Recorded License Status & ACORD 25 Sweep - /gi, "Licence and insurance check - ");
  // Old rows captured the seeded account label, including the company in parentheses.
  out = out.replace(/\bDemo Sub 1 \([^)]*\)/gi, "Rosendin Electric, Inc.");
  out = out.replace(/\bDemo Sub 2 \([^)]*\)/gi, "TDIndustries, Inc.");
  out = out.replace(/\bDemo Sub 3 \([^)]*\)/gi, "Clarke Kent Plumbing");
  out = out.replace(/\bDemo Sub 4 \([^)]*\)/gi, "Ortiz Plumbing");
  out = out.replace(/\bDemo GC \([^)]*\)/gi, "Demo GC");
  out = out.replace(/\bDemo Owner \([^)]*\)/gi, "Demo Owner");
  out = out.replace(/\bDemo Ortiz Plumbing\b/gi, "Ortiz Plumbing");
  out = out.replace(/\bDemo (Rosendin Electric|TDIndustries|Clarke Kent Plumbing)\b/gi, "$1");
  out = out.replace(/\bdemo seed\b/gi, "demo setup");
  out = out.replace(/\s*\((?:demo|seed)\)/gi, "");
  out = out.replace(/\s{2,}/g, " ");
  return out.trim();
}
