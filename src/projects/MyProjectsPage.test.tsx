// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { api } from "../../convex/_generated/api";
import { MyProjectsPage } from "./MyProjectsPage";

vi.mock("convex/react", () => ({ useQuery: vi.fn() }));

const PROJECT_ID = "project_legacy_commercial";

beforeEach(() => {
  vi.mocked(useQuery).mockReset();
  vi.mocked(useQuery).mockImplementation(((fn: unknown) => {
    const name = getFunctionName(fn as never);
    if (name === getFunctionName(api.people.myProjects)) {
      return [{
        _id: PROJECT_ID,
        title: "Demo · TradePulse Pay judge demo 20261105-07",
        location: "Austin, TX",
        gcCompanyName: "Demo GC (TradePulse Pay demo)",
      }];
    }
    if (name === getFunctionName(api.people.projectOverview)) {
      return {
        _id: PROJECT_ID,
        title: "Demo · TradePulse Pay judge demo 20261105-07",
        location: "Austin, TX",
        gcCompanyName: "Demo GC (TradePulse Pay demo)",
        partyRole: "owner",
        ownerSummary: null,
        changeOrders: [
          {
            _id: "co_legacy",
            label: "PCO #1",
            description: "Judge demo: add two EV charger circuits in the garage",
            amountCents: 185_000,
            status: "paid",
            payerViewUrl: null,
          },
          {
            _id: "co_ordinary",
            label: "PCO #2",
            description: "Add a pantry light",
            amountCents: 25_000,
            status: "approved",
            payerViewUrl: null,
          },
        ],
        agreements: [],
        gcContacts: [],
        yourCompanyName: "Demo Owner",
        yourTeam: [],
      };
    }
    return undefined;
  }) as never);
});

describe("the owner project detail route", () => {
  test("cleans a stored legacy change-order title at render time only", () => {
    const html = renderToStaticMarkup(<MyProjectsPage projectId={PROJECT_ID} />);
    expect(html).toContain("add two EV charger circuits in the garage");
    expect(html).not.toContain("Judge demo");
    expect(html).toContain("Add a pantry light");
    expect(html).toContain("PCO #1");
    expect(html).toContain('href="#/my-projects/project_legacy_commercial"');
  });
});
