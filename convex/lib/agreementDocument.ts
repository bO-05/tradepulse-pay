/**
 * Server side of per-agreement terms: resolves an agreement's terms (stored, or derived for legacy
 * rows), and renders and stores the subcontract text from the agreement, its project and terms.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { US_STATES } from "./companyProfile";
import { fromDollars } from "./money";
import {
  DEFAULT_INSURANCE,
  DEFAULT_PAYMENT_TERMS,
  DEFAULT_WARRANTY_MONTHS,
  defaultAgreementTerms,
  type AgreementTerms,
  type TermsContext,
} from "./agreementTerms";
import { buildSubcontractText } from "./subcontractText";
import { venueFor } from "./venue";
import { generalContractorNameFor } from "./gcCompanyName";

type Ctx = Pick<QueryCtx, "db">;

/** "Oct 8, 2026" in UTC; the server cannot know the reader's time zone. */
function formatUtcDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

const STATE_BY_NAME = new Map(US_STATES.map((s) => [s.name.toUpperCase(), s.code]));
const STATE_CODES = new Set(US_STATES.map((s) => s.code));

function stateCodeFrom(text: string | undefined): string | null {
  if (!text) return null;
  const cleaned = text.replace(/\b\d{5}(-\d{4})?\b/g, "").trim().toUpperCase();
  if (STATE_CODES.has(cleaned)) return cleaned;
  if (STATE_BY_NAME.has(cleaned)) return STATE_BY_NAME.get(cleaned)!;
  const token = cleaned.split(/\s+/)[0];
  return STATE_CODES.has(token) ? token : null;
}

