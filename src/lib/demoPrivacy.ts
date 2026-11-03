/** Public shared demos never display a personal/operational inbox local part. */
export function demoEmail(email: string, isDemo: boolean): string {
  if (!isDemo || /@demo\.tradepulse$/i.test(email)) return email;
  const at = email.lastIndexOf("@");
  return at < 0 ? "Demo inbox" : `[demo inbox]${email.slice(at)}`;
}
