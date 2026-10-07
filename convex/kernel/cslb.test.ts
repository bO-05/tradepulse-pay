import { describe, expect, test } from "vitest";
import { buildCslbScript, describeKernelFailure, normalizeLicenseNumber, parseCslbPage, scrub } from "./cslb";
import { CSLB_FIXTURES } from "./cslbFixtures";

describe("parseCslbPage with captured CSLB pages", () => {
  test("142881 Rosendin Electric is active", () => {
    const r = parseCslbPage(CSLB_FIXTURES["142881"], "142881");
    expect(r.status).toBe("active");
    expect(r.rawSummary).toContain("ROSENDIN ELECTRIC INC");
    expect(r.rawSummary).toContain("License Status: This license is current and active.");
    expect(r.rawSummary).toContain("C10 - ELECTRICAL");
  });

  test("1000000 is expired", () => {
    const r = parseCslbPage(CSLB_FIXTURES["1000000"], "1000000");
    expect(r.status).toBe("expired");
    expect(r.rawSummary).toContain("HALA TREE SERVICE INC");
    expect(r.rawSummary).toContain("This license is expired and not able to contract at this time.");
    expect(r.rawSummary).toContain("Expires 01/31/2019");
  });

  test("512239 TDIndustries is expired even with an additional status section", () => {
    const r = parseCslbPage(CSLB_FIXTURES["512239"], "512239");
    expect(r.status).toBe("expired");
    expect(r.rawSummary).toContain("TDINDUSTRIES INC");
  });

  test("a suspended license is suspended", () => {
    const r = parseCslbPage(CSLB_FIXTURES["1089556"], "1089556");
    expect(r.status).toBe("suspended");
    expect(r.rawSummary).toMatch(/under suspension/);
  });

  test("an inactive license is inactive, not active", () => {
    const r = parseCslbPage(CSLB_FIXTURES["898280"], "898280");
    expect(r.status).toBe("inactive");
    expect(r.rawSummary).toContain("This license is inactive and not able to contract at this time.");
  });

  test("a number with no record is not_found", () => {
    const r = parseCslbPage(CSLB_FIXTURES["9999999"], "9999999");
    expect(r.status).toBe("not_found");
    expect(r.rawSummary).toContain("License Number does not exist.");
  });

  test("a non-numeric number rejected by the form is not_found", () => {
    const r = parseCslbPage(CSLB_FIXTURES["TX-RMP-39182"], "TX-RMP-39182");
    expect(r.status).toBe("not_found");
    expect(r.rawSummary).toContain("Please enter a valid number");
  });

  test("an unrecognised page is unverified, never active", () => {
    expect(parseCslbPage({ url: "https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx", text: "Check A License" }, "1").status).toBe("unverified");
    expect(parseCslbPage({ url: "https://x/LicenseDetail.aspx?LicNum=1", text: "License Status\nSomething new\nClassifications" }, "1").status).toBe("unverified");
    expect(parseCslbPage({ url: "", text: "" }, "1").status).toBe("unverified");
  });
});

describe("helpers", () => {
  test("the script embeds the license number as a string literal and uses the CSLB selectors", () => {
    const code = buildCslbScript('1"; evil()');
    expect(code).toContain(JSON.stringify('1"; evil()'));
    expect(code).toContain("#MainContent_LicNo");
    expect(code).toContain("#MainContent_Contractor_License_Number_Search");
    expect(code).toContain("LicenseDetail");
  });

  test("license numbers are trimmed", () => {
    expect(normalizeLicenseNumber("  142 881 ")).toBe("142881");
  });

  test("failure reasons never include the key", () => {
    const key = "sk_live_supersecretvalue123";
    expect(describeKernelFailure(Object.assign(new Error(`bad key ${key}`), { status: 401 }), key)).toBe("KERNEL rejected the API key (HTTP 401).");
    expect(describeKernelFailure(new Error(`boom ${key}`), key)).not.toContain(key);
    expect(scrub(`x ${key} y`, key)).toBe("x [redacted] y");
  });
});
