import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EvidencePrivacyError,
  MASK_TOKEN,
  PRIVACY_FAILURE_MESSAGE,
  assertNoEmailEvidence,
  captureEvidenceScreenshot,
  countDomEmailSurvivors,
  countEmailMatches,
  maskDomEmails,
  maskEmailText,
  sanitizeForEvidence,
  serializeEvidence,
  writeEvidenceJson,
} from "./evidence-privacy.mjs";

/**
 * All fixtures are synthetic `.invalid` addresses, so no real seat, payee or owner address ever
 * appears in this test file or its output.
 */
const SEAT = "ana.seat@example.invalid";
const SUB = "bob.sub@example.invalid";
const OWNER = "cy.owner@example.invalid";

function textNode(textContent) {
  return { textContent, parentElement: { tagName: "P" } };
}

function fakeControl({ value = "", placeholder = null } = {}) {
  const attributes = placeholder === null ? {} : { placeholder };
  return {
    value,
    attributes,
    getAttribute: (name) => attributes[name] ?? null,
    setAttribute(name, next) {
      attributes[name] = String(next);
    },
  };
}

function fakeAttributed(initial = {}) {
  const attributes = { ...initial };
  return {
    attributes,
    getAttribute: (name) => attributes[name] ?? null,
    setAttribute(name, next) {
      attributes[name] = String(next);
    },
  };
}

function stubDocument({ textNodes = [], controls = [], attributed = [], title = "" } = {}) {
  return {
    title,
    body: { tagName: "BODY" },
    createTreeWalker() {
      let index = -1;
      return {
        nextNode() {
          index += 1;
          return index < textNodes.length ? textNodes[index] : null;
        },
        get currentNode() {
          return textNodes[index] ?? null;
        },
      };
    },
    querySelectorAll(selector) {
      if (selector === "input, textarea") return controls;
      if (selector === "[title], [aria-label], [aria-description], [alt]") return attributed;
      return [];
    },
  };
}

function withDom(documentStub, body) {
  const previousDocument = globalThis.document;
  const previousFilter = globalThis.NodeFilter;
  globalThis.document = documentStub;
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  try {
    return body();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousFilter === undefined) delete globalThis.NodeFilter;
    else globalThis.NodeFilter = previousFilter;
  }
}

test("masks nested object and array values, and object keys", () => {
  const input = {
    target: "https://example.test/reports",
    [SEAT]: {
      note: `invite ${SUB} and ${OWNER}`,
      rows: [{ owner: OWNER, amountCents: 480000, paid: true, memo: null }],
    },
  };
  const sanitized = sanitizeForEvidence(input);
  assert.ok(Object.keys(sanitized).includes(MASK_TOKEN), JSON.stringify(Object.keys(sanitized)));
  assert.equal(sanitized[MASK_TOKEN].note, `invite ${MASK_TOKEN} and ${MASK_TOKEN}`);
  assert.equal(sanitized[MASK_TOKEN].rows[0].owner, MASK_TOKEN);
  assert.equal(sanitized[MASK_TOKEN].rows[0].amountCents, 480000);
  assert.equal(sanitized[MASK_TOKEN].rows[0].paid, true);
  assert.equal(sanitized[MASK_TOKEN].rows[0].memo, null);
  assert.equal(sanitized.target, "https://example.test/reports");
});

test("preserves numbers, booleans, null and non-email text exactly", () => {
  for (const value of [0, 42, -1.5, Number.MAX_SAFE_INTEGER, false, true, null, undefined]) {
    assert.equal(sanitizeForEvidence(value), value);
  }
  assert.equal(maskEmailText("Retainage you hold $200.00 · paid draw 3,600.00"), "Retainage you hold $200.00 · paid draw 3,600.00");
  assert.equal(maskEmailText(""), "");
  assert.equal(maskEmailText(`write ${SEAT}`), `write ${MASK_TOKEN}`);
  assert.equal(maskEmailText(`write ${MASK_TOKEN}`), `write ${MASK_TOKEN}`);
  assert.equal(countEmailMatches("no addresses here"), 0);
});

test("never mutates its input", () => {
  const input = {
    [SEAT]: [`${SUB}`, { owner: OWNER, rows: [{ note: `mail ${SEAT}`, cents: 20000 }] }],
    diagnostics: { pageErrors: [`console: ${OWNER}`], failedRequests: [] },
  };
  const snapshot = JSON.parse(JSON.stringify(input));
  const sanitized = sanitizeForEvidence(input);
  assert.deepEqual(input, snapshot);
  assert.notDeepEqual(sanitized, snapshot);
  assert.equal(countEmailMatches(JSON.stringify(sanitized)), 0);
});

test("serializes a sanitized report whose JSON carries no email-shaped value", () => {
  const report = {
    target: "http://localhost:3150",
    checks: [{ name: "landing offers all three demo seats", ok: true, detail: `seats ${SEAT}, ${SUB}, ${OWNER}` }],
    measurements: [{ screen: "inbox", records: [{ payAppId: "abc", owner: OWNER }] }],
    pageErrors: [`boom ${SEAT}`],
  };
  const json = serializeEvidence(report, "report.json");
  assert.equal(countEmailMatches(json), 0);
  const parsed = JSON.parse(json);
  assert.match(parsed.checks[0].detail, new RegExp(MASK_TOKEN.replace(/[[\]]/g, "\\$&")));
  assert.equal(parsed.measurements[0].records[0].payAppId, "abc");
  assert.equal(parsed.target, "http://localhost:3150");
});

