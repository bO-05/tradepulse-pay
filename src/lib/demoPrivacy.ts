/** Public shared demos never display a personal/operational inbox local part. */
export function demoEmail(email: string, isDemo: boolean): string {
  if (!isDemo || /@demo\.tradepulse$/i.test(email)) return email;
  const at = email.lastIndexOf("@");
  return at < 0 ? "Demo inbox" : `[demo inbox]${email.slice(at)}`;
}

/**
 * Sandbox and shared-demo addresses are synthetic. Mask their local part wherever a screen or a
 * screenshot would otherwise publish a full business inbox.
 */
export function maskSharedEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return "Demo inbox";
  const domain = email.slice(at + 1);
  const shared = /(^|\.)example\.com$/i.test(domain) || /@demo\.tradepulse$/i.test(email);
  return shared ? `[demo inbox]@${domain}` : email;
}

/**
 * A payout address shown on a receipt: the sandbox alias keeps its recognizable "sb-" prefix and
 * domain, but never its full local part. Real customer addresses are returned unchanged.
 */
export function maskSandboxEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return "Sandbox payee";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (/^sb-/i.test(local) && /(^|\.)example\.com$/i.test(domain)) return `sb-****@${domain}`;
  return maskSharedEmail(email);
}

/** A contact field never renders a quote-intake placeholder or a seeded example address. */
export function publicContactEmail(email: string | null | undefined): string {
  if (!email || /\.invalid$/i.test(email)) return "Contact not published";
  return maskSharedEmail(email) ?? "Contact not published";
}
