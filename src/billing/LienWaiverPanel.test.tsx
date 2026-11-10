// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { SignedLine } from "./LienWaiverPanel";

describe("signed waiver timestamp", () => {
  test("renders one UTC designation", () => {
    const html = renderToStaticMarkup(
      <SignedLine
        slot={{
          amountCents: 400_000,
          signed: {
            waiverId: "waiver_1",
            amountCents: 400_000,
            signedAt: 1_794_152_960_000,
            signedByName: "Marisol Ortiz",
            signerTitle: null,
            note: null,
          },
        } as never}
      />,
    );
    const rendered = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    expect(rendered).toContain("Signed by Marisol Ortiz");
    expect(rendered).toContain("UTC");
    expect(rendered).not.toContain("UTC UTC");
    expect(rendered.match(/\bUTC\b/g)).toHaveLength(1);
  });
});