test("fails closed with a generic error when a payload survives sanitizing", () => {
  const payload = { nested: { toJSON: () => `raw ${SEAT}` } };
  assert.throws(
    () => serializeEvidence(payload, "report.json"),
    (error) => {
      assert.ok(error instanceof EvidencePrivacyError);
      assert.equal(error.name, "EvidencePrivacyError");
      assert.equal(error.message, PRIVACY_FAILURE_MESSAGE);
      assert.equal(error.surface, "report.json");
      assert.ok(!error.message.includes("ana.seat"));
      assert.ok(!String(error.stack).includes("ana.seat"));
      return true;
    },
  );
  assert.throws(
    () => assertNoEmailEvidence(`leaked ${SUB}`, "stdout"),
    (error) => error instanceof EvidencePrivacyError && error.message === PRIVACY_FAILURE_MESSAGE,
  );
});

test("refuses to write a report file when the payload cannot be proven clean", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-privacy-"));
  try {
    const file = path.join(root, "report.json");
    assert.throws(() => writeEvidenceJson(file, { bad: { toJSON: () => SEAT } }), EvidencePrivacyError);
    assert.equal(fs.existsSync(file), false);

    const clean = path.join(root, "clean", "report.json");
    writeEvidenceJson(clean, { checks: [{ name: "ok", detail: `seat ${SEAT}` }] });
    const written = fs.readFileSync(clean, "utf8");
    assert.equal(countEmailMatches(written), 0);
    assert.ok(written.includes(MASK_TOKEN));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("masks DOM text, form values, placeholders and perceivable attributes before a capture", () => {
  const documentStub = stubDocument({
    textNodes: [textNode(`Write to ${SEAT} for access`), textNode("Retainage you hold $200.00")],
    controls: [fakeControl({ value: SUB, placeholder: `Email ${OWNER}` }), fakeControl({ value: "$4,800.00" })],
    attributed: [fakeAttributed({ "aria-label": `Owner ${OWNER}`, title: `Receipt for ${SEAT}` })],
    title: `TradePulse Pay — ${SEAT}`,
  });
  withDom(documentStub, () => {
    const stats = maskDomEmails();
    assert.ok(stats.textNodes >= 1);
    assert.ok(stats.controls >= 2);
    assert.ok(stats.attributes >= 2);
    assert.equal(stats.title, 1);
    assert.equal(documentStub.body.tagName, "BODY");
    const survivors = countDomEmailSurvivors();
    assert.equal(survivors.ok, true, JSON.stringify(survivors));
    assert.equal(survivors.remaining, 0);
  });
  assert.equal(documentStub.querySelectorAll("input, textarea")[0].value, MASK_TOKEN);
  assert.equal(documentStub.querySelectorAll("input, textarea")[0].getAttribute("placeholder"), `Email ${MASK_TOKEN}`);
  assert.equal(documentStub.querySelectorAll("input, textarea")[1].value, "$4,800.00");
  assert.equal(documentStub.querySelectorAll("[title], [aria-label], [aria-description], [alt]")[0].getAttribute("aria-label"), `Owner ${MASK_TOKEN}`);
  assert.equal(documentStub.title, `TradePulse Pay — ${MASK_TOKEN}`);
});

test("the post-mask check still catches a survivor a writer could not mask", () => {
  const stubborn = {
    value: "",
    getAttribute: () => `frozen ${SEAT}`,
    setAttribute() {
      // A frozen or re-rendered attribute is exactly the case the post-check exists for.
    },
  };
  const documentStub = stubDocument({ controls: [stubborn] });
  withDom(documentStub, () => {
    maskDomEmails();
    const survivors = countDomEmailSurvivors();
    assert.equal(survivors.ok, false);
    assert.ok(survivors.remaining >= 1);
    assert.ok(survivors.surfaces.includes("placeholder"));
    assert.equal(JSON.stringify(survivors).includes("ana.seat"), false);
  });
});

test("every screenshot masks and verifies before the capture runs", async () => {
  const events = [];
  const page = {
    async evaluate() {
      events.push("evaluate");
      return { ok: true, remaining: 0, surfaces: [], textNodes: 1, controls: 0, attributes: 0, title: 0 };
    },
    async screenshot(options) {
      events.push("screenshot");
      assert.equal(options.fullPage, true);
    },
  };
  const file = path.join(os.tmpdir(), "evidence-privacy-order.png");
  await captureEvidenceScreenshot(page, file, { fullPage: true });
  assert.deepEqual(events, ["evaluate", "evaluate", "screenshot"]);
});

test("a post-mask survivor refuses the capture instead of persisting it", async () => {
  const events = [];
  const page = {
    async evaluate() {
      events.push("evaluate");
      return { ok: false, remaining: 2, surfaces: ["text", "control-value"], textNodes: 0, controls: 0, attributes: 0, title: 0 };
    },
    async screenshot() {
      events.push("screenshot");
    },
  };
  await assert.rejects(
    captureEvidenceScreenshot(page, path.join(os.tmpdir(), "evidence-privacy-survivor.png")),
    (error) => error instanceof EvidencePrivacyError
      && error.message === PRIVACY_FAILURE_MESSAGE
      && !error.message.includes("ana.seat"),
  );
  assert.deepEqual(events, ["evaluate", "evaluate"]);
});

test("element captures go through the same mask-and-verify path", async () => {
  const events = [];
  const element = {
    async screenshot(options) {
      events.push("element-screenshot");
      assert.equal(options.path.endsWith("money-trail.png"), true);
    },
  };
  const page = {
    async evaluate() {
      events.push("evaluate");
      return { ok: true, remaining: 0, surfaces: [] };
    },
  };
  await captureEvidenceScreenshot(page, path.join(os.tmpdir(), "money-trail.png"), { element });
  assert.deepEqual(events, ["evaluate", "evaluate", "element-screenshot"]);
});
