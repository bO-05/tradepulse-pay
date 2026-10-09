import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { rateLimiter } from "./authLimits";
import {
  hashInviteToken,
  INVALID_EMAIL_MESSAGE,
  INVITE_KIND_LABEL,
  INVITE_TTL_MS,
  inviteLink,
  isWellFormedInviteToken,
  maskEmail,
  newInviteToken,
  normalizeInviteEmail,
  type InviteEmailStatus,
} from "./lib/inviteRules";
import { escapeHtml, sendEmail, SYSTEM_SENDER_NAME } from "./lib/mailer";
import { requireProjectScope } from "./lib/projectScope";
import { stampPayAppsSubCompany } from "./payApps/backfill";
import { deliveryFailureMessage } from "./emailOutbox";
import { getLiveAuthUserId } from "./lib/session";
import { requireCompanyMemberInAction } from "./lib/tenancyAction";
import { findActiveMembership, notFound, requireCompanyMember, requireVerifiedUser } from "./lib/tenancy";
import { findVendorByEmail, findVendorByLinkedCompany } from "./lib/vendorDirectory";
import { mergeVendorPair } from "./lib/vendorMerge";
import { notify } from "./lib/notify";

/**
 * Invites (architecture §13): a GC company invites teammates, a vendor's sub contact for a project,
 * or the project owner. The plaintext token lives only in the link (shown to the inviter and
 * optionally emailed); the database keeps its sha256. Accepting requires a verified human account
 * with the invited email.
 */

const inviteKindValidator = v.union(v.literal("teammate"), v.literal("sub"), v.literal("owner"));
const emailStatusValidator = v.union(v.literal("sent"), v.literal("bounced"), v.literal("failed"), v.literal("skipped_budget"), v.literal("not_sent"));

const NO_LONGER_VALID = "This invite is no longer valid.";

function invalid(message: string, field?: string): ConvexError<{ code: "INVALID"; message: string; field?: string }> {
  return new ConvexError({ code: "INVALID" as const, message, ...(field ? { field } : {}) });
}

function siteUrl(): string {
  return process.env.SITE_URL?.trim() || "http://localhost:3150";
}

function personName(user: Doc<"users">): string {
  return user.name?.trim() || user.email || "A teammate";
}

/** Facts the email and the action result need; never the token. */
type PreparedInvite = {
  inviteId: Id<"invites">;
  tokenVersion: number;
  kind: "teammate" | "sub" | "owner";
  email: string;
  companyId: Id<"companies">;
  companyName: string;
  /** Demo company invites are copy-link only; nothing is emailed. */
  companyIsDemo: boolean;
  inviterName: string;
  projectId: Id<"projects"> | null;
  projectTitle: string | null;
  inviteeCompanyName: string | null;
};

async function consumeInviteQuota(ctx: MutationCtx, companyId: Id<"companies">): Promise<void> {
  const status = await rateLimiter.limit(ctx, "invitePerCompany", { key: companyId });
  if (!status.ok) {
    throw new ConvexError({
      code: "RATE_LIMITED",
      message: "Too many invites from your company in the last hour. Try again later.",
      retryAfterMs: status.retryAfter,
    });
  }
}

async function findUserByEmail(ctx: QueryCtx, email: string): Promise<Doc<"users"> | null> {
  return await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .first();
}

async function auditInvite(
  ctx: MutationCtx,
  entry: { projectId?: Id<"projects">; title: string; description: string; user: Doc<"users">; companyId?: Id<"companies"> },
): Promise<void> {
  if (entry.projectId === undefined) return;
  await ctx.db.insert("auditLogs", {
    projectId: entry.projectId,
    eventType: "invite",
    title: entry.title,
    description: entry.description,
    actor: personName(entry.user),
    actorUserId: entry.user._id,
    ...(entry.companyId ? { actorCompanyId: entry.companyId } : {}),
    timestamp: Date.now(),
  });
}

const newVendorValidator = v.object({
  name: v.string(),
  trade: v.string(),
  contactName: v.string(),
});

