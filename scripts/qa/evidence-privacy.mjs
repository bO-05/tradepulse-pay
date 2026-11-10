import fs from "node:fs";
import path from "node:path";

/**
 * Shared evidence privacy for the read-only QA writers.
 *
 * Browser evidence is release evidence even when it lands in the gitignored `evidence/` tree, so
 * no writer may persist an email-shaped value: not in the DOM a screenshot shows, not in a
 * measurement, not in a failure detail, not in a console line and not in `report.json`.
 *
 * The contract is deliberately fail-closed:
 *
 *   - mask email-shaped strings anywhere in a nested value, including keys;
 *   - leave numbers, booleans, null and non-email text untouched, and never mutate the input;
 *   - mask the live DOM (text, input/textarea values, placeholders and the perceivable
 *     attributes a judge can read) and re-check the DOM afterwards;
 *   - mask and verify the DOM again before every screenshot;
 *   - serialize reports through a sanitizer whose result is scanned again, and refuse to write or
 *     print anything when an email-shaped match survives. The refusal error is generic: it never
 *     carries the address, the match or the offending location.
 *
 * Detection is intentionally broad (`local@domain.tld`). Masking a non-address is an acceptable
 * cost; persisting one is not.
 */

export const EMAIL_PATTERN_SOURCE = "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}";
export const MASK_TOKEN = "[masked email]";
export const PRIVACY_FAILURE_MESSAGE = "Evidence privacy check failed: email-shaped content survived masking";

const emailPattern = () => new RegExp(EMAIL_PATTERN_SOURCE, "gi");

/** The only error the privacy layer raises: no address, no match, no location. */
export class EvidencePrivacyError extends Error {
  constructor(surface = "evidence") {
    super(PRIVACY_FAILURE_MESSAGE);
    this.name = "EvidencePrivacyError";
    this.code = "EVIDENCE_PRIVACY";
    // A file name or surface label, never a value or a match.
    this.surface = surface;
  }
}

/** Masks every email-shaped substring in a string. Non-strings are stringified safely. */
export function maskEmailText(value) {
  return String(value ?? "").replace(emailPattern(), MASK_TOKEN);
}

/** Counts email-shaped substrings without ever returning the match itself. */
export function countEmailMatches(value) {
  return (String(value ?? "").match(emailPattern()) ?? []).length;
}

/**
 * Deep, non-mutating sanitizer. Strings are masked, arrays are mapped, plain objects get both
 * their keys and values masked, and every other primitive is preserved exactly.
 *
 * An object with a custom `toJSON` keeps its own shape here; the serialized scan in
 * `serializeEvidence` is the fail-closed net for it.
 */
export function sanitizeForEvidence(value, seen = new WeakSet()) {
  if (typeof value === "string") return maskEmailText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => sanitizeForEvidence(entry, seen));
    if (value instanceof Date) return new Date(value.getTime());
    if (typeof value.toJSON === "function") return value;
    const sanitized = {};
    const usedKeys = new Set();
    for (const [key, entry] of Object.entries(value)) {
      let safeKey = maskEmailText(key);
      if (usedKeys.has(safeKey)) {
        let suffix = 2;
        while (usedKeys.has(`${safeKey} (${suffix})`)) suffix += 1;
        safeKey = `${safeKey} (${suffix})`;
      }
      usedKeys.add(safeKey);
      sanitized[safeKey] = sanitizeForEvidence(entry, seen);
    }
    return sanitized;
  } finally {
    seen.delete(value);
  }
}

function stringifyEvidence(value, surface) {
  try {
    const json = JSON.stringify(value, null, 2);
    if (typeof json !== "string") throw new Error("not serializable");
    return json;
  } catch {
    // An unserializable payload cannot be proven clean, so it is refused.
    throw new EvidencePrivacyError(surface);
  }
}

/**
 * Fails closed when email-shaped content is present. Accepts a string to scan verbatim, or any
 * value to scan through its serialized form. The thrown error is always generic.
 */
export function assertNoEmailEvidence(value, surface = "evidence") {
  const text = typeof value === "string" ? value : stringifyEvidence(value, surface);
  if (countEmailMatches(text) > 0) throw new EvidencePrivacyError(surface);
  return text;
}

/**
 * Sanitizes, serializes, then scans the serialized form. This is the only supported way to turn
 * report data into persisted or printed JSON: a survivor becomes a generic refusal, never output.
 */
export function serializeEvidence(value, surface = "evidence") {
  const sanitized = sanitizeForEvidence(value);
  const json = stringifyEvidence(sanitized, surface);
  assertNoEmailEvidence(json, surface);
  return json;
}

