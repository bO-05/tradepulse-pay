import { describe, expect, test } from "vitest";
import { relativeTime } from "./NotificationItem";

describe("relativeTime", () => {
  const now = 1_700_000_000_000;
  test("recent times read as relative", () => {
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
  });
  test("older times show the date", () => {
    expect(relativeTime(now - 3 * 86_400_000, now)).not.toMatch(/ago/);
  });
});