/** Authorizes and stores a new invite. Called only by the `create` action, with the caller's identity. */
export const prepareCreate = internalMutation({
  args: {
    kind: inviteKindValidator,
    email: v.string(),
    projectId: v.optional(v.string()),
    vendorId: v.optional(v.string()),
    newVendor: v.optional(newVendorValidator),
    companyName: v.optional(v.string()),
    tokenHash: v.string(),
  },
  handler: async (ctx, args): Promise<PreparedInvite> => {
    let project: Doc<"projects"> | null = null;
    if (args.kind !== "teammate") {
      if (args.projectId === undefined) throw notFound();
      ({ project } = await requireProjectScope(ctx, args.projectId, { roles: ["gc"], write: true }));
    }
    const { user, membership, company } = await requireCompanyMember(ctx);
    if (company.kind !== "gc") {
      throw new ConvexError({ code: "FORBIDDEN", message: "Forbidden: only general contractor companies can send invites." });
    }
    if (user.emailVerificationTime === undefined) {
      throw new ConvexError({ code: "EMAIL_UNVERIFIED", message: "Verify your email first." });
    }
    if (args.kind === "teammate" && membership.role !== "admin") {
      throw new ConvexError({ code: "FORBIDDEN", message: "Forbidden: only company admins can invite teammates." });
    }
    const email = normalizeInviteEmail(args.email);
    if (email === null) throw invalid(INVALID_EMAIL_MESSAGE, "email");

    if (args.kind === "teammate") {
      const existingUser = await findUserByEmail(ctx, email);
      const existing = existingUser === null ? null : await findActiveMembership(ctx, existingUser._id);
      if (existing?.companyId === company._id) throw invalid(`${email} is already a member of ${company.name}.`, "email");
    }

    const now = Date.now();
    const sameEmail = await ctx.db
      .query("invites")
      .withIndex("by_email", (q) => q.eq("email", email))
      .take(100);
    const duplicate = sameEmail.find(
      (i) =>
        i.status === "pending" &&
        i.expiresAt > now &&
        i.kind === args.kind &&
        i.inviterCompanyId === company._id &&
        i.projectId === project?._id,
    );
    if (duplicate) {
      throw invalid("There's already a pending invite for this email. Use Resend or Copy link on that invite.", "email");
    }

    let vendor: Doc<"vendors"> | null = null;
    let inviteeCompanyName: string | null = null;
    if (args.kind === "sub" && project !== null) {
      if (args.vendorId !== undefined) {
        const vendorId = ctx.db.normalizeId("vendors", args.vendorId);
        vendor = vendorId === null ? null : await ctx.db.get(vendorId);
        if (vendor === null || vendor.companyId !== company._id) throw notFound();
      } else if (args.newVendor !== undefined) {
        const name = args.newVendor.name.trim().replace(/\s+/g, " ");
        const contactName = args.newVendor.contactName.trim();
        const trade = args.newVendor.trade.trim();
        if (name.length < 2 || name.length > 120) throw invalid("Enter the subcontractor's company name (2–120 characters).", "vendorName");
        if (trade.length === 0) throw invalid("Choose the trade.", "trade");
        if (contactName.length === 0 || contactName.length > 120) throw invalid("Enter the contact's name.", "contactName");
        const sameEmailVendor = await findVendorByEmail(ctx, company._id, email);
        if (sameEmailVendor !== null) {
          throw invalid(`${sameEmailVendor.name} already uses this email in your vendor directory. Choose it from the vendor list.`, "vendor");
        }
        const vendorId = await ctx.db.insert("vendors", {
          companyId: company._id,
          name,
          trades: [trade],
          contactName,
          email,
          status: "active",
          createdAt: now,
        });
        vendor = await ctx.db.get(vendorId);
      } else {
        throw invalid("Choose a vendor or add a new one.", "vendor");
      }
      if (vendor === null) throw notFound();
      if (vendor.linkedCompanyId !== undefined) {
        const linkedId = vendor.linkedCompanyId;
        const projectId = project._id;
        const active = await ctx.db
          .query("projectMembers")
          .withIndex("by_project_company_and_status", (q) =>
            q.eq("projectId", projectId).eq("companyId", linkedId).eq("status", "active"),
          )
          .first();
        if (active !== null) throw invalid(`${vendor.name} is already on this project.`, "vendor");
      }
      inviteeCompanyName = vendor.name;
    }
    if (args.kind === "owner" && project !== null) {
      const name = (args.companyName ?? "").trim().replace(/\s+/g, " ") || project.ownerName?.trim() || "";
      if (name.length > 120) throw invalid("Owner company name must be at most 120 characters.", "companyName");
      inviteeCompanyName = name || null;
    }

    await consumeInviteQuota(ctx, company._id);
    const inviteId = await ctx.db.insert("invites", {
      tokenHash: args.tokenHash,
      email,
      kind: args.kind,
      inviterCompanyId: company._id,
      ...(project ? { projectId: project._id } : {}),
      ...(vendor ? { vendorId: vendor._id } : {}),
      ...(inviteeCompanyName ? { companyName: inviteeCompanyName } : {}),
      status: "pending",
      expiresAt: now + INVITE_TTL_MS,
      emailStatus: "not_sent",
      tokenVersion: 1,
      createdByUserId: user._id,
      createdAt: now,
    });
    await auditInvite(ctx, {
      projectId: project?._id,
      title: `${INVITE_KIND_LABEL[args.kind]} invite created`,
      description: `${personName(user)} invited ${email}${inviteeCompanyName ? ` (${inviteeCompanyName})` : ""} as ${INVITE_KIND_LABEL[args.kind].toLowerCase()}.`,
      user,
      companyId: company._id,
    });
    return {
      inviteId,
      tokenVersion: 1,
      kind: args.kind,
      email,
      companyId: company._id,
      companyName: company.name,
      companyIsDemo: company.isDemo,
      inviterName: personName(user),
      projectId: project?._id ?? null,
      projectTitle: project?.title ?? null,
      inviteeCompanyName,
    };
  },
});

