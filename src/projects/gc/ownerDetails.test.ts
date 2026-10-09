import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ownerDetailRows } from "./ownerDetails";

describe("GC owner company details", () => {
  test("show the owner's legal name, address and phone from its profile", () => {
    const rows = ownerDetailRows({
      name: "Harbor Point Dental",
      legalName: "Harbor Point Dental Group LLC",
      phone: "(510) 555-0142",
      address: { line1: "200 Harbor Way", line2: "Suite 4", city: "Oakland", state: "CA", zip: "94607" },
      billingEmail: "ap@harborpoint.test",
    });
    expect(Object.fromEntries(rows.map((r) => [r.label, r.value]))).toEqual({
      Company: "Harbor Point Dental",
      "Legal name": "Harbor Point Dental Group LLC",
      Address: "200 Harbor Way, Suite 4, Oakland, CA 94607",
      Phone: "(510) 555-0142",
      "Billing email": "ap@harborpoint.test",
    });
  });

  test("unset profile fields read Not set", () => {
    const rows = ownerDetailRows({ name: "Harbor Point Dental", legalName: null, phone: null, address: null, billingEmail: null });
    expect(rows.filter((r) => r.label !== "Company").map((r) => r.value)).toEqual(["Not set", "Not set", "Not set", "Not set"]);
  });

  test("the project page owner card renders these rows", () => {
    const src = readFileSync(new URL("./ProjectPage.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/ownerDetailRows\(company\)/);
  });
});
