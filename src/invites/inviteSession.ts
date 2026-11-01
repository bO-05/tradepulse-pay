/**
 * The invite token the visitor arrived with, kept for this tab so sign-up, the emailed code and
 * sign-in can happen before the invite is accepted. Cleared once the invite is accepted or dead.
 */
const KEY = "tradepulse.pendingInvite";

export const INVITE_HASH_PREFIX = "#/invite";

export function inviteTokenFromHash(hash: string): string | null {
  if (hash !== INVITE_HASH_PREFIX && !hash.startsWith(`${INVITE_HASH_PREFIX}/`)) return null;
  const raw = hash.slice(INVITE_HASH_PREFIX.length + 1);
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

export function rememberInviteToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(KEY, token);
  } catch {
    // Storage can be unavailable (private mode); the link in the address bar still works.
  }
}

export function pendingInviteToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function forgetInviteToken(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