/** The invite the caller may manage: it belongs to the caller's GC company and (for project invites) a project the caller's company runs. */
async function requireManageableInvite(
  ctx: MutationCtx,
  member: Awaited<ReturnType<typeof requireCompanyMember>>,
  inviteId: string,
) {
  const { user, membership, company } = member;
  const normalized = ctx.db.normalizeId("invites", inviteId);
  const invite = normalized === null ? null : await ctx.db.get(normalized);
  if (invite === null || invite.inviterCompanyId !== company._id || company.kind !== "gc") throw notFound();
  let project: Doc<"projects"> | null = null;
  if (invite.projectId !== undefined) {
    ({ project } = await requireProjectScope(ctx, invite.projectId, { roles: ["gc"], write: true }));
  } else if (membership.role !== "admin") {
    throw new ConvexError({ code: "FORBIDDEN", message: "Forbidden: only company admins can manage teammate invites." });
  }
  return { user, company, invite, project };
}

/** Replaces the invite's token (resend / copy a fresh link). The old link then reads "no longer valid". */
export const prepareRotate = internalMutation({
  args: { inviteId: v.string(), tokenHash: v.string() },
  handler: async (ctx, args): Promise<PreparedInvite> => {
    const { user, company, invite, project } = await requireManageableInvite(ctx, await requireCompanyMember(ctx), args.inviteId);
    if (invite.status !== "pending") throw invalid(NO_LONGER_VALID);
    if (invite.expiresAt <= Date.now()) throw invalid("This invite has expired. Revoke it and create a new invite.");
    await consumeInviteQuota(ctx, company._id);
    const now = Date.now();
    await ctx.db.insert("retiredInviteTokens", { tokenHash: invite.tokenHash, inviteId: invite._id, retiredAt: now });
    const tokenVersion = (invite.tokenVersion ?? 1) + 1;
    // The previous link (possibly emailed) no longer works, so the email status starts over.
    await ctx.db.patch(invite._id, { tokenHash: args.tokenHash, tokenVersion, emailStatus: "not_sent", emailError: undefined });
    return {
      inviteId: invite._id,
      tokenVersion,
      kind: invite.kind,
      email: invite.email,
      companyId: company._id,
      companyName: company.name,
      companyIsDemo: company.isDemo,
      inviterName: personName(user),
      projectId: project?._id ?? null,
      projectTitle: project?.title ?? null,
      inviteeCompanyName: invite.companyName ?? null,
    };
  },
});

export const recordEmailResult = internalMutation({
  args: { inviteId: v.id("invites"), tokenVersion: v.number(), emailStatus: emailStatusValidator, error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.inviteId);
    // A newer rotation owns the status; this result is about a link that no longer works.
    if (invite === null || (invite.tokenVersion ?? 1) !== args.tokenVersion) return null;
    // A bounce for this link may already have been recorded on the invite or its outbox row.
    if (invite.emailStatus === "bounced") return null;
    const outbox = await ctx.db
      .query("emailOutbox")
      .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", `invite.${invite._id}.${args.tokenVersion}`))
      .unique();
    if (outbox?.status === "delivery_failed") {
      await ctx.db.patch(invite._id, {
        emailStatus: "bounced",
        emailError: outbox.error ?? deliveryFailureMessage(outbox.deliveryEvent ?? "bounced"),
      });
      return null;
    }
    await ctx.db.patch(invite._id, {
      emailStatus: args.emailStatus,
      emailError: args.error?.slice(0, 300),
      ...(args.emailStatus === "sent" ? { lastSentAt: Date.now() } : {}),
    });
    return null;
  },
});