/** Writes a report through the fail-closed serializer. Nothing is written on a refusal. */
export function writeEvidenceJson(file, value, surface = path.basename(file)) {
  const json = serializeEvidence(value, surface);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, json, "utf8");
  return file;
}

/** Writes generated Markdown only after proving it carries no email-shaped content. */
export function writeEvidenceText(file, text, surface = path.basename(file)) {
  const body = assertNoEmailEvidence(String(text ?? ""), surface);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
  return file;
}

/** Safe JSON for stdout: same fail-closed serializer as the report files. */
export function printEvidence(value, surface = "stdout") {
  console.log(serializeEvidence(value, surface));
}

/** Safe single line for console output: masks, then never prints a match. */
export function safeEvidenceLine(value) {
  return maskEmailText(value);
}

/**
 * Runs in the browser. Masks every email-shaped value a screenshot could show: rendered text,
 * input and textarea values, placeholders, the perceivable attributes (title, aria-label,
 * aria-description, alt) and the document title. Returns counts only.
 */
export function maskDomEmails() {
  const email = new RegExp("[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}", "gi");
  const mask = (text) => String(text ?? "").replace(email, "[masked email]");
  const skipped = ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"];
  const stats = { textNodes: 0, controls: 0, attributes: 0, title: 0 };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || skipped.includes(parent.tagName)) continue;
    const current = node.textContent ?? "";
    const next = mask(current);
    if (next !== current) {
      node.textContent = next;
      stats.textNodes += 1;
    }
  }
  for (const control of document.querySelectorAll("input, textarea")) {
    const current = control.value ?? "";
    const next = mask(current);
    if (next !== current) {
      control.value = next;
      stats.controls += 1;
    }
    const placeholder = control.getAttribute("placeholder");
    if (placeholder) {
      const masked = mask(placeholder);
      if (masked !== placeholder) {
        control.setAttribute("placeholder", masked);
        stats.controls += 1;
      }
    }
  }
  for (const element of document.querySelectorAll("[title], [aria-label], [aria-description], [alt]")) {
    for (const attribute of ["title", "aria-label", "aria-description", "alt"]) {
      const current = element.getAttribute(attribute);
      if (!current) continue;
      const next = mask(current);
      if (next !== current) {
        element.setAttribute(attribute, next);
        stats.attributes += 1;
      }
    }
  }
  const title = document.title ?? "";
  const maskedTitle = mask(title);
  if (maskedTitle !== title) {
    document.title = maskedTitle;
    stats.title += 1;
  }
  return stats;
}

/**
 * Runs in the browser. Post-mask check over the same surfaces. Returns a count plus surface
 * labels only, so a failure can be reported without repeating the address.
 */
export function countDomEmailSurvivors() {
  const email = new RegExp("[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}", "i");
  const skipped = ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"];
  const surfaces = [];
  let remaining = 0;
  const record = (surface, value) => {
    email.lastIndex = 0;
    if (!email.test(String(value ?? ""))) return;
    remaining += 1;
    if (!surfaces.includes(surface)) surfaces.push(surface);
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || skipped.includes(parent.tagName)) continue;
    record("text", node.textContent);
  }
  for (const control of document.querySelectorAll("input, textarea")) {
    record("control-value", control.value);
    record("placeholder", control.getAttribute("placeholder"));
  }
  for (const element of document.querySelectorAll("[title], [aria-label], [aria-description], [alt]")) {
    for (const attribute of ["title", "aria-label", "aria-description", "alt"]) {
      record(`attribute:${attribute}`, element.getAttribute(attribute));
    }
  }
  record("title", document.title);
  return { ok: remaining === 0, remaining, surfaces };
}

/** Masks the live DOM through the shared browser function. */
export async function maskEmailsInPage(page) {
  return page.evaluate(maskDomEmails);
}

/** Verifies the live DOM has no email-shaped survivor. */
export async function verifyPageHasNoEmails(page) {
  return page.evaluate(countDomEmailSurvivors);
}

/**
 * The only supported capture path. Masks the DOM, proves the masked DOM is clean, and only then
 * takes the screenshot. A survivor refuses the capture instead of persisting unsafe evidence.
 */
export async function captureEvidenceScreenshot(
  page,
  file,
  { fullPage = false, element = null, mask = maskEmailsInPage, verify = verifyPageHasNoEmails } = {},
) {
  await mask(page);
  const state = await verify(page);
  if (!state || state.ok !== true) throw new EvidencePrivacyError(path.basename(file));
  if (element) await element.screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage });
  return file;
}
