import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { g702Summary, type G703LineInput } from "../../convex/payApps/g703Math";
import { termsForKind } from "../lib/terms";
import { ContinuationSheet, G702Card } from "./PayAppPage";

const line: G703LineInput = {
  scheduledValueCents: 400_000,
  previousWorkCents: 0,
  previousStoredCents: 0,
  workThisPeriodCents: 400_000,
  storedCents: 0,
  retainageBps: 500,
  previousRetainageCents: 0,
};

const summary = g702Summary([line], { originalContractSumCents: 900_000, previousCertificatesCents: 0 });

const sheetLine = {
  sovLineId: "sov_line_1",
  lineNo: 1,
  description: "Rough-in",
  csiCode: "22 00 00",
  scheduledValueCents: 400_000,
  retainageBps: 500,
  previousWorkCents: 0,
  previousStoredCents: 0,
  pendingCents: 0,
  workThisPeriodCents: 400_000,
  storedCents: 0,
  note: null,
  requestedWorkCents: null,
  requestedStoredCents: null,
};

function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

function sheet(kind: "residential" | "commercial"): string {
  return text(
    renderToStaticMarkup(
      <ContinuationSheet
        lines={[sheetLine] as never}
        editable={false}
        errors={new Map()}
        onChange={() => undefined}
        summary={summary}
        gcReasons={new Map()}
        terms={termsForKind(kind)}
      />,
    ),
  );
}

const BANNED = ["Materials presently stored", "Materials stored", "G702", "G703", "Prime", "tranche"];

describe("sub pay app breakdown", () => {
  test("residential drops the materials column and uses draw column labels", () => {
    const rendered = sheet("residential");
    expect(rendered).toContain("Pay app breakdown");
    expect(rendered).toContain("D · Previously paid");
    expect(rendered).toContain("E · This draw");
    expect(rendered).toContain("G · Work completed to date");
    expect(rendered).toContain("% complete");
    expect(rendered).not.toContain("G · Completed & stored to date");
    for (const phrase of BANNED) expect(rendered, phrase).not.toContain(phrase);
  });

  test("commercial keeps the G703 columns byte-for-byte", () => {
    const rendered = sheet("commercial");
    expect(rendered).toContain("Continuation sheet (G703)");
    expect(rendered).toContain("G703 continuation sheet, columns A to I");
    expect(rendered).toContain("F · Materials presently stored");
    expect(rendered).toContain("D · From previous applications");
    expect(rendered).toContain("E · This period");
    expect(rendered).toContain("G · Completed & stored to date");
    expect(rendered).toContain("% (G ÷ C)");
    expect(rendered).not.toContain("Pay app breakdown");
  });
});

describe("sub pay app summary", () => {
  test("residential drops G702 wording and the stored-material row", () => {
    const rendered = text(
      renderToStaticMarkup(<G702Card summary={summary} retainageBps={500} agreementId="agreement_1" terms={termsForKind("residential")} />),
    );
    expect(rendered).toContain("Pay app summary");
    expect(rendered).toContain("Total work completed to date");
    expect(rendered).toContain("Previously paid");
    expect(rendered).toContain("This draw");
    expect(rendered).not.toContain("On stored material");
    for (const phrase of BANNED) expect(rendered, phrase).not.toContain(phrase);
  });

  test("commercial keeps Application summary (G702) and its AIA rows", () => {
    const rendered = text(
      renderToStaticMarkup(<G702Card summary={summary} retainageBps={500} agreementId="agreement_1" terms={termsForKind("commercial")} />),
    );
    expect(rendered).toContain("Application summary (G702)");
    expect(rendered).toContain("Total completed & stored to date");
    expect(rendered).toContain("On stored material");
    expect(rendered).toContain("Less previous certificates for payment");
    expect(rendered).toContain("Current payment due");
    expect(rendered).toContain("historical G702");
  });
});
