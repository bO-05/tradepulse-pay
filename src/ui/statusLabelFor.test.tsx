import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { CommercialReferenceBadge, StatusPill } from "./index";
import { statusLabel, statusLabelFor, statusMetaFor } from "./statusLabels";

describe("statusLabelFor", () => {
  test("renders Signed for an executed agreement only on a residential job", () => {
    expect(statusLabelFor("executed", "residential")).toBe("Signed");
    expect(statusLabelFor("executed", "commercial")).toBe("Executed");
    expect(statusLabelFor("executed")).toBe("Executed");
    expect(statusLabel("executed")).toBe("Executed");
  });

  test("leaves every other code and its tone untouched", () => {
    expect(statusLabelFor("approved", "residential")).toBe("Approved");
    expect(statusLabelFor("submitted_to_owner", "residential")).toBe("Submitted to owner");
    expect(statusMetaFor("executed", "residential")).toEqual({ ...statusMetaFor("executed"), label: "Signed" });
    expect(statusMetaFor("executed", "residential").tone).toBe("success");
    expect(statusMetaFor("executed", "commercial").label).toBe("Executed");
  });

  test("the status code is unchanged in the DOM; only the visible label differs", () => {
    const residential = renderToStaticMarkup(<StatusPill status="executed" kind="residential" />);
    const commercial = renderToStaticMarkup(<StatusPill status="executed" kind="commercial" />);
    expect(residential).toContain('data-status="executed"');
    expect(residential).toContain(">Signed<");
    expect(residential).not.toContain(">Executed<");
    expect(commercial).toContain('data-status="executed"');
    expect(commercial).toContain(">Executed<");
  });
});

describe("CommercialReferenceBadge", () => {
  test("is visible on a commercial job, including one with no kind stored", () => {
    for (const kind of ["commercial", undefined] as const) {
      const html = renderToStaticMarkup(<CommercialReferenceBadge kind={kind} />);
      expect(html).toContain('data-testid="commercial-reference-badge"');
      expect(html).toContain("Commercial reference job");
    }
  });

  test("never renders on a residential job", () => {
    expect(renderToStaticMarkup(<CommercialReferenceBadge kind="residential" />)).toBe("");
  });
});
