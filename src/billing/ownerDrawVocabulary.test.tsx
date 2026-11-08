import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { G702Summary, PrimeSheet } from "./OwnerBilling";

type Detail = ComponentProps<typeof G702Summary>["app"];

function app(kind: "residential" | "commercial"): Detail {
  return {
    _id: "owner_pay_app_1",
    applicationNo: 1,
    projectKind: kind,
    retainageBps: 500,
    figures: {
      originalContractSumCents: 8_650_000,
      netChangeOrdersCents: 120_000,
      contractSumToDateCents: 8_770_000,
      completedAndStoredCents: 4_000_000,
      earnedLessRetainageCents: 3_800_000,
      previousCertificatesCents: 0,
      retainageCents: 200_000,
      currentPaymentDueCents: 3_600_000,
      balanceToFinishInclRetainageCents: 4_970_000,
    },
    controls: { edit: false },
    lines: [
      {
        key: "prime-line-1",
        lineNo: 1,
        kind: "gc",
        description: "Rough-in",
        scheduledValueCents: 4_000_000,
        previousWorkCents: 0,
        previousStoredCents: 0,
        workThisPeriodCents: 4_000_000,
        storedCents: 0,
        totalCents: 4_000_000,
        percentHundredths: 10_000,
        balanceCents: 0,
        retainageCents: 200_000,
        remainingCents: 0,
        subRetainageCents: null,
        agreementId: null,
      },
    ],
  } as unknown as Detail;
}

/** Static markup includes data-testid attributes; the vocabulary gate is about rendered text. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

const BANNED = [
  "Materials stored",
  "Less previous certificates for payment",
  "certificates for payment",
  "Prime continuation sheet",
  "Prime",
  "G702",
  "G703",
  "AIA",
  "CSI",
  "CSI MasterFormat",
  "Div 26",
  "tranche",
];

describe("owner draw summary", () => {
  test("residential renders Draw summary with Previously paid and This draw", () => {
    const rendered = text(renderToStaticMarkup(<G702Summary app={app("residential")} />));
    expect(rendered).toContain("Draw summary");
    expect(rendered).toContain("Previously paid");
    expect(rendered).toContain("This draw");
    expect(rendered).toContain("Total work completed to date");
    for (const phrase of BANNED) expect(rendered, phrase).not.toContain(phrase);
  });

  test("commercial keeps the pinned AIA rows", () => {
    const rendered = text(renderToStaticMarkup(<G702Summary app={app("commercial")} />));
    expect(rendered).toContain("Less previous certificates for payment");
    expect(rendered).toContain("Current payment due");
    expect(rendered).toContain("on each prime line");
    expect(rendered).toContain("Total completed & stored to date");
    expect(rendered).not.toContain("Draw summary");
  });
});

describe("owner draw breakdown", () => {
  test("residential renders four money columns and no materials row", () => {
    const rendered = text(renderToStaticMarkup(<PrimeSheet app={app("residential")} amounts={{}} errors={{}} />));
    expect(rendered).toContain("Draw breakdown");
    for (const label of ["Work completed", "Previously paid", "This draw", "Retainage"]) expect(rendered).toContain(label);
    for (const phrase of BANNED) expect(rendered, phrase).not.toContain(phrase);
  });

  test("commercial keeps Materials stored and the continuation-sheet caption", () => {
    const rendered = text(renderToStaticMarkup(<PrimeSheet app={app("commercial")} amounts={{}} errors={{}} />));
    expect(rendered).toContain("Prime continuation sheet");
    expect(rendered).toContain("Materials stored");
    expect(rendered).toContain("Previous applications");
    expect(rendered).toContain("This period");
    expect(rendered).toContain("Completed & stored");
    expect(rendered).not.toContain("Draw breakdown");
  });
});
