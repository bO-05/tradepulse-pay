import { describe, expect, test } from "vitest";
import {
  QUICK_START_PROGRESS_MAX_AGE_MS,
  QUICK_START_PROGRESS_VERSION,
  clearAllQuickStartProgress,
  clearQuickStartProgress,
  emptyQuickStartProgress,
  quickStartCreated,
  quickStartProgressKey,
  quickStartResumeText,
  quickStartSavedAgo,
  quickStartStepLock,
  readQuickStartProgress,
  writeQuickStartProgress,
} from "./quickStartProgress";

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";

type MemoryStorage = {
  map: Map<string, string>;
  failWrites: boolean;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

function memoryStorage(): MemoryStorage {
  const storage: MemoryStorage = {
    map: new Map<string, string>(),
    failWrites: false,
    getItem: (key) => storage.map.get(key) ?? null,
    setItem: (key, value) => {
      if (storage.failWrites) throw new Error("QuotaExceededError");
      storage.map.set(key, value);
    },
    removeItem: (key) => {
      storage.map.delete(key);
    },
  };
  return storage;
}

function savedDraft(overrides: Partial<ReturnType<typeof emptyQuickStartProgress>> = {}) {
  return {
    ...emptyQuickStartProgress(COMPANY, 1_000),
    form: { ...emptyQuickStartProgress(COMPANY).form, title: "Lopez kitchen", contractValueCents: 4_500_000 },
    sub: { companyName: "Eastbay Electric", contactName: "Nora Patel", email: "nora@eastbay.test", csiDivision: "26 00 00", phone: "", licenseNumber: "C10-1" },
    rows: [
      { id: "row-1", description: "Rough-in", amountCents: 2_200_000 },
      { id: "row-2", description: "Trim-out", amountCents: 1_950_000 },
      { id: "row-3", description: "Closeout", amountCents: 350_000 },
    ],
    ...overrides,
  };
}

const LONG_ID = "jd79qzxzf56nr2jgnvgnr92jxh8hckgq";

describe("quick start progress storage", () => {
  test("round-trips the draft for the same company", () => {
    const storage = memoryStorage();
    const draft = savedDraft({ step: 3, ids: { projectId: LONG_ID }, done: ["project", "package", "sub", "bid"], inviteCreated: false });
    expect(writeQuickStartProgress(draft, { storage })).toBe(true);
    const read = readQuickStartProgress(COMPANY, { storage, now: 2_000 });
    expect(read).toEqual(draft);
  });

  test("keeps drafts per company and ignores another company's entry", () => {
    const storage = memoryStorage();
    writeQuickStartProgress(savedDraft(), { storage });
    expect(readQuickStartProgress(OTHER_COMPANY, { storage })).toBeNull();
    expect(storage.map.has(quickStartProgressKey(COMPANY))).toBe(true);
  });

  test("drops a draft whose stored company id does not match its key", () => {
    const storage = memoryStorage();
    const key = quickStartProgressKey(COMPANY);
    storage.map.set(key, JSON.stringify(savedDraft({ companyId: OTHER_COMPANY })));
    expect(readQuickStartProgress(COMPANY, { storage })).toBeNull();
    expect(storage.map.has(key)).toBe(false);
  });

  test("expires a draft after half a day", () => {
    const storage = memoryStorage();
    writeQuickStartProgress(savedDraft({ savedAt: 1_000 }), { storage });
    const stillFresh = readQuickStartProgress(COMPANY, { storage, now: 1_000 + QUICK_START_PROGRESS_MAX_AGE_MS - 1 });
    expect(stillFresh).not.toBeNull();
    expect(readQuickStartProgress(COMPANY, { storage, now: 1_000 + QUICK_START_PROGRESS_MAX_AGE_MS + 1 })).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  test("rejects corrupt JSON, a future timestamp, another version and a step outside 1-4", () => {
    const cases = [
      "{not json",
      JSON.stringify({ ...savedDraft(), savedAt: 500_000 }),
      JSON.stringify({ ...savedDraft(), version: 99 }),
      JSON.stringify({ ...savedDraft(), step: 5 }),
      JSON.stringify([savedDraft()]),
    ];
    for (const raw of cases) {
      const storage = memoryStorage();
      storage.map.set(quickStartProgressKey(COMPANY), raw);
      expect(readQuickStartProgress(COMPANY, { storage, now: 1_000 }), raw).toBeNull();
      expect(storage.map.size, raw).toBe(0);
    }
  });

  test("drops document ids that are not Convex ids and repairs a broken SOV list", () => {
    const storage = memoryStorage();
    storage.map.set(
      quickStartProgressKey(COMPANY),
      JSON.stringify({
        ...savedDraft(),
        ids: { projectId: "not an id", tradePackageId: "SELECT * FROM projects", agreementId: LONG_ID },
        rows: [{ id: "", description: 42, amountCents: "12" }, "junk", { id: "keep", description: "Trim", amountCents: 100_000 }],
        done: ["project", "nonsense", "project"],
      }),
    );
    const read = readQuickStartProgress(COMPANY, { storage, now: 1_000 });
    expect(read?.ids).toEqual({ agreementId: LONG_ID });
    expect(read?.rows.map((row) => [row.description, row.amountCents])).toEqual([["", null], ["Trim", 100_000]]);
    expect(read?.rows.every((row) => row.id.length > 0)).toBe(true);
    expect(read?.done).toEqual(["project"]);
  });

  test("falls back to three empty SOV rows when none survive validation", () => {
    const storage = memoryStorage();
    storage.map.set(quickStartProgressKey(COMPANY), JSON.stringify({ ...savedDraft(), rows: "nope" }));
    const read = readQuickStartProgress(COMPANY, { storage, now: 1_000 });
    expect(read?.rows).toHaveLength(3);
    expect(read?.rows.every((row) => row.amountCents === null)).toBe(true);
  });

  test("never throws when storage refuses the write or is unavailable", () => {
    const storage = memoryStorage();
    storage.failWrites = true;
    expect(writeQuickStartProgress(savedDraft(), { storage })).toBe(false);
    expect(writeQuickStartProgress(savedDraft(), { storage: null })).toBe(false);
    expect(clearQuickStartProgress(COMPANY, { storage: null })).toBe(false);
    expect(readQuickStartProgress(COMPANY, { storage: null })).toBeNull();
  });

  test("clear removes only the current company's draft", () => {
    const storage = memoryStorage();
    writeQuickStartProgress(savedDraft(), { storage });
    writeQuickStartProgress(savedDraft({ companyId: OTHER_COMPANY }), { storage });
    expect(clearQuickStartProgress(COMPANY, { storage })).toBe(true);
    expect(storage.map.has(quickStartProgressKey(COMPANY))).toBe(false);
    expect(storage.map.has(quickStartProgressKey(OTHER_COMPANY))).toBe(true);
  });

  test("sign-out clears every company's draft and nothing else", () => {
    const storage = memoryStorage();
    writeQuickStartProgress(savedDraft(), { storage });
    writeQuickStartProgress(savedDraft({ companyId: OTHER_COMPANY }), { storage });
    storage.map.set("tradepulse.selectedProjectId", "keep-out-of-this-helper");
    storage.map.set("other.app", "keep");
    const sweepable = {
      ...storage,
      get length() {
        return storage.map.size;
      },
      key: (index: number) => [...storage.map.keys()][index] ?? null,
    };
    expect(clearAllQuickStartProgress({ storage: sweepable })).toBe(2);
    expect([...storage.map.keys()]).toEqual(["tradepulse.selectedProjectId", "other.app"]);
    expect(clearAllQuickStartProgress({ storage: null })).toBe(0);
  });
});

describe("quick start resume copy", () => {
  test("counts created records from ids and from completed steps", () => {
    const created = quickStartCreated({
      ids: { projectId: LONG_ID, bidId: "b".repeat(32) },
      done: ["sub", "sov"],
      inviteCreated: false,
    });
    expect(created).toEqual(["project", "sub", "bid", "sov"]);
  });

  test("names what already exists and when the draft was saved", () => {
    const text = quickStartResumeText(
      { savedAt: 0, ids: { projectId: LONG_ID }, done: ["project", "package"], inviteCreated: false },
      5 * 60_000,
    );
    expect(text).toBe("Restored a draft saved 5 minutes ago. Already created: the job and the trade package. Retry continues where it stopped.");
  });

  test("says nothing was created for an untouched draft", () => {
    const text = quickStartResumeText({ savedAt: 0, ids: {}, done: [], inviteCreated: false }, 30_000);
    expect(text).toBe("Restored a draft saved just now. Nothing has been created yet.");
  });

  test("formats the age in minutes and hours", () => {
    expect(quickStartSavedAgo(0, 59_000)).toBe("just now");
    expect(quickStartSavedAgo(0, 60_000)).toBe("1 minute ago");
    expect(quickStartSavedAgo(0, 59 * 60_000)).toBe("59 minutes ago");
    expect(quickStartSavedAgo(0, 3 * 60 * 60_000)).toBe("3 hours ago");
  });
});

describe("quick start step locks", () => {
  test("locks the job step once a project exists", () => {
    expect(quickStartStepLock(1, { ids: {}, done: [] })).toBeNull();
    expect(quickStartStepLock(1, { ids: { projectId: LONG_ID }, done: [] })).toMatch(/Project settings/);
  });

  test("locks the sub step once the vendor or bidder exists", () => {
    expect(quickStartStepLock(2, { ids: { vendorId: LONG_ID }, done: [] })).toMatch(/People/);
    expect(quickStartStepLock(2, { ids: { contractorId: LONG_ID }, done: [] })).toMatch(/People/);
    expect(quickStartStepLock(2, { ids: { projectId: LONG_ID }, done: [] })).toBeNull();
  });

  test("locks the SOV step only after the SOV is approved", () => {
    expect(quickStartStepLock(3, { ids: { agreementId: LONG_ID }, done: [] })).toBeNull();
    expect(quickStartStepLock(3, { ids: { agreementId: LONG_ID }, done: ["sov"] })).toMatch(/cannot change here/);
  });

  test("never locks the review step", () => {
    expect(quickStartStepLock(4, { ids: { projectId: LONG_ID }, done: ["sov", "execute"] })).toBeNull();
  });
});

test("the saved schema version is part of the storage contract", () => {
  expect(QUICK_START_PROGRESS_VERSION).toBe(1);
  expect(quickStartProgressKey(COMPANY)).toBe(`tradepulse.quickStart.v1.${COMPANY}`);
});
