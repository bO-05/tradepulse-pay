// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { useQuery } from "convex/react";
import { SovPage } from "./SovEditor";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

describe("SovPage", () => {
  test("the not-found state links back to the agreement instead of the dead #/home route", () => {
    vi.mocked(useQuery).mockReturnValue(null);
    const html = renderToStaticMarkup(<SovPage agreementId="agreement_1" backHash="#/agreements/agreement_1" />);
    expect(html).toContain("Schedule of values not found or not available to this account.");
    expect(html).toContain('href="#/agreements/agreement_1"');
    expect(html).not.toContain('href="#/home"');
  });
});
