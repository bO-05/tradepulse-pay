import { expect, test } from "vitest";
import { submissionAttribution } from "./SubmissionAttribution";

test("guided filings take precedence over real-account and agent claims", () => {
  for (const actorType of ["human", "agent"] as const) {
    const text = submissionAttribution({ actorType, userEmail: "private@example.test", agentEmail: "private@example.test" }, "driver@example.test");
    expect(text).toContain("Filed in the guided demo");
    expect(text).not.toContain("@");
    expect(text).not.toContain("stand-in");
    expect(text).not.toContain("AgentID");
  }
});

test("a shared demo account is named as a demo, not presented as the real subcontractor", () => {
  const text = submissionAttribution({ actorType: "human", userEmail: "sub1@demo.tradepulse" });
  expect(text).toContain("shared demo account");
  expect(text).toContain("not the real subcontractor");
});

test("a verified account owner is distinguished from the construction owner", () => {
  expect(submissionAttribution({ actorType: "agent", onBehalfOf: "Verified person" })).toContain("not necessarily");
  expect(submissionAttribution({ actorType: "agent" })).toContain("no verified account owner recorded");
  expect(submissionAttribution({ actorType: "agent" })).not.toContain("AgentID");
});
