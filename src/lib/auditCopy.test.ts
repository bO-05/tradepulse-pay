import { describe, expect, test } from "vitest";
import { auditActorLabel, auditCronLabel, auditText } from "./auditCopy";

describe("activity feed hides internal actors and identifiers", () => {
  test("maps the three automation actors to plain language", () => {
    expect(auditActorLabel("Convex Automated Cron Engine")).toBe("TradePulse automation");
    expect(auditActorLabel("Convex Compliance Auditor Cron")).toBe("Compliance check");
    expect(auditActorLabel("KERNEL hosted browser")).toBe("Licence registry lookup");
    expect(auditActorLabel("system:demo-seed")).toBe("Demo setup");
    expect(auditActorLabel("Procurement scenario fixture")).toBe("Sample procurement setup");
    expect(auditActorLabel("TradePulse Pay (demo seed)")).toBe("Demo setup");
  });

  test("hides env var names and Convex record ids", () => {
    const stored =
      "The demo seed confirmed Ortiz Plumbing's PayPal sandbox payout email (from PAYPAL_SANDBOX_SUB4_EMAIL) for vendor Ortiz Plumbing (k1743f7m9q2d5qn733jmh5pg4c3x8hr9) on behalf of the Demo GC.";
    const shown = auditText(stored);
    expect(shown).not.toMatch(/PAYPAL_SANDBOX/);
    expect(shown).not.toMatch(/k1743f7m9q2d5qn733jmh5pg4c3x8hr9/);
    expect(shown).toContain("the configured setting");
    expect(shown).toContain("The demo setup confirmed");
    expect(shown).not.toMatch(/demo seed/i);
  });

  test("hides vendor ids, platform names and demo suffixes", () => {
    expect(auditText("CSLB check via KERNEL hosted browser on Convex")).not.toMatch(/KERNEL|Convex/);
    expect(auditText("Ortiz Plumbing (demo)")).toBe("Ortiz Plumbing");
    expect(auditText("The demo seed (from CONVEX_SITE_URL)")).not.toContain("CONVEX_SITE_URL");
  });

  test("masks example addresses instead of printing them", () => {
    const shown = auditText("sent to sb-ll43ii53793068@personal.example.com");
    expect(shown).not.toContain("sb-ll43ii53793068");
    expect(shown).toContain("sb-****@personal.example.com");
  });

  test("cron names and descriptions are reader-facing", () => {
    expect(auditCronLabel("monitor-bid-deadlines").name).toBe("Bid deadline check");
    expect(auditCronLabel("audit-contractor-compliance").description).toContain("does not call a registry");
  });

  test("historical demo rows are reworded as sample setup, not seed internals", () => {
    expect(auditText("Demo pay-app review scenario seeded")).toBe("Pay-app review scenario prepared");
    expect(auditText("Demo compliance records seeded")).toBe("Example compliance records added");
    expect(auditText("The demo seed added 3 accepted demo compliance records")).toContain("Setup added 3 accepted example compliance records");
    expect(auditText("(filed by the guided demo for boldlevel182@agentmail.to)")).toBe(
      "(filed in the guided demo for the linked billing agent)",
    );
  });
});
