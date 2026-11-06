/**
 * Limits and lifetimes for lien-waiver signing evidence (B10). Dependency-free so the signing
 * mutation, the evidence mutation, the HTTP action and the tests all read the same numbers.
 */

/** How long a ticket stays redeemable. Short enough that a stale tab has to re-issue. */
export const EVIDENCE_TICKET_TTL_MS = 10 * 60 * 1000;
/** How long recorded evidence may sit before the signature must be re-attested. */
export const EVIDENCE_MAX_AGE_MS = 30 * 60 * 1000;
export const STATEMENT_MAX_CHARS = 4_000;
export const USER_AGENT_MAX_CHARS = 512;
export const IP_MAX_CHARS = 64;
export const WAIVER_EVIDENCE_PATH = "/api/waivers/evidence";
