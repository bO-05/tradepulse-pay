import { expect, test } from "vitest";
import { submissionAttribution } from "./SubmissionAttribution";

test("guided stand-ins take precedence over real-account and agent claims", () => {
  for (const actorType of ["human", "agent"] as const) {
    const text = submissionAttribution({ actorType, userEmail: "private@example.test", agentEmail: "private@example.test" }, "driver@example.test");
    expect(text).toContain("demo stand-in");
    expect(text).not.toContain("@");
    expect(text).not.toContain("unknown");
  }
});

test("a shared demo account is named as a demo, not presented as the real subcontractor", () => {
  const text = submissionAttribution({ actorType: "human", userEmail: "sub1@demo.tradepulse" });
  expect(text).toContain("shared demo account");
  expect(text).toContain("not the real subcontractor");
});

test("verified AgentID owner is distinguished from the construction Owner", () => {
  expect(submissionAttribution({ actorType: "agent", onBehalfOf: "Verified person" })).toContain("not necessarily");
  expect(submissionAttribution({ actorType: "agent" })).toContain("no verified AgentID account owner recorded");
});
