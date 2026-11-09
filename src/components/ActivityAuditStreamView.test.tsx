import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { ActivityAuditStreamView } from "./ActivityAuditStreamView";

vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => async () => undefined,
}));

const fallbackLogs = [
  {
    _id: "log1",
    projectId: "project1",
    eventType: "cron_executed",
    title: "Convex Automated Cron Engine ran the deadline check",
    description:
      "Used PAYPAL_SANDBOX_SUB4_EMAIL for vendor k1743f7m9q2d5qn733jmh5pg4c3x8hr9 on Convex; file at https://cheery-axolotl-689.convex.site.",
    actor: "Convex Automated Cron Engine",
    timestamp: Date.UTC(2026, 10, 8, 16, 0, 0),
  },
  {
    _id: "log2",
    projectId: "project1",
    eventType: "compliance_audit",
    title: "Licence lookup recorded",
    description: "CSLB check via KERNEL hosted browser on Convex for Ortiz Plumbing.",
    actor: "KERNEL hosted browser",
    timestamp: Date.UTC(2026, 10, 8, 16, 1, 0),
  },
  {
    _id: "log3",
    projectId: "project1",
    eventType: "bid_leveled",
    title: "Procurement scenario seeded: ORTIZ",
    description: "Two leveled bids. Nothing awarded.",
    actor: "Procurement scenario fixture",
    timestamp: Date.UTC(2026, 10, 8, 16, 2, 0),
  },
  {
    _id: "log4",
    projectId: "project1",
    eventType: "payee_confirmed",
    title: "Payout email confirmed",
    description: "The demo seed confirmed Ortiz Plumbing's PayPal sandbox payout email.",
    actor: "system:demo-seed",
    timestamp: Date.UTC(2026, 10, 8, 16, 3, 0),
  },
];

describe("activity and audit feed reader copy", () => {
  test("hides internal actors, env names, vendor ids and platform words", () => {
    const html = renderToStaticMarkup(
      <ActivityAuditStreamView currentProject={null} fallbackLogs={fallbackLogs} />
    );
    for (const banned of [
      "Convex Automated Cron Engine",
      "Convex Compliance Auditor Cron",
      "KERNEL hosted browser",
      "Procurement scenario fixture",
      "system:demo-seed",
      "PAYPAL_SANDBOX_SUB4_EMAIL",
      "k1743f7m9q2d5qn733jmh5pg4c3x8hr9",
      ".convex.site",
      "Convex",
      "demo seed",
    ]) {
      expect(html).not.toContain(banned);
    }
    expect(html).toContain("TradePulse automation");
    expect(html).toContain("Licence registry lookup");
    expect(html).toContain("Sample procurement setup");
    expect(html).toContain("Demo setup");
    expect(html).toContain("the configured setting");
    expect(html).toContain("the record on file");
    expect(html).toContain("the hosted file service");
  });
});
