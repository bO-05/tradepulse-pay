/**
 * The exact statement a subcontractor signs. The server builds it once, at issue time, and the
 * browser shows that string back verbatim before the signature is recorded, so the SHA-256 in the
 * evidence row is the hash of the text the signer read, not of a template that may since have moved.
 *
 * Dependency-free on purpose: the HTTP action, the mutations and the unit tests all import it, and
 * nothing here may reach for the database or for Convex types.
 */

export const WAIVER_STATEMENT_VERSION = "waiver-statement/1";

export const WAIVER_STATEMENT_DISCLAIMER =
  "This records the signer's attestation in TradePulse Pay. It is not legal advice and may not match the statutory waiver form your state requires. Confirm the wording with counsel before relying on it.";

export type WaiverStatementKind = "conditional" | "unconditional" | "retainage";

export type WaiverStatementInput = {
  kind: WaiverStatementKind;
  projectTitle: string;
  agreementNumber: string;
  recipientName: string;
  amountCents: number;
  throughDate: string;
  signedByName: string;
  signerTitle?: string;
};

/** Cents to "$43,412.60" without toLocaleString, so the text is identical on every machine. */
export function formatStatementMoney(cents: number): string {
  const whole = Math.trunc(Math.abs(cents) / 100);
  const rest = Math.abs(cents) % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${cents < 0 ? "-" : ""}${grouped}.${String(rest).padStart(2, "0")}`;
}

export function waiverStatementText(input: WaiverStatementInput): string {
  const label =
    input.kind === "conditional"
      ? "CONDITIONAL LIEN WAIVER"
      : input.kind === "unconditional"
        ? "UNCONDITIONAL LIEN WAIVER"
        : "RETAINAGE RELEASE WAIVER";
  const period =
    input.kind === "conditional"
      ? "Progress payment described below"
      : input.kind === "unconditional"
        ? "Prior payment described below"
        : "Closeout retainage described below";
  const signedBy = input.signerTitle ? `${input.signedByName}, ${input.signerTitle}` : input.signedByName;
  const release =
    input.kind === "retainage"
      ? "The undersigned, on behalf of the subcontractor, waives and releases any mechanic's lien, claim or right of lien against the project for retainage withheld from progress payments, up to the amount released above."
      : "The undersigned, on behalf of the subcontractor, waives and releases any mechanic's lien, claim or right of lien against the project for labour, services or materials furnished through the through date, up to the amount waived above.";
  return [
    `${label} — ${period}`,
    "",
    `Project: ${input.projectTitle}`,
    `Subcontract: ${input.agreementNumber}`,
    `Recipient of the waiver: ${input.recipientName}`,
    `Amount ${input.kind === "retainage" ? "released" : "waived"}: ${formatStatementMoney(input.amountCents)}`,
    `Through date: ${input.throughDate}`,
    `Signed by: ${signedBy}`,
    "",
    release,
    "",
    WAIVER_STATEMENT_DISCLAIMER,
  ].join("\n");
}

const HEX = "0123456789abcdef";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 15];
  return out;
}

/** SHA-256 of the statement text, hex. Runs in the HTTP action (Web Crypto), never in the browser. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

/** 32 random bytes, base64url. Unguessable, single use, never stored in the clear. */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
