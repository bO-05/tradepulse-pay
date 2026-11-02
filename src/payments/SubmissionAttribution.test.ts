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

test("verified AgentID owner is distinguished from the construction Owner", () => {
  expect(submissionAttribution({ actorType: "agent", onBehalfOf: "Verified person" })).toContain("not necessarily");
  expect(submissionAttribution({ actorType: "agent" })).toContain("no verified AgentID account owner recorded");
});
