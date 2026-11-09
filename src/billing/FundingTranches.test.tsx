// @vitest-environment node
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { termsForKind } from "../lib/terms";
import { FundingTranches } from "./FundingTranches";

vi.mock("convex/react", () => {
  const list = {
    tranches: [
      {
        _id: "tranche_1",
        name: "Rough-in",
        amountCents: 400_000,
        plannedDate: Date.UTC(2026, 10, 20),
        status: "funded",
        locked: true,
      },
    ],
    trancheTotalCents: 400_000,
    contractSumToDateCents: 900_000,
    defaultPlannedDate: Date.UTC(2026, 10, 27),
    projectStartDate: null,
    canEdit: false,
    editBlockedReason: null,
  };
  return {
    useQuery: () => list,
    useMutation: () => async () => undefined,
    useAction: () => async () => undefined,
  };
});

function html(kind: "residential" | "commercial") {
  return renderToStaticMarkup(
    <FundingTranches agreementId="agreement_1" ledgerMilestones={[]} isGc={false} terms={termsForKind(kind)} />,
  );
}

/**
 * The GC funding ledger is shared by residential and commercial jobs. Its visible words come from
 * `termsForKind`, so a remodel says "funded milestone" while the commercial reference keeps the
 * tranche wording it has always had.
 */
describe("GC agreement funding ledger wording", () => {
  test("a residential job says milestone funding and never tranche", () => {
    const rendered = html("residential");
    expect(rendered).toContain("Milestone funding total");
    expect(rendered).toContain("Funding a milestone authorizes money at PayPal.");
    expect(rendered).toContain("Funded milestone");
    expect(rendered).not.toContain("Tranches total");
    expect(rendered).not.toContain("Funding tranches");
  });

  test("a commercial job keeps today's tranche wording", () => {
    const rendered = html("commercial");
    expect(rendered).toContain("Tranches total");
    expect(rendered).toContain("Funding tranches");
    expect(rendered).toContain("Funding a tranche authorizes money at PayPal.");
    expect(rendered).not.toContain("Milestone funding total");
    expect(rendered).not.toContain("Funded milestone");
  });

  test("the ledger view keys the funding panel on the agreement's project kind", () => {
    const view = readFileSync(new URL("../payments/AgreementLedgerView.tsx", import.meta.url), "utf8");
    expect(view).toContain("termsForKind(agreement.projectKind)");
    expect(view).toMatch(/<FundingTranches[\s\S]*?terms=\{terms\}/);
  });
});
