import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import { useQuery } from "convex/react";
import { SponsorDiagnosticsView } from "./SponsorDiagnosticsView";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useAction: vi.fn(() => vi.fn()) }));
vi.mock("../dashboard/PayAppEvalPanel", () => ({ PayAppEvalPanel: () => null }));

beforeEach(() => {
  vi.mocked(useQuery).mockReset();
});

test("shows the configured Mistral model without presenting key presence as live proof", () => {
  vi.mocked(useQuery).mockReturnValueOnce(null).mockReturnValue({
    primaryProvider: "mistral",
    mistral: true,
    mistralModel: "mistral-large-4",
  });
  const html = renderToStaticMarkup(<SponsorDiagnosticsView />);
  expect(html).toContain("Configured AI Route");
  expect(html).toContain("mistral-large-4");
  expect(html).toContain("Configured — run diagnostics to verify");
  expect(html).not.toContain("Live — key configured");
});

test("missing Mistral configuration remains an adapter requiring a server-side key", () => {
  vi.mocked(useQuery).mockReturnValueOnce(null).mockReturnValue({ mistral: false });
  const html = renderToStaticMarkup(<SponsorDiagnosticsView />);
  expect(html).toContain("Adapter ready —");
  expect(html).toContain("MISTRAL_API_KEY");
  expect(html).not.toContain("Live — key configured");
});
