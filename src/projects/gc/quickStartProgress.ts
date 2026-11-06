import { EMPTY_PROJECT_SETUP, type ProjectSetupFormState } from "./projectSetupForm";
import {
  QUICK_START_MAX_LINES,
  emptyQuickStartRows,
  newQuickStartRow,
  type QuickStartSovRow,
  type QuickStartSub,
} from "./quickStartPlan";

/**
 * Persisted progress for the GC Quick start wizard.
 *
 * The wizard creates a job, a trade package, a sub, a bid, a subcontract and an approved SOV, then
 * invites the sub. Its ids used to live only in component memory, so a reload lost the retry path and
 * a resumed run re-imported an SOV that was already approved. This module keeps the draft (fields,
 * SOV rows, created ids and completed steps) in localStorage under a per-company, versioned key for
 * at most half a day. It never stores an invite link, a password or any other secret.
 *
 * Pure: no React and no Convex imports, so the rules can be tested directly.
 */

export const QUICK_START_PROGRESS_VERSION = 1 as const;
export const QUICK_START_PROGRESS_PREFIX = "tradepulse.quickStart.v1";
export const QUICK_START_PROGRESS_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60_000;
const MAX_ROWS = QUICK_START_MAX_LINES + 8;

export type QuickStartDoneKey = "project" | "package" | "sub" | "bid" | "agreement" | "sov" | "execute" | "invite";
export type QuickStartSavedStep = 1 | 2 | 3 | 4;

export type QuickStartSavedIds = {
  projectId?: string;
  tradePackageId?: string;
  vendorId?: string;
  contractorId?: string;
  bidId?: string;
  agreementId?: string;
};

export type QuickStartProgress = {
  version: typeof QUICK_START_PROGRESS_VERSION;
  companyId: string;
  savedAt: number;
  step: QuickStartSavedStep;
  form: ProjectSetupFormState;
  sub: QuickStartSub;
  rows: QuickStartSovRow[];
  sendEmail: boolean;
  done: QuickStartDoneKey[];
  ids: QuickStartSavedIds;
  inviteCreated: boolean;
};

/** The facts the resume banner and the step locks need, without the whole draft. */
export type QuickStartResumeFacts = {
  savedAt: number;
  ids: QuickStartSavedIds;
  done: QuickStartDoneKey[];
  inviteCreated: boolean;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem"> & {
  readonly length?: number;
  key?: (index: number) => string | null;
};

const DONE_KEYS: readonly QuickStartDoneKey[] = ["project", "package", "sub", "bid", "agreement", "sov", "execute", "invite"];
const ID_KEYS = ["projectId", "tradePackageId", "vendorId", "contractorId", "bidId", "agreementId"] as const;
/** Convex document ids are lowercase alphanumerics; anything else is not worth restoring. */
const ID_PATTERN = /^[a-z0-9]{16,64}$/;