/** City, state code and printable address of a project; legacy rows fall back to `location`. */
export function projectPlace(project: Doc<"projects">): { city: string | null; state: string | null; address: string } {
  const a = project.address;
  const state = (project.state ?? a?.state ?? "").trim().toUpperCase() || null;
  if (a && a.line1.trim() && a.city.trim()) {
    const line2 = a.line2?.trim() ? `, ${a.line2.trim()}` : "";
    const st = state ?? a.state.trim().toUpperCase();
    return { city: a.city.trim(), state, address: `${a.line1.trim()}${line2}, ${a.city.trim()}, ${st} ${a.zip.trim()}`.trim() };
  }
  const parts = (project.location ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // "Street, City, ST 12345" or "City, ST": the state is the last segment and the city precedes it.
  const city = parts.length > 1 ? parts[parts.length - 2] : null;
  return {
    city,
    state: state ?? stateCodeFrom(parts[parts.length - 1]),
    address: project.location?.trim() || "[Project address to be completed]",
  };
}

async function gcCompanyDefaultBps(ctx: Ctx, project: Doc<"projects">): Promise<number | null> {
  if (!project.gcCompanyId) return null;
  const company = await ctx.db.get(project.gcCompanyId);
  return company?.defaultRetainageBps ?? null;
}

/** Defaults for a new agreement: the project's retainage and state, then the GC company default. */
export async function defaultTermsForProject(ctx: Ctx, project: Doc<"projects">, contractSumCents: number): Promise<AgreementTerms> {
  return defaultAgreementTerms({
    projectState: projectPlace(project).state,
    projectRetainageBps: project.retainageBps ?? null,
    companyDefaultRetainageBps: await gcCompanyDefaultBps(ctx, project),
    contractSumCents,
  });
}

/** Stored terms, or terms derived from a legacy row's retainage/LD fields plus standard defaults. */
export function resolveAgreementTerms(agreement: Doc<"agreements">, project: Doc<"projects">): AgreementTerms {
  if (agreement.terms) return agreement.terms;
  const pct = agreement.retainagePercent;
  const terms: AgreementTerms = {
    retainageBps: Number.isFinite(pct) && pct >= 0 && pct <= 100 ? Math.round(pct * 100) : 1000,
    paymentTerms: { ...DEFAULT_PAYMENT_TERMS },
    insurance: { ...DEFAULT_INSURANCE },
    warrantyMonths: DEFAULT_WARRANTY_MONTHS,
    governingState: projectPlace(project).state ?? "",
  };
  if (agreement.liquidatedDamagesDaily > 0) terms.liquidatedDamagesCentsPerDay = fromDollars(agreement.liquidatedDamagesDaily);
  return terms;
}

function isOpenDraft(agreement: Doc<"agreements">): boolean {
  return agreement.status !== "executed" && agreement.status !== "superseded";
}

/**
 * Drafts saved before the provenance flag existed have no flag. A stored governing state that differs
 * from the project's current state can only have been chosen by the GC, so it counts as explicit.
 * New drafts are flagged when first rendered, and project edits classify unflagged drafts before the
 * state changes, so this inference only ever applies to rows written before the flag existed.
 */
export function isGoverningStateExplicit(agreement: Doc<"agreements">, project: Doc<"projects">): boolean {
  if (agreement.governingStateExplicit !== undefined) return agreement.governingStateExplicit;
  const stored = agreement.terms?.governingState;
  return !!stored && stored !== projectPlace(project).state;
}

/** Records the inferred provenance on unflagged open drafts of a project; returns how many were set. */
export async function classifyUnflaggedDrafts(
  ctx: Pick<MutationCtx, "db">,
  project: Doc<"projects">,
): Promise<number> {
  const agreements = await ctx.db
    .query("agreements")
    .withIndex("by_project", (q) => q.eq("projectId", project._id))
    .collect();
  let classified = 0;
  for (const agreement of agreements) {
    if (agreement.governingStateExplicit !== undefined || !isOpenDraft(agreement)) continue;
    await ctx.db.patch(agreement._id, { governingStateExplicit: isGoverningStateExplicit(agreement, project) });
    classified += 1;
  }
  return classified;
}

/**
 * A draft's governing state is the project default unless the GC chose another one, so a corrected
 * project state carries into the draft. Executed and superseded agreements keep what they recorded.
 */
export function reconcileDraftGoverningState(
  agreement: Doc<"agreements">,
  project: Doc<"projects">,
  terms: AgreementTerms,
): AgreementTerms {
  if (agreement.status === "executed" || agreement.status === "superseded") return terms;
  if (isGoverningStateExplicit(agreement, project)) return terms;
  const state = projectPlace(project).state;
  if (!state || state === terms.governingState) return terms;
  return { ...terms, governingState: state };
}

/** Terms as a draft should be shown, validated and executed against the project now. */
export function currentDraftTerms(agreement: Doc<"agreements">, project: Doc<"projects">): AgreementTerms {
  return reconcileDraftGoverningState(agreement, project, resolveAgreementTerms(agreement, project));
}

export function contractSumCentsOf(agreement: Pick<Doc<"agreements">, "contractSum" | "contractSumCents">): number {
  if (typeof agreement.contractSumCents === "number" && Number.isSafeInteger(agreement.contractSumCents)) return Math.max(0, agreement.contractSumCents);
  return fromDollars(Math.max(0, agreement.contractSum));
}

export function termsContextFor(agreement: Doc<"agreements">, project: Doc<"projects">): TermsContext {
  return {
    projectState: projectPlace(project).state,
    contractSumCents: contractSumCentsOf(agreement),
    primeRetainageBps: project.retainageBps ?? null,
  };
}

/** Legacy mirrors of the terms, kept so every existing reader agrees with the stored terms. */
export function legacyTermFields(terms: AgreementTerms): { retainagePercent: number; liquidatedDamagesDaily: number } {
  return {
    retainagePercent: terms.retainageBps / 100,
    liquidatedDamagesDaily: (terms.liquidatedDamagesCentsPerDay ?? 0) / 100,
  };
}

async function licenseLineFor(ctx: Ctx, contractor: Doc<"contractors"> | null): Promise<string> {
  const number = contractor?.licenseNumber?.trim() ?? "";
  if (!contractor || !number || number === "0" || /^not verified$/i.test(number)) {
    return "[License number to be completed]";
  }
  const checks = await ctx.db
    .query("licenseChecks")
    .withIndex("by_contractorId_and_licenseNumber_and_checkedAt", (q) =>
      q.eq("contractorId", contractor._id).eq("licenseNumber", number),
    )
    .order("desc")
    .take(5);
  const done = checks.find((c) => c.phase !== "running" && c.cacheCleared !== true);
  if (done) return `${number} (CSLB lookup: ${done.status.replace(/_/g, " ")}, ${formatUtcDate(done.checkedAt)})`;
  return `${number} (license record on file; no registry lookup)`;
}

async function ownerNameFor(ctx: Ctx, project: Doc<"projects">): Promise<string> {
  const typed = project.ownerName?.trim();
  if (typed) return typed;
  if (project.ownerCompanyId) {
    const owner = await ctx.db.get(project.ownerCompanyId);
    if (owner?.name.trim()) return owner.name.trim();
  }
  return "[Owner to be completed]";
}

export async function renderAgreementText(
  ctx: Ctx,
  agreement: Doc<"agreements">,
  project: Doc<"projects">,
  terms: AgreementTerms,
): Promise<string> {
  const contractor = await ctx.db.get(agreement.contractorId);
  const place = projectPlace(project);
  const subName = contractor?.companyName.trim() || agreement.subcontractorName;
  return buildSubcontractText({
    agreementNumber: agreement.agreementNumber,
    formattedDate: `${formatUtcDate(agreement.createdAt)} (UTC)`,
    generalContractor: await generalContractorNameFor(ctx, project),
    subName,
    contactEmail: contractor?.contactEmail || agreement.subcontractorEmail || "[notice address to be completed]",
    licenseLine: await licenseLineFor(ctx, contractor),
    projectTitle: project.title,
    projectAddress: place.address,
    projectType: project.projectType,
    ownerName: await ownerNameFor(ctx, project),
    csiDivision: agreement.csiDivision,
    tradeName: agreement.tradeName,
    scopeSummary: agreement.scopeSummary,
    mandatoryInclusions: agreement.mandatoryInclusions,
    contractSumCents: contractSumCentsOf(agreement),
    ...(agreement.baseBidCents !== undefined
      ? {
          award: {
            baseBidCents: agreement.baseBidCents,
            acceptedAlternates: agreement.acceptedAlternates ?? [],
            declinedAlternates: agreement.declinedAlternates ?? [],
            veDeducts: agreement.veDeducts ?? [],
          },
        }
      : {}),
    ...(agreement.excludedScopeNotes !== undefined ? { excludedScopeNotes: agreement.excludedScopeNotes } : {}),
    terms,
    venue: venueFor(place.city, place.state),
  });
}

/** Stores the resolved terms, their legacy mirrors and freshly rendered subcontract text. */
export async function refreshAgreementDocument(
  ctx: Pick<MutationCtx, "db">,
  agreementId: Id<"agreements">,
  terms?: AgreementTerms,
): Promise<Doc<"agreements">> {
  const agreement = await ctx.db.get(agreementId);
  if (!agreement) throw new Error("Agreement not found");
  const project = await ctx.db.get(agreement.projectId);
  if (!project) throw new Error("Project not found");
  const resolved = terms ?? currentDraftTerms(agreement, project);
  const contractText = await renderAgreementText(ctx, agreement, project, resolved);
  const flag =
    agreement.governingStateExplicit === undefined && isOpenDraft(agreement)
      ? { governingStateExplicit: isGoverningStateExplicit(agreement, project) }
      : {};
  await ctx.db.patch(agreementId, { terms: resolved, ...legacyTermFields(resolved), contractText, ...flag });
  return (await ctx.db.get(agreementId))!;
}
