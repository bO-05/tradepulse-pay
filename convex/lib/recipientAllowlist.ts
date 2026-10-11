/**
 * Test-recipient allowlist for non-production deployments. Dev data contains real businesses' contact
 * addresses (web discovery, seed contractors), so outside production the mailer only emails test domains.
 *
 * EMAIL_RECIPIENT_ALLOWLIST: comma/space separated entries. `domain.com` matches that domain exactly,
 * `*.test` matches any domain ending in `.test`, `user@domain.com` matches one address.
 * Unset: production has no allowlist; every other deployment uses DEFAULT_RECIPIENT_ALLOWLIST.
 */

/** Production Convex deployments. Anything else (dev, previews, tests) is treated as non-production. */
export const PRODUCTION_DEPLOYMENTS = ["earnest-mongoose-745"];

export const DEFAULT_RECIPIENT_ALLOWLIST = [
  // mail.tm disposable inboxes in use (GET https://api.mail.tm/domains)
  "maxxspace.com",
  "agentmail.to",
  "*.test",
  "*.example",
  "example.com",
  // RFC 2606 reserved TLD: can never reach a real mailbox, used to exercise provider rejections.
  "*.invalid",
];

export const BLOCKED_RECIPIENT_MESSAGE =
  "Not sent: this test deployment only emails test addresses (mail.tm, agentmail.to, .test, .example, example.com). Change the email to a test address.";

export function isProductionDeployment(cloudUrl: string | undefined): boolean {
  if (!cloudUrl) return false;
  let host: string;
  try {
    host = new URL(cloudUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return PRODUCTION_DEPLOYMENTS.some((name) => host === `${name}.convex.cloud` || host.startsWith(`${name}.`));
}

function parseList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** The allowlist in force, or null when every recipient is allowed (production without an explicit list). */
export function recipientAllowlist(env: { allowlist?: string; cloudUrl?: string }): string[] | null {
  const raw = env.allowlist?.trim();
  if (raw) return parseList(raw);
  return isProductionDeployment(env.cloudUrl) ? null : DEFAULT_RECIPIENT_ALLOWLIST;
}

export function recipientMatches(address: string, list: string[]): boolean {
  const to = address.trim().toLowerCase();
  const at = to.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = to.slice(at + 1);
  return list.some((entry) => {
    if (entry.includes("@")) return entry === to;
    if (entry.startsWith("*.")) return domain.endsWith(entry.slice(1));
    return domain === entry;
  });
}

/** True when this deployment may email the address. */
export function recipientAllowed(
  address: string,
  env: { allowlist?: string; cloudUrl?: string } = {
    allowlist: process.env.EMAIL_RECIPIENT_ALLOWLIST,
    cloudUrl: process.env.CONVEX_CLOUD_URL,
  },
): boolean {
  const list = recipientAllowlist(env);
  return list === null || recipientMatches(address, list);
}
