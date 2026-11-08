// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { JudgeSimulationDock } from "./JudgeSimulationDock";

vi.mock("convex/react", () => ({ useMutation: vi.fn(() => async () => undefined) }));

test("the TradePulse Pay demo card describes the per-line cut, not a flat edited-down approval", () => {
  const html = renderToStaticMarkup(
    <JudgeSimulationDock
      isOpen
      onClose={vi.fn()}
      tradePackages={[]}
      activePackageId=""
      onTriggerSimulation={async () => undefined}
      onResetSeedData={async () => undefined}
    />,
  );
  expect(html).toContain("cut the flagged overbilled line by its own dollars");
  expect(html).not.toContain("one as proposed and one edited down");
  expect(html).not.toContain("one edited down");
});
