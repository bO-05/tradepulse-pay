import { expect, test } from "vitest";
import { localDateInDays } from "./localDate";

test("default bid deadline advances two local-calendar weeks and rolls over years", () => {
  expect(localDateInDays(14, new Date(2026, 10, 1, 23, 59))).toBe("2026-11-15");
  expect(localDateInDays(14, new Date(2026, 11, 25))).toBe("2027-01-08");
  expect(localDateInDays(0, new Date(2026, 0, 1))).toBe("2026-01-01");
});