function inviteEmail(p: PreparedInvite, link: string): { subject: string; text: string; html: string } {
  let subject: string;
  let what: string;
  if (p.kind === "teammate") {
    subject = `${p.inviterName} invited you to join ${p.companyName} on TradePulse Pay`;
    what = `${p.inviterName} of ${p.companyName} invited you to join ${p.companyName} on TradePulse Pay as a teammate.`;
  } else if (p.kind === "sub") {
    subject = `${p.companyName} invited you to "${p.projectTitle}" on TradePulse Pay`;
    what = `${p.inviterName} of ${p.companyName} invited ${p.inviteeCompanyName ?? "your company"} to the project "${p.projectTitle}" on TradePulse Pay as a subcontractor.`;
  } else {
    subject = `${p.companyName} invited you to "${p.projectTitle}" on TradePulse Pay`;
    what = `${p.inviterName} of ${p.companyName} invited you to the project "${p.projectTitle}" on TradePulse Pay as the owner.`;
  }
  const note = `Create an account or sign in with ${p.email} to accept. The link expires in 7 days and works once.`;
  const ignore = "If you weren't expecting this invite, you can ignore this email.";
  const text = `${what}\n\nAccept the invite: ${link}\n\n${note}\n\n${ignore}\n\n${SYSTEM_SENDER_NAME}`;
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;line-height:1.5">` +
    `<p style="margin:0 0 16px;font-weight:bold;font-size:16px">${escapeHtml(SYSTEM_SENDER_NAME)}</p>` +
    `<p style="margin:0 0 12px">${escapeHtml(what)}</p>` +
    `<p style="margin:0 0 12px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#047857;color:#ffffff;padding:10px 16px;border-radius:8px;text-decoration:none">Accept the invite</a></p>` +
    `<p style="margin:0 0 12px;font-size:12px;color:#4b5563">Or paste this link into your browser: ${escapeHtml(link)}</p>` +
    `<p style="margin:0 0 12px">${escapeHtml(note)}</p>` +
    `<p style="margin:0;font-size:12px;color:#6b7280">${escapeHtml(ignore)}</p></div>`;
  return { subject, text, html };
}

type DeliveryResult = { emailStatus: InviteEmailStatus; emailError: string | null };

async function deliver(ctx: ActionCtx, p: PreparedInvite, token: string, link: string, send: boolean): Promise<DeliveryResult> {
  if (!send || p.companyIsDemo) return { emailStatus: "not_sent", emailError: null };
  const { subject, text, html } = inviteEmail(p, link);
  const result = await sendEmail(ctx, {
    kind: "invite",
    from: "system",
    to: p.email,
    subject,
    text,
    html,
    idempotencyKey: `invite.${p.inviteId}.${p.tokenVersion}`,
    companyId: p.companyId,
    projectId: p.projectId ?? undefined,
    redact: [token, link],
  });
  const emailStatus: InviteEmailStatus = result.status;
  const emailError = result.status === "failed" ? result.error : null;
  await ctx.runMutation(internal.invites.recordEmailResult, {
    inviteId: p.inviteId,
    tokenVersion: p.tokenVersion,
    emailStatus,
    error: emailError ?? undefined,
  });
  return { emailStatus, emailError };
}

const inviteResultValidator = v.object({
  inviteId: v.id("invites"),
  email: v.string(),
  link: v.string(),
  emailStatus: emailStatusValidator,
  emailError: v.union(v.string(), v.null()),
});

/** GC creates an invite. The link is always returned; the email goes out only when `sendEmail` is not false and budget allows. */
export const create = action({
  args: {
    kind: inviteKindValidator,
    email: v.string(),
    projectId: v.optional(v.string()),
    vendorId: v.optional(v.string()),
    newVendor: v.optional(newVendorValidator),
    companyName: v.optional(v.string()),
    sendEmail: v.optional(v.boolean()),
  },
  returns: inviteResultValidator,
  handler: async (ctx, args) => {
    await requireCompanyMemberInAction(ctx);
    const token = newInviteToken();
    const { sendEmail: send, ...rest } = args;
    const prepared: PreparedInvite = await ctx.runMutation(internal.invites.prepareCreate, {
      ...rest,
      tokenHash: await hashInviteToken(token),
    });
    const link = inviteLink(siteUrl(), token);
    const delivery = await deliver(ctx, prepared, token, link, send !== false);
    return { inviteId: prepared.inviteId, email: prepared.email, link, ...delivery };
  },
});

/** New link for a pending invite (old links stop working), emailed when `sendEmail` is true. */
export const resend = action({
  args: { inviteId: v.string(), sendEmail: v.boolean() },
  returns: inviteResultValidator,
  handler: async (ctx, args) => {
    await requireCompanyMemberInAction(ctx);
    const token = newInviteToken();
    const prepared: PreparedInvite = await ctx.runMutation(internal.invites.prepareRotate, {
      inviteId: args.inviteId,
      tokenHash: await hashInviteToken(token),
    });
    const link = inviteLink(siteUrl(), token);
    const delivery = await deliver(ctx, prepared, token, link, args.sendEmail);
    return { inviteId: prepared.inviteId, email: prepared.email, link, ...delivery };
  },
});

