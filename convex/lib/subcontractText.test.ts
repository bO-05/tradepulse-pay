import { describe, expect, test } from "vitest";
import { defaultAgreementTerms } from "./agreementTerms";
import { buildSubcontractText, type SubcontractTextInput } from "./subcontractText";
import { venueFor } from "./venue";

const terms = defaultAgreementTerms({
  projectState: "CA",
  projectRetainageBps: 1000,
  companyDefaultRetainageBps: 1000,
  contractSumCents: 900_000,
});

function input(projectKind: SubcontractTextInput["projectKind"]): SubcontractTextInput {
  return {
    projectKind,
    agreementNumber: "SC-22-ORTIZ-0001",
    formattedDate: "November 8, 2026",
    generalContractor: "Demo GC",
    subName: "Ortiz Plumbing",
    contactEmail: "marisol@ortizplumbing.test",
    licenseLine: "C-36 1094872 (CSLB lookup: active, Nov 3, 2026)",
    projectTitle: "Lopez Kitchen Remodel",
    projectAddress: "1180 Elm Street, El Cerrito, CA 94530",
    projectType: "Residential kitchen remodel",
    ownerName: "Dana Lopez",
    csiDivision: "22 00 00",
    tradeName: "Plumbing",
    scopeSummary: "Re-pipe supply and waste, set fixtures at rough-in and trim, complete the final inspection.",
    mandatoryInclusions: ["Rough-in, fixtures and final"],
    contractSumCents: 900_000,
    excludedScopeNotes: [],
    terms,
    venue: venueFor("El Cerrito", "CA"),
  };
}

const RESIDENTIAL_BANNED = [
  "AIA",
  "G702",
  "G703",
  "CSI MasterFormat",
  "Prime",
  "Less previous certificates for payment",
];

describe("generated subcontract wording is keyed on project kind", () => {
  test("the Ortiz residential draft carries no commercial form vocabulary", () => {
    const text = buildSubcontractText(input("residential"));
    for (const banned of RESIDENTIAL_BANNED) expect(text).not.toContain(banned);
    expect(text).toContain("RESIDENTIAL SUBCONTRACT AGREEMENT - GENERATED DRAFT");
    expect(text).toContain("BETWEEN the Homeowner:");
    expect(text).toContain("Ortiz Plumbing");
    expect(text).toContain("SC-22-ORTIZ-0001");
    expect(text).toContain("Plumbing");
    expect(text).toContain("Residential subcontract draft for the project named above");
  });

  test("commercial generation is unchanged and an absent kind still means commercial", () => {
    const commercial = buildSubcontractText(input("commercial"));
    expect(buildSubcontractText(input(undefined))).toBe(commercial);
    expect(commercial).toContain("SUBCONTRACT AGREEMENT (AIA-STYLE TERMS) - GENERATED DRAFT");
    expect(commercial).toContain("AIA-style terms");
    expect(commercial).toContain("Prime Agreement between the Contractor and the Owner");
    expect(commercial).toContain("CSI MasterFormat Division 22 00 00 (Plumbing)");
    expect(commercial).toContain("AIA-style subcontract draft; not a form of the American Institute of Architects");
    expect(commercial).not.toContain("RESIDENTIAL SUBCONTRACT AGREEMENT");
  });
});
