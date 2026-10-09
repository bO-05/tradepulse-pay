/**
 * Bid due date and time of a trade package. The GC enters a calendar date and an optional wall-clock
 * time in the project's time zone; a blank time means end of that day. The zone is recorded with the
 * time so the closing instant never shifts if the project's state is edited later.
 */

export interface BidZone {
  iana: string;
  /** Short label shown everywhere a due date is shown, e.g. "PT". */
  abbr: string;
  /** Standard-time offset from UTC in minutes (Pacific = -480). */
  standardOffsetMinutes: number;
  observesDst: boolean;
}

const PACIFIC: BidZone = { iana: "America/Los_Angeles", abbr: "PT", standardOffsetMinutes: -480, observesDst: true };
const MOUNTAIN: BidZone = { iana: "America/Denver", abbr: "MT", standardOffsetMinutes: -420, observesDst: true };
const ARIZONA: BidZone = { iana: "America/Phoenix", abbr: "MST", standardOffsetMinutes: -420, observesDst: false };
const CENTRAL: BidZone = { iana: "America/Chicago", abbr: "CT", standardOffsetMinutes: -360, observesDst: true };
const EASTERN: BidZone = { iana: "America/New_York", abbr: "ET", standardOffsetMinutes: -300, observesDst: true };
const ALASKA: BidZone = { iana: "America/Anchorage", abbr: "AKT", standardOffsetMinutes: -540, observesDst: true };
const HAWAII: BidZone = { iana: "Pacific/Honolulu", abbr: "HT", standardOffsetMinutes: -600, observesDst: false };

const ZONES = [PACIFIC, MOUNTAIN, ARIZONA, CENTRAL, EASTERN, ALASKA, HAWAII];

const ZONE_BY_STATE: Record<string, BidZone> = {
  CA: PACIFIC, NV: PACIFIC, OR: PACIFIC, WA: PACIFIC,
  AZ: ARIZONA,
  CO: MOUNTAIN, ID: MOUNTAIN, MT: MOUNTAIN, NM: MOUNTAIN, UT: MOUNTAIN, WY: MOUNTAIN,
  AL: CENTRAL, AR: CENTRAL, IA: CENTRAL, IL: CENTRAL, KS: CENTRAL, LA: CENTRAL, MN: CENTRAL, MO: CENTRAL,
  MS: CENTRAL, ND: CENTRAL, NE: CENTRAL, OK: CENTRAL, SD: CENTRAL, TN: CENTRAL, TX: CENTRAL, WI: CENTRAL,
  AK: ALASKA, HI: HAWAII,
};

/** The project's time zone from its 2-letter state; unknown states fall back to Eastern. */
export function bidZoneForState(state: string | undefined): BidZone {
  return ZONE_BY_STATE[(state ?? "").trim().toUpperCase()] ?? EASTERN;
}

export function bidZoneByIana(iana: string | undefined): BidZone | null {
  return ZONES.find((z) => z.iana === iana) ?? null;
}

export interface BidDueFields {
  /** `YYYY-MM-DD`. Older rows may carry `YYYY-MM-DDTHH:MM` here instead of a separate time. */
  bidDeadline: string;
  /** `HH:MM`, 24-hour wall time in `bidDueTimeZone`. */
  bidDueTime?: string;
  bidDueTimeZone?: string;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "" or undefined means end of day. Accepts `HH:MM` (24-hour); throws a readable message otherwise. */
export function parseBidDueTime(value: string | undefined): string | undefined {
  const raw = (value ?? "").trim();
  if (raw === "") return undefined;
  if (!TIME_PATTERN.test(raw)) throw new Error("Bid due time must be a time like 14:00.");
  return raw;
}

type Parts = { y: number; mo: number; d: number; time: { h: number; mi: number } | null };

function dueParts(fields: BidDueFields): Parts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(fields.bidDeadline.trim());
  if (!m) return null;
  const separate = fields.bidDueTime ? TIME_PATTERN.exec(fields.bidDueTime.trim()) : null;
  const h = separate ? separate[1] : m[4];
  const mi = separate ? separate[2] : m[5];
  return {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    time: h !== undefined && mi !== undefined ? { h: Number(h), mi: Number(mi) } : null,
  };
}