export const revoke = mutation({
  args: { inviteId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user, company, invite } = await requireManageableInvite(ctx, await requireCompanyMember(ctx), args.inviteId);
    if (invite.status === "accepted") throw invalid("This invite was already accepted. Remove the member instead.");
    if (invite.status !== "pending") return null;
    await ctx.db.patch(invite._id, { status: "revoked", revokedAt: Date.now() });
    await auditInvite(ctx, {
      projectId: invite.projectId,
      title: `${INVITE_KIND_LABEL[invite.kind]} invite revoked`,
      description: `${personName(user)} revoked the invite for ${invite.email}.`,
      user,
      companyId: company._id,
    });
    return null;
  },
});

async function upsertProfile(
  ctx: MutationCtx,
  user: Doc<"users">,
  role: "gc" | "sub" | "owner",
  companyId: Id<"companies">,
  contractorId?: Id<"contractors">,
): Promise<void> {
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_userId", (q) => q.eq("userId", user._id))
    .unique();
  if (profile === null) {
    await ctx.db.insert("userProfiles", {
      userId: user._id,
      role,
      displayName: personName(user),
      actorType: "human",
      companyId,
      ...(contractorId ? { contractorId } : {}),
      createdAt: Date.now(),
    });
    return;
  }
  if (role === "sub") {
    await ctx.db.patch(profile._id, { role, companyId, contractorId: profile.contractorId ?? contractorId });
  } else {
    await ctx.db.patch(profile._id, { role, companyId, contractorId: undefined, paypalEmail: undefined });
  }
}

async function addCompanyMember(ctx: MutationCtx, companyId: Id<"companies">, userId: Id<"users">, role: "admin" | "member") {
  const rows = await ctx.db
    .query("companyMembers")
    .withIndex("by_companyId_and_userId", (q) => q.eq("companyId", companyId).eq("userId", userId))
    .take(5);
  if (rows.length > 0) {
    await ctx.db.patch(rows[0]._id, { status: "active", role });
    return;
  }
  await ctx.db.insert("companyMembers", { companyId, userId, role, status: "active", createdAt: Date.now() });
}

async function upsertProjectMember(
  ctx: MutationCtx,
  fields: {
    projectId: Id<"projects">;
    companyId: Id<"companies">;
    partyRole: "sub" | "owner";
    vendorId?: Id<"vendors">;
    contractorId?: Id<"contractors">;
    addedByUserId: Id<"users">;
  },
): Promise<void> {
  const existing =
    (await ctx.db
      .query("projectMembers")
      .withIndex("by_project_company_and_status", (q) =>
        q.eq("projectId", fields.projectId).eq("companyId", fields.companyId).eq("status", "active"),
      )
      .first()) ??
    (await ctx.db
      .query("projectMembers")
      .withIndex("by_project_company_and_status", (q) => q.eq("projectId", fields.projectId).eq("companyId", fields.companyId))
      .order("desc")
      .first());
  if (existing !== null) {
    await ctx.db.patch(existing._id, {
      status: "active",
      partyRole: fields.partyRole,
      vendorId: fields.vendorId ?? existing.vendorId,
      contractorId: fields.contractorId ?? existing.contractorId,
      removedAt: undefined,
      removedByUserId: undefined,
    });
    return;
  }
  await ctx.db.insert("projectMembers", { ...fields, status: "active", createdAt: Date.now() });
}

function alreadyInCompany(company: Doc<"companies">, wanted: string): ConvexError<{ code: "ALREADY_IN_COMPANY"; message: string }> {
  return new ConvexError({
    code: "ALREADY_IN_COMPANY" as const,
    message: `This invite is for ${wanted}, but your account already belongs to ${company.name}. An account belongs to one company; sign out and use a different account.`,
  });
}

async function vendorAlreadyOnPay(
  ctx: MutationCtx,
  vendor: Doc<"vendors">,
): Promise<ConvexError<{ code: "VENDOR_LINKED"; message: string }>> {
  const linked = vendor.linkedCompanyId ? await ctx.db.get(vendor.linkedCompanyId) : null;
  const name = linked?.name ?? vendor.name;
  return new ConvexError({
    code: "VENDOR_LINKED" as const,
    message: `${name} is already on TradePulse Pay — invite one of its members, or ask its admin to add you.`,
  });
}

