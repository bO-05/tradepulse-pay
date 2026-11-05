import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { auditActor, findDocScope, requireDocScope } from "../lib/projectScope";
import { notify } from "../lib/notify";
import { notFound } from "../lib/tenancy";
import { isReadOnlyReference } from "../lib/demoReference";

export const MAX_PAY_APP_QUESTION_LENGTH = 2_000;
const MIN_PAY_APP_QUESTION_LENGTH = 2;
const CLOSED_STATUSES = new Set(["draft", "withdrawn"]);

/** One person can post this many entries per pay app thread in a rolling window (and per day). */
export const QUESTION_RATE_WINDOW_MS = 10 * 60_000;
export const QUESTIONS_PER_WINDOW = 8;
export const QUESTIONS_PER_DAY = 40;

/** The notification carries a short excerpt; the thread holds the full text. */
export const NOTIFICATION_EXCERPT_CHARS = 160;

export function notificationExcerpt(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > NOTIFICATION_EXCERPT_CHARS ? `${oneLine.slice(0, NOTIFICATION_EXCERPT_CHARS - 1).trimEnd()}…` : oneLine;
}

const threadEntryValidator = v.object({
  _id: v.id("payAppThreadEntries"),
  authorRole: v.union(v.literal("gc"), v.literal("sub")),
  authorName: v.string(),
  body: v.string(),
  createdAt: v.number(),
});

const threadViewValidator = v.object({
  payAppId: v.id("payApplications"),
  applicationNo: v.union(v.number(), v.null()),
  periodLabel: v.string(),
  requestedTotalCents: v.number(),
  status: v.string(),
  viewerRole: v.union(v.literal("gc"), v.literal("sub")),
  counterpartyName: v.string(),
  canPost: v.boolean(),
  postingBlockedReason: v.union(v.string(), v.null()),
  entries: v.array(threadEntryValidator),
});

function labelOf(payApp: Doc<"payApplications">): string {
  return payApp.applicationNo == null ? payApp.periodLabel : `pay app #${payApp.applicationNo}`;
}

function postingBlockedReason(
  scope: Awaited<ReturnType<typeof requireDocScope>>,
  status: Doc<"payApplications">["status"],
): string | null {
  if (isReadOnlyReference(scope.project)) {
    return "This is a preserved demo run, so the thread is read-only. Start a fresh guided run to ask or reply.";
  }
  if (scope.project.archived === true) return "This project is archived, so the thread is read-only.";
  if (scope.viewer.user.actorType === "agent") {
    return "Agents can read this thread but cannot post. Sign in as the GC or subcontractor to ask or reply.";
  }
  if (scope.viewer.user.emailVerificationTime === undefined) return "Verify your email before posting to this thread.";
  if (status === "draft") return "Questions open after the subcontractor submits the pay app.";
  if (status === "withdrawn") return "This pay app was withdrawn, so new entries are closed.";
  return null;
}

/**
 * Anti-spam for the thread: one person may post a bounded number of entries in a rolling window and
 * per day. Keyed by user across every pay app, so opening another pay app does not reset the budget.
 */
export async function postingRateLimitReason(ctx: QueryCtx, userId: Id<"users">, now: number): Promise<string | null> {
  const rows = await ctx.db
    .query("payAppThreadEntries")
    .withIndex("by_authorUserId_and_createdAt", (q) => q.eq("authorUserId", userId).gte("createdAt", now - 86_400_000))
    .order("desc")
    .take(QUESTIONS_PER_DAY + 1);
  if (rows.length >= QUESTIONS_PER_DAY) {
    return `You have posted ${QUESTIONS_PER_DAY} entries in the last 24 hours. Try again tomorrow, or call the other party.`;
  }
  const inWindow = rows.filter((row) => row.createdAt >= now - QUESTION_RATE_WINDOW_MS).length;
  if (inWindow >= QUESTIONS_PER_WINDOW) {
    return `You can post ${QUESTIONS_PER_WINDOW} entries per 10 minutes. Wait a few minutes before posting again.`;
  }
  return null;
}

async function assertPostingRate(ctx: MutationCtx, userId: Id<"users">, now: number): Promise<void> {
  const reason = await postingRateLimitReason(ctx, userId, now);
  if (reason !== null) throw new ConvexError({ code: "RATE_LIMITED", message: reason });
}

/** The sub company that should hear a GC reply: the pay app snapshot, the contractor link, or the filer. */
async function subCompanyFor(
  ctx: QueryCtx,
  payApp: Doc<"payApplications">,
  agreement: Doc<"agreements">,
): Promise<Id<"companies"> | null> {
  if (payApp.subCompanyId !== undefined) return payApp.subCompanyId;
  const contractor = await ctx.db.get(agreement.contractorId);
  if (contractor?.linkedCompanyId !== undefined) return contractor.linkedCompanyId;
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_userId", (q) => q.eq("userId", payApp.subUserId))
    .unique();
  return profile?.companyId ?? null;
}

/**
 * The sub/GC conversation for one pay app. Drafts stay private to the filing sub (the GC gets null,
 * matching getPayApp); owners and other companies get null/Not found and never see the thread.
 */
