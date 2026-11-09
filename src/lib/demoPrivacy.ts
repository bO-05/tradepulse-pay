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
