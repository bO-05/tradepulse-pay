import { describe, expect, test } from "vitest";
import {
  computeCompliance,
  daysUntil,
  FILE_TYPE_ERROR,
  fileTooLargeMessage,
  maskedTin,
  sniffContentType,
  storedFileName,
  tinLast4,
  validateCoi,
  validateLicense,
  validateW9,
  type ComplianceRecord,
} from "./complianceRules";
import { DEFAULT_INSURANCE } from "./agreementTerms";

const TODAY = "2026-10-10";
const REQ = { ...DEFAULT_INSURANCE, umbrellaCents: 200_000_000 };

function plusDays(n: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function coi(overrides: Partial<NonNullable<ComplianceRecord["coi"]>> = {}, status: ComplianceRecord["status"] = "accepted", createdAt = 1): ComplianceRecord {
  return {
    kind: "coi",
    status,
    createdAt,
    coi: {
      insurer: "Golden State Mutual Insurance Co.",
      glPolicyNumber: "GL-448812",
      glEachOccurrenceCents: 100_000_000,
      glAggregateCents: 200_000_000,
      autoCents: 100_000_000,
      umbrellaCents: 200_000_000,
      workersComp: true,
      additionalInsured: true,
      effectiveDate: plusDays(-30),
      expiryDate: plusDays(335),
      ...overrides,
    },
  };
}
const w9: ComplianceRecord = { kind: "w9", status: "accepted", createdAt: 1, w9: { entityType: "s_corporation", tinLast4: "4567", signedDate: plusDays(-2) } };
function license(expiryDate = plusDays(400)): ComplianceRecord {
  return { kind: "license", status: "accepted", createdAt: 1, license: { licenseNumber: "142881", state: "CA", classification: "C-10 Electrical", expiryDate } };
}

describe("file type check", () => {
  test("recognizes PDF, PNG and JPEG by their first bytes", () => {
    expect(sniffContentType(new TextEncoder().encode("%PDF-1.7\n"))).toBe("application/pdf");
    expect(sniffContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  });
  test("a renamed executable or text file is not accepted", () => {
    expect(sniffContentType(new TextEncoder().encode("MZ\x90\x00"))).toBeNull();
    expect(sniffContentType(new TextEncoder().encode("Meeting notes\n"))).toBeNull();
    expect(sniffContentType(new Uint8Array())).toBeNull();
    expect(FILE_TYPE_ERROR).toMatch(/isn't a valid PDF, PNG or JPEG/);
  });
  test("size message states the limit; stored names take the real extension", () => {
    expect(fileTooLargeMessage(12 * 1024 * 1024)).toBe("This file is 12.0 MB. The limit is 10 MB.");
    expect(storedFileName("coi.pdf", "image/jpeg")).toBe("coi.jpg");
    expect(storedFileName("../../evil<>.pdf", "application/pdf")).toBe(".._.._evil__.pdf");
  });
});

describe("TIN handling", () => {
  test("only the last four of a 9-digit TIN are kept", () => {
    expect(tinLast4("94-1234567")).toBe("4567");
    expect(tinLast4("941234567")).toBe("4567");
    expect(tinLast4("1234")).toBeNull();
    expect(maskedTin("4567")).toBe("•••-••-4567");
  });
  test("W-9 validation needs exactly four stored digits and a past signed date", () => {
    expect(validateW9({ entityType: "s_corporation", tinLast4: "4567", signedDate: plusDays(-2) }, TODAY)).toEqual({});
    expect(validateW9({ entityType: "s_corporation", tinLast4: "941234567", signedDate: plusDays(1) }, TODAY)).toEqual({
      tin: "Enter the 9-digit TIN (EIN or SSN).",
      signedDate: "Signed date can't be in the future.",
    });
  });
});

describe("field validation", () => {
  test("COI requires insurer and an expiry after the effective date", () => {
    const errors = validateCoi({ ...coi().coi!, insurer: " ", expiryDate: plusDays(-40) });
    expect(errors.insurer).toBe("Insurer is required.");
    expect(errors.expiryDate).toBe("Expiry date must be after the effective date.");
    expect(validateCoi({ ...coi().coi!, glEachOccurrenceCents: 1.5 }).glEachOccurrenceCents).toBe("GL each occurrence must be a dollar amount.");
  });
  test("license requires a state", () => {
    expect(validateLicense({ licenseNumber: "ROC 312345", state: "ZZ", classification: "CR-11", expiryDate: plusDays(200) }).state).toBe("State is required.");
  });
});

describe("computed compliance", () => {
  test("all accepted and meeting the terms is compliant", () => {
    const r = computeCompliance([coi(), w9, license()], REQ, TODAY);
    expect(r.status).toBe("compliant");
    expect(r.reasons).toEqual([]);
  });

  test("a pending or rejected record never counts", () => {
    const r = computeCompliance([coi(), { ...w9, status: "pending_review" }, { ...w9, status: "rejected" }, license()], REQ, TODAY);
    expect(r.status).toBe("missing");
    expect(r.reasons.map((x) => x.message)).toEqual(["Missing: W-9."]);
  });

  test("a newer accepted COI below the limits supersedes a compliant one", () => {
    const r = computeCompliance([coi({}, "accepted", 1), coi({ glEachOccurrenceCents: 50_000_000 }, "accepted", 2), w9, license()], REQ, TODAY);
    expect(r.status).toBe("non_compliant");
    expect(r.reasons[0].message).toBe("GL each occurrence $500,000.00 is below the required $1,000,000.00.");
  });

  test("additional insured No is named", () => {
    const r = computeCompliance([coi({ additionalInsured: false }), w9, license()], REQ, TODAY);
    expect(r.status).toBe("non_compliant");
    expect(r.reasons[0].message).toMatch(/^Additional insured: No/);
  });

  test("30-day expiring boundary", () => {
    expect(computeCompliance([coi({ expiryDate: plusDays(20) }), w9, license()], REQ, TODAY).status).toBe("expiring");
    expect(computeCompliance([coi({ expiryDate: plusDays(20) }), w9, license()], REQ, TODAY).reasons[0].message).toMatch(/expires in 20 days/);
    expect(computeCompliance([coi({ expiryDate: plusDays(30) }), w9, license()], REQ, TODAY).status).toBe("expiring");
    expect(computeCompliance([coi({ expiryDate: plusDays(31) }), w9, license()], REQ, TODAY).status).toBe("compliant");
    expect(computeCompliance([coi({ expiryDate: TODAY }), w9, license()], REQ, TODAY).status).toBe("expiring");
  });

  test("expired yesterday names the item and date; expired outranks missing", () => {
    const r = computeCompliance([coi({ expiryDate: plusDays(-1) }), license()], REQ, TODAY);
    expect(r.status).toBe("expired");
    expect(r.reasons[0].message).toBe("Certificate of insurance expired on Oct 9, 2026.");
    expect(r.reasons[1].message).toBe("Missing: W-9.");
  });

  test("expired license", () => {
    expect(computeCompliance([coi(), w9, license(plusDays(-3))], REQ, TODAY).byKind.license).toBe("expired");
  });

  test("daysUntil", () => {
    expect(daysUntil("2026-10-10", "2026-10-30")).toBe(20);
    expect(daysUntil("2026-10-10", "2026-10-09")).toBe(-1);
  });
});