export const QUICK_START_CREATED_LABELS: Record<QuickStartDoneKey, string> = {
  project: "the job",
  package: "the trade package",
  sub: "the sub",
  bid: "the subcontract bid",
  agreement: "the subcontract",
  sov: "the approved SOV",
  execute: "the GC's execution record",
  invite: "the sub invite",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function cents(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function isDoneKey(value: unknown): value is QuickStartDoneKey {
  return typeof value === "string" && (DONE_KEYS as readonly string[]).includes(value);
}

function isSavedStep(value: unknown): value is QuickStartSavedStep {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function browserStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    // A browser with storage disabled (or a sandboxed iframe) throws on access.
    return null;
  }
}

export function quickStartProgressKey(companyId: string): string {
  return `${QUICK_START_PROGRESS_PREFIX}.${companyId}`;
}

function normalizeForm(value: Record<string, unknown>): ProjectSetupFormState {
  return {
    title: text(value.title),
    ownerName: text(value.ownerName),
    line1: text(value.line1),
    city: text(value.city),
    state: text(value.state),
    zip: text(value.zip),
    contractValueCents: cents(value.contractValueCents),
    retainageBps: cents(value.retainageBps),
    retainageTouched: value.retainageTouched === true,
    billingDay: text(value.billingDay),
    startDate: text(value.startDate),
    substantialCompletionDate: text(value.substantialCompletionDate),
  };
}

function normalizeSub(value: Record<string, unknown>): QuickStartSub {
  return {
    companyName: text(value.companyName),
    contactName: text(value.contactName),
    email: text(value.email),
    csiDivision: text(value.csiDivision),
    phone: text(value.phone),
    licenseNumber: text(value.licenseNumber),
  };
}

function normalizeRows(value: unknown[]): QuickStartSovRow[] {
  const rows: QuickStartSovRow[] = [];
  for (const entry of value.slice(0, MAX_ROWS)) {
    if (!isRecord(entry)) continue;
    rows.push({
      id: text(entry.id) || newQuickStartRow().id,
      description: text(entry.description),
      amountCents: cents(entry.amountCents),
    });
  }
  return rows;
}

function normalizeIds(value: Record<string, unknown>): QuickStartSavedIds {
  const ids: QuickStartSavedIds = {};
  for (const key of ID_KEYS) {
    const id = value[key];
    if (typeof id === "string" && ID_PATTERN.test(id)) ids[key] = id;
  }
  return ids;
}

export const QUICK_START_EMPTY_SUB: QuickStartSub = {
  companyName: "",
  contactName: "",
  email: "",
  csiDivision: "26 00 00",
  phone: "",
  licenseNumber: "",
};

export function emptyQuickStartProgress(companyId: string, now = Date.now()): QuickStartProgress {
  return {
    version: QUICK_START_PROGRESS_VERSION,
    companyId,
    savedAt: now,
    step: 1,
    form: EMPTY_PROJECT_SETUP,
    sub: QUICK_START_EMPTY_SUB,
    rows: emptyQuickStartRows(),
    sendEmail: true,
    done: [],
    ids: {},
    inviteCreated: false,
  };
}

/** Reads a saved draft, dropping it when it is corrupt, expired or belongs to another company. */
export function readQuickStartProgress(
  companyId: string,
  options: { storage?: StorageLike | null; now?: number } = {},
): QuickStartProgress | null {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  if (!storage || companyId === "") return null;
  const key = quickStartProgressKey(companyId);
  const drop = () => {
    try {
      storage.removeItem(key);
    } catch {
      // An unreadable storage is the same as no draft.
    }
    return null;
  };
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return drop();
  }
  if (!isRecord(parsed)) return drop();
  if (parsed.version !== QUICK_START_PROGRESS_VERSION) return drop();
  if (parsed.companyId !== companyId) return drop();
  const now = options.now ?? Date.now();
  const savedAt = typeof parsed.savedAt === "number" && Number.isFinite(parsed.savedAt) ? parsed.savedAt : 0;
  if (savedAt <= 0) return drop();
  if (now - savedAt > QUICK_START_PROGRESS_MAX_AGE_MS) return drop();
  if (savedAt - now > CLOCK_SKEW_MS) return drop();
  if (!isSavedStep(parsed.step)) return drop();
  if (!isRecord(parsed.form) || !isRecord(parsed.sub)) return drop();
  const rows = Array.isArray(parsed.rows) ? normalizeRows(parsed.rows) : [];
  const done = Array.isArray(parsed.done) ? [...new Set(parsed.done.filter(isDoneKey))] : [];
  return {
    version: QUICK_START_PROGRESS_VERSION,
    companyId,
    savedAt,
    step: parsed.step,
    form: normalizeForm(parsed.form),
    sub: normalizeSub(parsed.sub),
    rows: rows.length > 0 ? rows : emptyQuickStartRows(),
    sendEmail: parsed.sendEmail !== false,
    done,
    ids: isRecord(parsed.ids) ? normalizeIds(parsed.ids) : {},
    inviteCreated: parsed.inviteCreated === true,
  };
}

