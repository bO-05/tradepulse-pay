// @vitest-environment node
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useAction, useMutation, useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { AbandonedRunsToggle, JudgeDemoPage } from "./JudgeDemoPage";
import { ABANDONED_AFTER_MS } from "./runHistory";

vi.mock("convex/react", () => ({ useAction: vi.fn(), useMutation: vi.fn(), useQuery: vi.fn() }));
vi.mock("../LicenseCheck", () => ({ LicenseCheckPanel: () => null }));
vi.mock("../FundMilestone", () => ({ FundingProvider: () => null, FundMilestoneControl: () => null, readableError: (e: unknown) => String(e) }));
vi.mock("./SandboxTopUpPanel", () => ({ SandboxTopUpPanel: () => null }));

const NOW = Date.UTC(2026, 10, 11, 8, 0, 0);
const history = [
  { runId: "run20", agreementNumber: "A401-DEMO-PAY-20261110-20", createdAt: NOW - 1221 * 60_000, payAppsPaid: false, ownerPaid: false },
  { runId: "run19", agreementNumber: "A401-DEMO-PAY-20261109-19", createdAt: NOW - 30 * ABANDONED_AFTER_MS, payAppsPaid: false, ownerPaid: false },
  { runId: "run12", agreementNumber: "A401-DEMO-PAY-20261107-12", createdAt: NOW - 100 * ABANDONED_AFTER_MS, payAppsPaid: true, ownerPaid: false },
  { runId: "run02", agreementNumber: "A401-DEMO-PAY-20261101-02", createdAt: NOW - 240 * ABANDONED_AFTER_MS, payAppsPaid: true, ownerPaid: true },
];
const runView = (id: string, createdAt: number) => ({
  _id: id, agreementId: `agreement_${id}`, agreementNumber: `A401-${id}`, agreementStatus: "generated", contractorId: null,
  honestPayAppId: null, agentPayAppId: null, projectId: `project_${id}`, changeOrderId: null, createdAt, readOnlyReference: false,
});

function mockQueries(run: ReturnType<typeof runView>) {
  vi.mocked(useQuery).mockImplementation(((ref: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(ref as never);
    if (name === "judgeDemo/runs:listRuns") return history;
    if (name === "judgeDemo/runs:getRun" || name === "judgeDemo/runs:getRunByPath") return run;
    if (name === "billing/changeOrders:listForProject") return { prime: { changeOrders: [] } };
    return undefined;
  }) as never);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("sessionStorage", { getItem: () => null, removeItem: () => undefined });
  vi.mocked(useAction).mockReturnValue((async () => undefined) as never);
  vi.mocked(useMutation).mockReturnValue((async () => undefined) as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("guided demo page: abandoned runs", () => {
  test("abandoned runs are hidden behind a counted toggle and the old failure labels are gone", () => {
    mockQueries(runView("run02", NOW - 240 * ABANDONED_AFTER_MS));
    const html = renderToStaticMarkup(<JudgeDemoPage initialRunId="run02" />);
    expect(html).toContain('data-testid="judge-demo-abandoned-toggle"');
    expect(html).toContain("Show 2 abandoned runs");
    expect(html).not.toContain('value="run20"');
    expect(html).not.toContain('value="run19"');
    expect(html).toContain('value="run12"');
    expect(html).toContain("Complete · Owner paid");
    expect(html).not.toMatch(/Pay apps incomplete|Owner unpaid/);
  });

  test("a selected abandoned run stays selectable, shows a frozen timer and an explanatory note", () => {
    mockQueries(runView("run20", NOW - 1221 * 60_000));
    const html = renderToStaticMarkup(<JudgeDemoPage initialRunId="run20" />);
    expect(html).toContain('value="run20"');
    expect(html).toContain('data-abandoned="true"');
    expect(html).not.toContain("Elapsed 1221");
    expect(html).toContain('data-testid="judge-demo-abandoned-note"');
  });

  test("a fresh run still counts up and is not called abandoned", () => {
    mockQueries(runView("fresh", NOW - 90_000));
    const html = renderToStaticMarkup(<JudgeDemoPage initialRunId="fresh" />);
    expect(html).toContain("Elapsed 1:30");
    expect(html).not.toContain('data-testid="judge-demo-abandoned-note"');
  });

  test("paid pay apps without an invoice read owner-payment-open in both the selector and the detail", () => {
    // run12 is beyond the abandonment hour but its pay apps are paid and the Owner has not paid.
    mockQueries(runView("run12", NOW - 100 * ABANDONED_AFTER_MS));
    const html = renderToStaticMarkup(<JudgeDemoPage initialRunId="run12" />);
    expect(html).toContain("Pay apps paid · Owner payment open");
    const detail = html.match(/data-testid="judge-demo-elapsed"[^>]*>([^<]*)</)?.[0] ?? "";
    expect(detail).toContain("Pay apps paid · Owner payment open");
    expect(detail).not.toContain('data-abandoned="true"');
    expect(html).not.toContain('data-testid="judge-demo-abandoned-note"');
    expect(detail).not.toMatch(/Elapsed|Abandoned/);
  });

  test("abandoned entries stay out by default and sit behind an accurate singular/plural count", () => {
    mockQueries(runView("run02", NOW - 240 * ABANDONED_AFTER_MS));
    const html = renderToStaticMarkup(<JudgeDemoPage initialRunId="run02" />);
    const options = html.slice(html.indexOf("<select"), html.indexOf("</select>"));
    expect(options).not.toContain("Abandoned · not finished");
    expect(html).toContain("Show 2 abandoned runs");
  });
});

describe("guided demo page: abandoned toggle interaction", () => {
  test("the toggle renders its checked state and reports on and off without a DOM renderer", () => {
    const changes: boolean[] = [];
    const tree = AbandonedRunsToggle({ count: 2, checked: false, onChange: (checked) => changes.push(checked) }) as ReactElement;
    const input = (tree.props as { children: ReactElement[] }).children[0];
    expect(input.props.type).toBe("checkbox");
    expect(input.props.checked).toBe(false);
    input.props.onChange({ target: { checked: true } });
    input.props.onChange({ target: { checked: false } });
    expect(changes).toEqual([true, false]);
    expect(renderToStaticMarkup(AbandonedRunsToggle({ count: 1, checked: true, onChange: () => undefined }))).toContain("checked");
    expect(renderToStaticMarkup(AbandonedRunsToggle({ count: 1, checked: true, onChange: () => undefined }))).toContain("Show 1 abandoned run");
  });
});