function zoneOf(fields: BidDueFields, state: string | undefined): BidZone {
  return bidZoneByIana(fields.bidDueTimeZone) ?? bidZoneForState(state);
}

/** Day of month of the nth Sunday of a month (month is 0-based). */
function nthSunday(year: number, month: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
}

/**
 * UTC instant of a wall-clock time in a US zone, using the US DST rule (second Sunday of March to the
 * first Sunday of November, switching at 2:00 local). A wall time skipped by the spring change reads
 * as standard time (2:30 becomes 3:30 daylight); the repeated hour in the fall reads as its first,
 * daylight occurrence.
 */
export function zonedWallTimeToUtc(zone: BidZone, y: number, mo: number, d: number, h: number, mi: number): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const std = zone.standardOffsetMinutes * 60_000;
  const asStandard = wall - std;
  if (!zone.observesDst) return asStandard;
  const dstStart = Date.UTC(y, 2, nthSunday(y, 2, 2), 2) - std;
  const dstEnd = Date.UTC(y, 10, nthSunday(y, 10, 1), 2) - std - 3_600_000;
  const asDaylight = wall - std - 3_600_000;
  return asDaylight >= dstStart && asDaylight < dstEnd ? asDaylight : asStandard;
}

/** The instant bidding closes: the due time, or the start of the next local day when no time is set. Null when the date is unreadable. */
export function bidClosesAt(fields: BidDueFields, state: string | undefined): number | null {
  const p = dueParts(fields);
  if (!p) return null;
  const zone = zoneOf(fields, state);
  if (p.time) return zonedWallTimeToUtc(zone, p.y, p.mo, p.d, p.time.h, p.time.mi);
  const next = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
  return zonedWallTimeToUtc(zone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0);
}

/** True once the due instant has passed. */
export function bidDueHasPassed(fields: BidDueFields, state: string | undefined, now: number): boolean {
  const closes = bidClosesAt(fields, state);
  return closes !== null && now >= closes;
}

/** "Oct 30, 2026, 2:00 PM PT"; with no time set, "Oct 30, 2026, end of day PT". */
export function formatBidDue(fields: BidDueFields | string, state: string | undefined): string {
  const f = typeof fields === "string" ? { bidDeadline: fields } : fields;
  const zone = zoneOf(f, state);
  const p = dueParts(f);
  const raw = f.bidDeadline.trim();
  if (!p) return raw ? `${raw} ${zone.abbr}` : `not set`;
  const day = new Date(Date.UTC(p.y, p.mo - 1, p.d, 12)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  if (!p.time) return `${day}, end of day ${zone.abbr}`;
  const { h, mi } = p.time;
  return `${day}, ${h % 12 === 0 ? 12 : h % 12}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} ${zone.abbr}`;
}

type ProjectPlace = { state?: string; address?: { state?: string }; location?: string } | null | undefined;

/** The state whose time zone governs the project's bid due times; legacy rows fall back to "…, City, ST 12345" in `location`. */
export function projectStateOf(project: ProjectPlace): string | undefined {
  const stored = project?.state?.trim() || project?.address?.state?.trim();
  if (stored) return stored;
  return /,\s*([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/.exec(project?.location ?? "")?.[1]?.toUpperCase();
}

/** Display label and closing instant of a package, as every view shows them. */
export function packageDue(pkg: BidDueFields, project: ProjectPlace): { dueLabel: string; bidClosesAt: number | null } {
  const state = projectStateOf(project);
  return { dueLabel: formatBidDue(pkg, state), bidClosesAt: bidClosesAt(pkg, state) };
}

/** The message a bidder sees once the due instant has passed. */
export function bidDuePassedMessage(fields: BidDueFields, state: string | undefined): string {
  return `Bidding on this package is closed: bids were due ${formatBidDue(fields, state)}.`;
}