/** Writes the draft. Returns false instead of throwing when storage is full, blocked or absent. */
export function writeQuickStartProgress(
  progress: QuickStartProgress,
  options: { storage?: StorageLike | null } = {},
): boolean {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  if (!storage || progress.companyId === "") return false;
  try {
    storage.setItem(quickStartProgressKey(progress.companyId), JSON.stringify(progress));
    return true;
  } catch {
    return false;
  }
}

export function clearQuickStartProgress(
  companyId: string,
  options: { storage?: StorageLike | null } = {},
): boolean {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  if (!storage || companyId === "") return false;
  try {
    storage.removeItem(quickStartProgressKey(companyId));
    return true;
  } catch {
    return false;
  }
}

/** Removes every saved draft in this browser (all companies). Used on sign-out. */
export function clearAllQuickStartProgress(options: { storage?: StorageLike | null } = {}): number {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  if (!storage || typeof storage.length !== "number" || typeof storage.key !== "function") return 0;
  let removed = 0;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && key.startsWith(`${QUICK_START_PROGRESS_PREFIX}.`)) keys.push(key);
    }
    for (const key of keys) {
      storage.removeItem(key);
      removed += 1;
    }
  } catch {
    // An unreadable storage keeps no draft we could clean up.
  }
  return removed;
}

/** Steps whose record already exists, from the created ids and the completed-step log. */
export function quickStartCreated(facts: Pick<QuickStartResumeFacts, "ids" | "done" | "inviteCreated">): QuickStartDoneKey[] {
  return DONE_KEYS.filter((key) => {
    const idKey = ID_KEY_FOR[key];
    if (idKey && facts.ids[idKey]) return true;
    if (key === "invite") return facts.inviteCreated || facts.done.includes("invite");
    return facts.done.includes(key);
  });
}

/** Only the first five steps are proven by an id; the SOV, execution and invite are recorded steps. */
const ID_KEY_FOR: Record<QuickStartDoneKey, keyof QuickStartSavedIds | null> = {
  project: "projectId",
  package: "tradePackageId",
  sub: "vendorId",
  bid: "bidId",
  agreement: "agreementId",
  sov: null,
  execute: null,
  invite: null,
};

export function quickStartSavedAgo(savedAt: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - savedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

function listSentence(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Banner copy for a restored draft. */
export function quickStartResumeText(facts: QuickStartResumeFacts, now = Date.now()): string {
  const created = quickStartCreated(facts);
  const ago = quickStartSavedAgo(facts.savedAt, now);
  if (created.length === 0) return `Restored a draft saved ${ago}. Nothing has been created yet.`;
  return `Restored a draft saved ${ago}. Already created: ${listSentence(created.map((key) => QUICK_START_CREATED_LABELS[key]))}. Retry continues where it stopped.`;
}

/**
 * Why a step can no longer be edited, or null when it can.
 *
 * After a step creates its record, editing the wizard fields cannot change that record, and a resume
 * would silently ignore the edit. The wizard shows this reason instead of pretending the fields work.
 */
export function quickStartStepLock(
  step: QuickStartSavedStep,
  facts: Pick<QuickStartResumeFacts, "ids" | "done">,
): string | null {
  if (step === 1 && facts.ids.projectId) {
    return "The job is already created. Change its details in Project settings; this wizard creates a job once.";
  }
  if (step === 2 && (facts.ids.vendorId || facts.ids.contractorId)) {
    return "The sub and its bid are already on this job. Edit the vendor in People, or start over to use a different sub.";
  }
  if (step === 3 && facts.done.includes("sov")) {
    return "The schedule of values is approved and the subcontract records the GC's execution. These lines cannot change here; start over to use different lines, or review the SOV.";
  }
  return null;
}
