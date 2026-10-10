import { describe, expect, test } from "vitest";
import { bidClosesAt, bidDueHasPassed, bidZoneForState, formatBidDue, packageDue, parseBidDueTime, zonedWallTimeToUtc } from "./bidDue";

/** Wall-clock parts of an instant in an IANA zone, from the platform's tz database. */
function wallIn(iana: string, ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: iana,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

describe("formatBidDue", () => {
  test("date with a time reads in the project's zone", () => {
    expect(formatBidDue({ bidDeadline: "2026-10-30", bidDueTime: "14:00" }, "CA")).toBe("Oct 30, 2026, 2:00 PM PT");
    expect(formatBidDue({ bidDeadline: "2026-10-30", bidDueTime: "09:05" }, "TX")).toBe("Oct 30, 2026, 9:05 AM CT");
    expect(formatBidDue({ bidDeadline: "2026-10-30", bidDueTime: "00:00" }, "NY")).toBe("Oct 30, 2026, 12:00 AM ET");
    expect(formatBidDue({ bidDeadline: "2026-10-30", bidDueTime: "12:30" }, "AZ")).toBe("Oct 30, 2026, 12:30 PM MST");
  });

  test("no time reads end of day", () => {
    expect(formatBidDue({ bidDeadline: "2026-10-30" }, "CA")).toBe("Oct 30, 2026, end of day PT");
    expect(formatBidDue("2026-10-30", "AZ")).toBe("Oct 30, 2026, end of day MST");
    expect(formatBidDue("2026-10-30", undefined)).toBe("Oct 30, 2026, end of day ET");
  });

  test("older rows with the time inside bidDeadline still read", () => {
    expect(formatBidDue("2026-10-30T14:00", "CA")).toBe("Oct 30, 2026, 2:00 PM PT");
  });

  test("the zone recorded with the time wins over a later state change", () => {
    const pkg = { bidDeadline: "2026-10-30", bidDueTime: "14:00", bidDueTimeZone: "America/Los_Angeles" };
    expect(formatBidDue(pkg, "TX")).toBe("Oct 30, 2026, 2:00 PM PT");
    expect(bidClosesAt(pkg, "TX")).toBe(Date.parse("2026-10-30T21:00:00Z"));
  });

  test("project state falls back to the address state", () => {
    expect(packageDue({ bidDeadline: "2026-10-30", bidDueTime: "14:00" }, { address: { state: "CA" } }).dueLabel).toBe("Oct 30, 2026, 2:00 PM PT");
    expect(packageDue({ bidDeadline: "2026-12-15" }, { location: "2201 E Camelback Rd, Phoenix, AZ 85016" }).dueLabel).toBe("Dec 15, 2026, end of day MST");
    expect(packageDue({ bidDeadline: "2026-12-15" }, { location: "Oakland, CA" }).dueLabel).toBe("Dec 15, 2026, end of day PT");
    expect(packageDue({ bidDeadline: "2026-12-15" }, { location: "Somewhere" }).dueLabel).toBe("Dec 15, 2026, end of day ET");
  });
});

describe("parseBidDueTime", () => {
  test("blank means end of day; HH:MM accepted; anything else refused", () => {
    expect(parseBidDueTime(undefined)).toBeUndefined();
    expect(parseBidDueTime("  ")).toBeUndefined();
    expect(parseBidDueTime("14:00")).toBe("14:00");
    expect(() => parseBidDueTime("2 PM")).toThrow(/time like 14:00/);
    expect(() => parseBidDueTime("24:00")).toThrow();
  });
});

describe("bidClosesAt", () => {
  test("Oct 30, 2026 2:00 PM PT is 21:00 UTC (daylight time)", () => {
    expect(bidClosesAt({ bidDeadline: "2026-10-30", bidDueTime: "14:00" }, "CA")).toBe(Date.parse("2026-10-30T21:00:00Z"));
  });

  test("after the fall change the same wall time is an hour later in UTC", () => {
    // DST ends Sunday Nov 1, 2026.
    expect(bidClosesAt({ bidDeadline: "2026-11-02", bidDueTime: "14:00" }, "CA")).toBe(Date.parse("2026-11-02T22:00:00Z"));
    expect(bidClosesAt({ bidDeadline: "2026-11-01", bidDueTime: "00:30" }, "CA")).toBe(Date.parse("2026-11-01T07:30:00Z"));
    expect(bidClosesAt({ bidDeadline: "2026-11-01", bidDueTime: "03:00" }, "CA")).toBe(Date.parse("2026-11-01T11:00:00Z"));
  });

  test("spring change: before and after 2:00 on the second Sunday of March", () => {
    // DST starts Sunday Mar 8, 2026.
    expect(bidClosesAt({ bidDeadline: "2026-03-08", bidDueTime: "01:30" }, "NY")).toBe(Date.parse("2026-03-08T06:30:00Z"));
    expect(bidClosesAt({ bidDeadline: "2026-03-08", bidDueTime: "03:00" }, "NY")).toBe(Date.parse("2026-03-08T07:00:00Z"));
  });

  test("end of day closes at the next local midnight, also across a DST change", () => {
    expect(bidClosesAt({ bidDeadline: "2026-10-30" }, "CA")).toBe(Date.parse("2026-10-31T07:00:00Z"));
    // Oct 31 -> Nov 1 midnight is still daylight time; Nov 1 -> Nov 2 midnight is standard time.
    expect(bidClosesAt({ bidDeadline: "2026-10-31" }, "CA")).toBe(Date.parse("2026-11-01T07:00:00Z"));
    expect(bidClosesAt({ bidDeadline: "2026-11-01" }, "CA")).toBe(Date.parse("2026-11-02T08:00:00Z"));
    expect(bidClosesAt({ bidDeadline: "2026-12-31" }, "HI")).toBe(Date.parse("2027-01-01T10:00:00Z"));
  });

  test("Arizona and Hawaii never shift", () => {
    expect(bidClosesAt({ bidDeadline: "2026-07-01", bidDueTime: "14:00" }, "AZ")).toBe(Date.parse("2026-07-01T21:00:00Z"));
    expect(bidClosesAt({ bidDeadline: "2026-12-01", bidDueTime: "14:00" }, "AZ")).toBe(Date.parse("2026-12-01T21:00:00Z"));
    expect(bidClosesAt({ bidDeadline: "2026-07-01", bidDueTime: "14:00" }, "HI")).toBe(Date.parse("2026-07-02T00:00:00Z"));
  });

  test("agrees with the tz database for every zone across two years", () => {
    for (const state of ["CA", "CO", "AZ", "TX", "NY", "AK", "HI"]) {
      const zone = bidZoneForState(state);
      for (let day = 0; day < 730; day += 3) {
        const date = new Date(Date.UTC(2026, 0, 1 + day));
        for (const [h, mi] of [[0, 0], [1, 30], [3, 0], [14, 0], [23, 59]]) {
          const ms = zonedWallTimeToUtc(zone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), h, mi);
          const expected = `${date.toISOString().slice(0, 10)}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
          expect(wallIn(zone.iana, ms), `${state} ${expected}`).toBe(expected);
        }
      }
    }
  });

  test("bidding is open until the due instant and closed from it on", () => {
    const pkg = { bidDeadline: "2026-10-30", bidDueTime: "14:00" };
    const due = Date.parse("2026-10-30T21:00:00Z");
    expect(bidDueHasPassed(pkg, "CA", due - 1)).toBe(false);
    expect(bidDueHasPassed(pkg, "CA", due)).toBe(true);
    expect(bidDueHasPassed({ bidDeadline: "not a date" }, "CA", due)).toBe(false);
  });
});
