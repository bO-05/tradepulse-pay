import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, test } from "vitest";
import { csvAmount, csvText } from "./csvExports";
import { buildChangeOrderPdf } from "./pdfs";
import { bpsPercent, fileSlug, pdfAmount, pdfSignedAmount, winAnsi } from "./pdfText";

describe("pdf text helpers", () => {
  test("winAnsi keeps drawable characters and replaces the rest", () => {
    expect(winAnsi("CO #1 – Café “quoted” €5")).toBe("CO #1 – Café “quoted” €5");
    expect(winAnsi("a\u2212b\u00a0c\td\ne")).toBe("a-b c d e");
    expect(winAnsi("Łódź 中文 ✓")).toBe("Lódz ?? x");
  });

  test("amounts, percentages and slugs", () => {
    expect(pdfAmount(17_240_000)).toBe("172,400.00");
    expect(pdfAmount(-120_000)).toBe("(1,200.00)");
    expect(pdfSignedAmount(875_000)).toBe("+8,750.00");
    expect(pdfSignedAmount(0)).toBe("0.00");
    expect(bpsPercent(500)).toBe("5%");
    expect(bpsPercent(475)).toBe("4.75%");
    expect(bpsPercent(1050)).toBe("10.5%");
    expect(fileSlug("SUB-26 001 / Harbor")).toBe("SUB-26-001-Harbor");
    expect(() => pdfAmount(1.5)).toThrow();
  });

  test("CSV cells: amounts are plain, formula-like text is prefixed and quotes are doubled", () => {
    expect(csvAmount(-120_000)).toBe("-1200.00");
    expect(csvAmount(5)).toBe("0.05");
    for (const start of ["=", "+", "-", "@", "\t", "\r"]) expect(csvText(`${start}SUM(1)`)).toBe(`"'${start}SUM(1)"`);
    expect(csvText('Say "hi"')).toBe('"Say ""hi"""');
  });
});

describe("pdf builders", () => {
  test("a PDF with non-WinAnsi text renders, is byte-identical on re-render and extracts cleanly", async () => {
    const data = {
      scope: "subcontract" as const,
      number: 2,
      label: "CO #2",
      title: "Delete 2 exterior fixtures → credit 中",
      description: "",
      amountCents: -120_000,
      scheduleDays: null,
      statusLabel: "Approved",
      projectTitle: "Harbor Point Dental Office TI",
      projectAddress: "455 Embarcadero W, Oakland, CA 94607",
      partyFrom: { role: "Contractor", name: "Bayview Builders Inc." },
      partyTo: { role: "Subcontractor", name: "Eastbay Electric" },
      contractRef: "Subcontract SUB-26-001",
      originalContractSumCents: 17_240_000,
      previousContractSumCents: 18_115_000,
      newContractSumCents: 17_995_000,
      approved: true,
      approvedBy: "Dana Ortiz",
      approvedOn: "Nov 30, 2026",
      requestedOn: "Nov 28, 2026",
    };
    const asOf = Date.UTC(2026, 10, 30);
    const a = await buildChangeOrderPdf(data, asOf);
    const b = await buildChangeOrderPdf(data, asOf);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(a)), { mergePages: true });
    expect(text).toContain("Delete 2 exterior fixtures -> credit ?");
    expect(text).toContain("(1,200.00)");
    expect(text).toContain("179,950.00");
    expect(text).toContain("Not an AIA document");
  });
});