/**
 * Links the project's bidder records for this vendor (by vendor id, else by its contact email or one of
 * `otherEmails`) to the sub company.
 */
async function linkVendorContractors(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  vendor: Doc<"vendors">,
  subCompanyId: Id<"companies">,
  otherEmails: string[] = [],
): Promise<Id<"contractors"> | undefined> {
  const emails = new Set([vendor.email, ...otherEmails]);
  let first: Id<"contractors"> | undefined;
  const packages = await ctx.db
    .query("tradePackages")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(100);
  for (const pkg of packages) {
    const bidders = await ctx.db
      .query("contractors")
      .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
      .take(200);
    for (const c of bidders) {
      const matches = c.vendorId === vendor._id || (c.vendorId === undefined && emails.has(c.contactEmail.trim().toLowerCase()));
      if (!matches) continue;
      if (c.linkedCompanyId !== undefined && c.linkedCompanyId !== subCompanyId) continue;
      await ctx.db.patch(c._id, { linkedCompanyId: subCompanyId, vendorId: vendor._id });
      if (c.linkedCompanyId === undefined) await stampPayAppsSubCompany(ctx, c._id, subCompanyId);
      first ??= c._id;
    }
  }
  return first;
}

/** In-app notice to the inviting GC company (never email). A newly linked sub with a payout email also needs payee confirmation. */
async function notifyInviteAccepted(
  ctx: MutationCtx,
  a: {
    user: Doc<"users">;
    inviter: Doc<"companies">;
    joinedCompanyId: Id<"companies">;
    project: Doc<"projects"> | null;
    newlyLinkedVendor: Doc<"vendors"> | null;
  },
) {
  const joined = await ctx.db.get(a.joinedCompanyId);
  if (joined === null) return;
  if (a.project === null) {
    await notify(ctx, { companyId: a.inviter._id }, {
      kind: "invite_accepted",
      title: `${personName(a.user)} joined ${a.inviter.name}`,
      body: `${personName(a.user)} accepted your teammate invite and is now a member of ${a.inviter.name}.`,
      link: "#/company",
    });
    return;
  }
  await notify(ctx, { companyId: a.inviter._id }, {
    kind: "invite_accepted",
    title: `${joined.name} joined ${a.project.title}`,
    body: `${personName(a.user)} of ${joined.name} accepted the invite to ${a.project.title}.`,
    link: `#/people/${a.project._id}`,
    projectId: a.project._id,
  });
  const vendor = a.newlyLinkedVendor;
  if (vendor !== null && joined.payoutPaypalEmail !== undefined && vendor.payoutEmailConfirmed?.email !== joined.payoutPaypalEmail) {
    await notify(ctx, { companyId: a.inviter._id }, {
      kind: "payee_change_pending",
      title: `Payee change pending for ${vendor.name}`,
      body: `${joined.name} has a payout PayPal email on file. Payouts to ${vendor.name} are on hold until someone at ${a.inviter.name} confirms it on the vendor page.`,
      link: `#/vendors/${vendor._id}`,
    });
  }
}

function cleanCompanyName(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, " ");
}