export const list = query({
  args: { payAppId: v.string() },
  returns: v.union(v.null(), threadViewValidator),
  handler: async (ctx, args) => {
    const scope = await findDocScope(ctx, "payApplications", args.payAppId, { roles: ["gc", "sub"] });
    if (scope === null || (scope.doc.status === "draft" && scope.partyRole !== "sub")) return null;
    if (scope.partyRole !== "gc" && scope.partyRole !== "sub") throw notFound();
    const agreement = await ctx.db.get(scope.doc.agreementId);
    if (agreement === null) throw notFound();
    const entries = await ctx.db
      .query("payAppThreadEntries")
      .withIndex("by_payAppId_and_createdAt", (q) => q.eq("payAppId", scope.doc._id))
      .order("asc")
      .take(200);
    const blocked = postingBlockedReason(scope, scope.doc.status);
    const postingBlocked = blocked ?? (await postingRateLimitReason(ctx, scope.viewer.userId, Date.now()));
    return {
      payAppId: scope.doc._id,
      applicationNo: scope.doc.applicationNo ?? null,
      periodLabel: scope.doc.periodLabel,
      requestedTotalCents: scope.doc.requestedTotalCents,
      status: scope.doc.status,
      viewerRole: scope.partyRole,
      counterpartyName: scope.partyRole === "gc" ? agreement.subcontractorName : agreement.generalContractorName,
      canPost: postingBlocked === null,
      postingBlockedReason: postingBlocked,
      entries: entries.map((entry) => ({
        _id: entry._id,
        authorRole: entry.authorRole,
        authorName: entry.authorName,
        body: entry.body,
        createdAt: entry.createdAt,
      })),
    };
  },
});

/**
 * Adds one plain-language entry. This is deliberately not a financial write: it never changes the
 * pay app, approval, ledger or payment. The sub's entry notifies the GC company; the GC's reply
 * notifies the sub company. Agents and read-only demo projects are refused.
 */
export const post = mutation({
  args: { payAppId: v.string(), body: v.string() },
  returns: v.object({ entryId: v.id("payAppThreadEntries"), createdAt: v.number() }),
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "payApplications", args.payAppId, { roles: ["gc", "sub"], write: true });
    if (scope.partyRole !== "gc" && scope.partyRole !== "sub") throw notFound();
    if (scope.viewer.user.actorType === "agent") {
      throw new ConvexError({ code: "AGENT_READ_ONLY", message: "Agents cannot post pay-app questions; ask the subcontractor to sign in." });
    }
    if (CLOSED_STATUSES.has(scope.doc.status)) {
      throw new ConvexError({ code: "PAY_APP_NOT_OPEN", message: "Questions open after the subcontractor submits the pay app." });
    }
    const body = args.body.trim();
    if (body.length < MIN_PAY_APP_QUESTION_LENGTH) {
      throw new ConvexError({ code: "INVALID_QUESTION", message: "Write at least two characters." });
    }
    if (body.length > MAX_PAY_APP_QUESTION_LENGTH) {
      throw new ConvexError({
        code: "INVALID_QUESTION",
        message: `Keep the question under ${MAX_PAY_APP_QUESTION_LENGTH.toLocaleString("en-US")} characters.`,
      });
    }
    const agreement = await ctx.db.get(scope.doc.agreementId);
    if (agreement === null) throw notFound();
    const now = Date.now();
    await assertPostingRate(ctx, scope.viewer.userId, now);
    const actor = auditActor(scope);
    const entryId = await ctx.db.insert("payAppThreadEntries", {
      projectId: agreement.projectId,
      agreementId: agreement._id,
      payAppId: scope.doc._id,
      authorUserId: scope.viewer.userId,
      authorRole: scope.partyRole,
      authorName: actor.actor,
      body,
      createdAt: now,
    });
    await ctx.db.insert("auditLogs", {
      projectId: agreement.projectId,
      agreementId: agreement._id,
      eventType: scope.partyRole === "sub" ? "pay_app_question" : "pay_app_reply",
      title: scope.partyRole === "sub" ? "Pay-app question" : "Pay-app reply",
      description: `${agreement.agreementNumber} · ${labelOf(scope.doc)}: ${actor.actor} ${
        scope.partyRole === "sub" ? "asked about the amount" : "replied"
      }.`,
      ...actor,
      timestamp: now,
    });

    const targetCompanyId =
      scope.partyRole === "sub" ? scope.project.gcCompanyId : await subCompanyFor(ctx, scope.doc, agreement);
    if (targetCompanyId !== undefined && targetCompanyId !== null) {
      const label = labelOf(scope.doc);
      await notify(
        ctx,
        { companyId: targetCompanyId },
        {
          kind: scope.partyRole === "sub" ? "pay_app_question" : "pay_app_reply",
          title: scope.partyRole === "sub" ? `Question about ${label}` : `GC replied on ${label}`,
          body: `${actor.actor}: ${notificationExcerpt(body)}`,
          link: `#/pay-apps/${scope.doc._id}`,
          projectId: agreement.projectId,
        },
      );
    }
    return { entryId, createdAt: now };
  },
});
