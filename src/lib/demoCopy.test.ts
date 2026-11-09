import { describe, expect, test } from "vitest";
import { demoDisplayName, demoIdentityName, demoPeriodLabel, demoProjectDescription, demoProjectName } from "./demoCopy";

describe("seeded demo names read as real", () => {
  test("drops a demo or seed parenthetical and the old brand suffix", () => {
    expect(demoDisplayName("Ortiz Plumbing (demo)")).toBe("Ortiz Plumbing");
    expect(demoDisplayName("Demo GC (TradePulse Pay demo)")).toBe("Demo GC");
    expect(demoDisplayName("Demo GC (seed)")).toBe("Demo GC");
    expect(demoDisplayName("Demo Sub 4 (Ortiz Plumbing)")).toBe("Demo Sub 4");
    expect(demoDisplayName("Demo GC (Austin Commercial, LP)")).toBe("Demo GC");
    expect(demoDisplayName("Demo Owner (Domain Tower B)")).toBe("Demo Owner");
  });

  test("replaces the demo insurer with a realistic name", () => {
    expect(demoDisplayName("Demo Mutual Insurance Co. (demo)")).toBe("Harbor Point Mutual");
  });

  test("leaves a real company name alone", () => {
    expect(demoDisplayName("Rosendin Electric, Inc.")).toBe("Rosendin Electric, Inc.");
    expect(demoDisplayName("Bayview Remodeling")).toBe("Bayview Remodeling");
  });
});

describe("the demo identity chip names the residential job", () => {
  test("the shared demo seats read as the GC and owner on the Lopez job", () => {
    expect(demoIdentityName("Demo GC")).toBe("Bayview Remodeling");
    expect(demoIdentityName("Demo GC (TradePulse Pay demo)")).toBe("Bayview Remodeling");
    expect(demoIdentityName("Demo Owner")).toBe("Dana Lopez");
    expect(demoIdentityName("Demo Owner (Domain Tower B)")).toBe("Dana Lopez");
  });

  test("a real account name is unchanged", () => {
    expect(demoIdentityName("Ortiz Plumbing")).toBe("Ortiz Plumbing");
    expect(demoIdentityName("Rosendin Electric, Inc.")).toBe("Rosendin Electric, Inc.");
  });
});

describe("seeded demo project and period labels", () => {
  test("a guided-demo title loses the run prefix and the words judge demo", () => {
    expect(demoProjectName("Demo · TradePulse Pay judge demo 20261108-13")).toBe("Sandbox run 20261108-13");
    expect(demoProjectName("Demo · Pay-app review scenario")).toBe("Pay-app review scenario");
    expect(demoProjectName("The Domain Tower B - Commercial MEP")).toBe("The Domain Tower B - Commercial MEP");
  });

  test("a seeded project description does not say demo data or judge demo", () => {
    expect(demoProjectDescription("Demo data for the one-click TradePulse Pay judge demo")).toBe(
      "Sandbox data for a one-click guided run",
    );
    expect(demoProjectDescription("Class-A Commercial Mixed-Use")).toBe("Class-A Commercial Mixed-Use");
  });

  test("a guided period label is plain and keeps the billing-agent note", () => {
    expect(demoPeriodLabel("Judge demo · Period 1 (honest)")).toBe("Period 1");
    expect(demoPeriodLabel("Judge demo · Period 2 (billing agent)")).toBe("Period 2 · billing agent");
    expect(demoPeriodLabel("Pay app #1 – period ending Nov 25, 2026")).toBe("Pay app #1 – period ending Nov 25, 2026");
  });
});