async function acceptInvite(ctx: MutationCtx, user: Doc<"users">, invite: Doc<"invites"> | null, companyNameArg?: string) {
  if (user.actorType === "agent") {
    throw new ConvexError({
      code: "AGENT_CANNOT_ACCEPT",
      message: "AgentID billing agents can't accept invitations. Invites are for people; ask the inviter to send it to a person's email.",
    });
  }
  if (invite === null || invite.status !== "pending") throw new ConvexError({ code: "INVITE_INVALID", message: NO_LONGER_VALID });
  const inviter = await ctx.db.get(invite.inviterCompanyId);
  if (inviter === null) throw new ConvexError({ code: "INVITE_INVALID", message: NO_LONGER_VALID });
  if (invite.expiresAt <= Date.now()) {
    throw new ConvexError({ code: "INVITE_EXPIRED", message: `This invite has expired — ask ${inviter.name} to resend it.` });
  }
  if ((user.email ?? "").trim().toLowerCase() !== invite.email) {
    throw new ConvexError({
      code: "EMAIL_MISMATCH",
      message: `This invite was sent to a different email (${maskEmail(invite.email)}). Sign out and use a different account.`,
    });
  }
  const membership = await findActiveMembership(ctx, user._id);
  const current = membership === null ? null : await ctx.db.get(membership.companyId);
  const now = Date.now();
  let joinedCompanyId: Id<"companies">;
  let joinedProject: Doc<"projects"> | null = null;
  let newlyLinkedVendor: Doc<"vendors"> | null = null;

  if (invite.kind === "teammate") {
    if (current !== null && current._id !== inviter._id) throw alreadyInCompany(current, `${inviter.name}`);
    if (current === null) await addCompanyMember(ctx, inviter._id, user._id, "member");
    await upsertProfile(ctx, user, "gc", inviter._id);
    joinedCompanyId = inviter._id;
  } else {
    const project = invite.projectId ? await ctx.db.get(invite.projectId) : null;
    if (project === null || project.gcCompanyId !== inviter._id) throw new ConvexError({ code: "INVITE_INVALID", message: NO_LONGER_VALID });
    if (invite.kind === "sub") {
      const invitedVendor = invite.vendorId ? await ctx.db.get(invite.vendorId) : null;
      if (invitedVendor === null) throw new ConvexError({ code: "INVITE_INVALID", message: NO_LONGER_VALID });
      let vendor = invitedVendor;
      // A sub invite admits a company to a project; it never admits a person into an existing
      // company. Joining one happens only through that company's own teammate invite.
      let subCompanyId: Id<"companies">;
      if (current !== null) {
        if (current.kind !== "sub") throw alreadyInCompany(current, "a subcontractor company");
        if (vendor.linkedCompanyId !== undefined && vendor.linkedCompanyId !== current._id) throw await vendorAlreadyOnPay(ctx, vendor);
        subCompanyId = current._id;
        // The GC may already list this company on another vendor row; keep a single row per sub.
        const alreadyListed = await findVendorByLinkedCompany(ctx, inviter._id, subCompanyId);
        if (alreadyListed !== null && alreadyListed._id !== vendor._id) vendor = await mergeVendorPair(ctx, alreadyListed, vendor);
      } else if (vendor.linkedCompanyId !== undefined) {
        throw await vendorAlreadyOnPay(ctx, vendor);
      } else {
        subCompanyId = await ctx.db.insert("companies", {
          name: vendor.name,
          kind: "sub",
          isDemo: false,
          createdByUserId: user._id,
          createdAt: now,
        });
        await addCompanyMember(ctx, subCompanyId, user._id, "admin");
      }
      if (vendor.linkedCompanyId === undefined) newlyLinkedVendor = vendor;
      await ctx.db.patch(vendor._id, { linkedCompanyId: subCompanyId });
      const contractorId = await linkVendorContractors(ctx, project._id, vendor, subCompanyId, [invitedVendor.email]);
      await upsertProjectMember(ctx, {
        projectId: project._id,
        companyId: subCompanyId,
        partyRole: "sub",
        vendorId: vendor._id,
        contractorId,
        addedByUserId: invite.createdByUserId,
      });
      await upsertProfile(ctx, user, "sub", subCompanyId, contractorId);
      joinedCompanyId = subCompanyId;
    } else {
      let ownerCompanyId: Id<"companies">;
      if (current !== null) {
        if (current.kind !== "owner") throw alreadyInCompany(current, "an owner company");
        ownerCompanyId = current._id;
      } else {
        const name = cleanCompanyName(companyNameArg) || cleanCompanyName(invite.companyName) || cleanCompanyName(project.ownerName);
        if (name.length < 2 || name.length > 120) throw invalid("Enter your company name (2–120 characters).", "companyName");
        ownerCompanyId = await ctx.db.insert("companies", {
          name,
          kind: "owner",
          isDemo: false,
          createdByUserId: user._id,
          createdAt: now,
        });
        await addCompanyMember(ctx, ownerCompanyId, user._id, "admin");
      }
      await upsertProjectMember(ctx, {
        projectId: project._id,
        companyId: ownerCompanyId,
        partyRole: "owner",
        addedByUserId: invite.createdByUserId,
      });
      await ctx.db.patch(project._id, { ownerCompanyId, ...(project.ownerName ? {} : { ownerName: (await ctx.db.get(ownerCompanyId))?.name }) });
      await upsertProfile(ctx, user, "owner", ownerCompanyId);
      joinedCompanyId = ownerCompanyId;
    }
    joinedProject = project;
  }

  await ctx.db.patch(invite._id, { status: "accepted", acceptedByUserId: user._id, acceptedAt: now });
  await auditInvite(ctx, {
    projectId: invite.projectId,
    title: `${INVITE_KIND_LABEL[invite.kind]} invite accepted`,
    description: `${personName(user)} (${invite.email}) accepted the invite from ${inviter.name}.`,
    user,
    companyId: joinedCompanyId,
  });
  await notifyInviteAccepted(ctx, { user, inviter, joinedCompanyId, project: joinedProject, newlyLinkedVendor });
  return { companyId: joinedCompanyId, kind: invite.kind, projectId: invite.projectId ?? null };
}

