import { describe, expect, test } from "vitest";
import { BLOCKED_RECIPIENT_MESSAGE } from "./recipientAllowlist";
import { assertAuthCodeSent } from "./authEmail";

function thrownData(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return (err as { data?: unknown }).data;
  }
  throw new Error("expected the call to throw");
}

describe("auth code send results", () => {
  test("only a real send counts as success", () => {
    expect(() => assertAuthCodeSent({ status: "sent", outboxId: "o" as never, messageId: "m", threadId: "t" })).not.toThrow();
  });

  test("a blocked recipient says retrying the same address cannot help", () => {
    expect(thrownData(() => assertAuthCodeSent({ status: "failed", error: "blocked", blockedRecipient: true }))).toMatchObject({
      code: "EMAIL_BLOCKED",
      message: BLOCKED_RECIPIENT_MESSAGE,
    });
  });

  test("a budget skip keeps its own retry-tomorrow message", () => {
    expect(thrownData(() => assertAuthCodeSent({ status: "skipped_budget", outboxId: "o" as never, message: "limit" }))).toMatchObject({
      code: "EMAIL_LIMIT",
    });
  });
});