const acceptResultValidator = v.object({
  companyId: v.id("companies"),
  kind: inviteKindValidator,
  projectId: v.union(v.id("projects"), v.null()),
});

/** Accepts the invite behind a link. The signed-in, verified account's email must be the invited one. */
export const accept = mutation({
  args: { token: v.string(), companyName: v.optional(v.string()) },
  returns: acceptResultValidator,
  handler: async (ctx, args) => {
    const user = await requireVerifiedUser(ctx);
    const token = args.token.trim();
    let invite: Doc<"invites"> | null = null;
    if (isWellFormedInviteToken(token)) {
      const tokenHash = await hashInviteToken(token);
      invite = await ctx.db
        .query("invites")
        .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
        .unique();
    }
    return await acceptInvite(ctx, user, invite, args.companyName);
  },
});

/** Accepts one of the caller's own pending invites (listed by `listMine`) without the link. */
export const acceptMine = mutation({
  args: { inviteId: v.string(), companyName: v.optional(v.string()) },
  returns: acceptResultValidator,
  handler: async (ctx, args) => {
    const user = await requireVerifiedUser(ctx);
    const normalized = ctx.db.normalizeId("invites", args.inviteId);
    const invite = normalized === null ? null : await ctx.db.get(normalized);
    if (invite !== null && invite.email !== (user.email ?? "").toLowerCase()) throw notFound();
    return await acceptInvite(ctx, user, invite, args.companyName);
  },
});

/** Pending invites addressed to the caller's verified email (onboarding page). */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireVerifiedUser(ctx);
    if (user.actorType === "agent" || !user.email) return [];
    const email = user.email.toLowerCase();
    const rows = await ctx.db
      .query("invites")
      .withIndex("by_email", (q) => q.eq("email", email))
      .order("desc")
      .take(50);
    const out = [];
    for (const invite of rows) {
      if (invite.status !== "pending") continue;
      const company = await ctx.db.get(invite.inviterCompanyId);
      if (company === null) continue;
      const project = invite.projectId ? await ctx.db.get(invite.projectId) : null;
      out.push({
        _id: invite._id,
        kind: invite.kind,
        inviterCompanyName: company.name,
        projectTitle: project?.title ?? null,
        inviteeCompanyName: invite.companyName ?? project?.ownerName ?? null,
        expiresAt: invite.expiresAt,
      });
    }
    return out;
  },
});

/**
 * What the accept page shows for a link. Anyone holding the 256-bit token may read the inviter's
 * company and project names; a revoked, accepted or replaced link reveals nothing. Expiry is
 * compared on the client (`expiresAt`) so the query does not read the clock.
 */
export const getByToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const token = args.token.trim();
    if (!isWellFormedInviteToken(token)) return { state: "invalid" as const };
    const tokenHash = await hashInviteToken(token);
    const invite = await ctx.db
      .query("invites")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (invite === null) {
      const retired = await ctx.db
        .query("retiredInviteTokens")
        .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
        .first();
      return retired === null ? { state: "invalid" as const } : { state: "no_longer_valid" as const };
    }
    if (invite.status !== "pending") return { state: "no_longer_valid" as const };
    const company = await ctx.db.get(invite.inviterCompanyId);
    if (company === null) return { state: "no_longer_valid" as const };
    const project = invite.projectId ? await ctx.db.get(invite.projectId) : null;
    const inviter = await ctx.db.get(invite.createdByUserId);

    const userId = await getLiveAuthUserId(ctx);
    const user = userId === null ? null : await ctx.db.get(userId);
    let viewer = null;
    if (user !== null) {
      const membership = user.actorType === "agent" ? null : await findActiveMembership(ctx, user._id);
      const own = membership === null ? null : await ctx.db.get(membership.companyId);
      viewer = {
        email: user.email ?? null,
        isAgent: user.actorType === "agent",
        emailMatches: user.actorType !== "agent" && (user.email ?? "").toLowerCase() === invite.email,
        companyName: own?.name ?? null,
        companyKind: own?.kind ?? null,
      };
    }
    const showFullEmail = viewer === null || viewer.emailMatches;
    return {
      state: "pending" as const,
      kind: invite.kind,
      inviterCompanyName: company.name,
      inviterName: inviter ? personName(inviter) : company.name,
      projectTitle: project?.title ?? null,
      inviteeCompanyName: invite.companyName ?? project?.ownerName ?? null,
      email: showFullEmail ? invite.email : maskEmail(invite.email),
      expiresAt: invite.expiresAt,
      viewer,
    };
  },
});
