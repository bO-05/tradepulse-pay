import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { addressValidator } from "./schema";
import { formatUsPhone, phoneDigits, validateCompanyProfile } from "./lib/companyProfile";
import { listTeammateInvites } from "./lib/teammateInvites";
import { notFound, requireCompanyMember } from "./lib/tenancy";
import { DEFAULT_COMPANY_RETAINAGE_BPS, MAX_RETAINAGE_BPS } from "./lib/retainageRules";

/** Company settings (architecture §13): profile, members, roles. Only admins change anything. */

export const LAST_ADMIN_MESSAGE = "A company needs at least one admin.";

function invalid(message: string, field?: string) {
  return new ConvexError({ code: "INVALID" as const, message, ...(field ? { field } : {}) });
}

/** The caller's company with its members and (for GC admins) teammate invites. */
export const myCompany = query({
  args: {},
  handler: async (ctx) => {
    const { user, membership, company } = await requireCompanyMember(ctx);
    const memberRows = await ctx.db
      .query("companyMembers")
      .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
      .take(200);
    const members = [];
    for (const m of memberRows) {
      if (m.status !== "active") continue;
      const u = await ctx.db.get(m.userId);
      if (u === null) continue;
      members.push({
        membershipId: m._id,
        name: u.name?.trim() || u.email || "Member",
        email: u.email ?? null,
        role: m.role,
        isYou: u._id === user._id,
        joinedAt: m.createdAt,
      });
    }
    members.sort((a, b) => a.name.localeCompare(b.name));
    const isAdmin = membership.role === "admin";
    const teammateInvites = [];
    if (isAdmin && company.kind === "gc") {
      for (const i of await listTeammateInvites(ctx, company._id)) {
        teammateInvites.push({
          _id: i._id,
          email: i.email,
          status: i.status,
          emailStatus: i.emailStatus,
          emailError: i.emailError ?? null,
          expiresAt: i.expiresAt,
          createdAt: i.createdAt,
          lastSentAt: i.lastSentAt ?? null,
        });
      }
    }
    return {
      company: {
        _id: company._id,
        name: company.name,
        kind: company.kind,
        isDemo: company.isDemo,
        legalName: company.legalName ?? "",
        phone: company.phone ?? "",
        website: company.website ?? "",
        address: company.address ?? null,
        defaultRetainageBps: company.defaultRetainageBps ?? DEFAULT_COMPANY_RETAINAGE_BPS,
      },
      isAdmin,
      members,
      teammateInvites,
    };
  },
});

function cleanWebsite(raw: string): string {
  const value = raw.trim();
  if (value === "") return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("Enter a full web address starting with https://", "website");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname.includes(".")) {
    throw invalid("Enter a full web address starting with https://", "website");
  }
  if (value.length > 200) throw invalid("Website is too long.", "website");
  return value.replace(/\/+$/, "");
}

/** Admins update the company profile. Empty optional fields are cleared. */
export const updateProfile = mutation({
  args: {
    name: v.string(),
    legalName: v.optional(v.string()),
    phone: v.optional(v.string()),
    website: v.optional(v.string()),
    address: v.optional(addressValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user, company } = await requireCompanyMember(ctx, { admin: true });
    if (user.emailVerificationTime === undefined) {
      throw new ConvexError({ code: "EMAIL_UNVERIFIED", message: "Verify your email first." });
    }
    const name = args.name.trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 120) throw invalid("Company name must be 2–120 characters.", "name");
    const legalName = (args.legalName ?? "").trim();
    if (legalName.length > 200) throw invalid("Legal name is too long.", "legalName");
    const phoneRaw = (args.phone ?? "").trim();
    if (phoneRaw !== "" && phoneDigits(phoneRaw).length !== 10) throw invalid("Enter a 10-digit US phone number.", "phone");
    const website = cleanWebsite(args.website ?? "");
    let address: Doc<"companies">["address"];
    if (args.address !== undefined) {
      const errors = validateCompanyProfile({ name, address: args.address, phone: phoneRaw || "5105550100" });
      const field = (["line1", "city", "state", "zip"] as const).find((f) => errors[f] !== undefined);
      if (field) throw invalid(errors[field]!, field);
      const line2 = args.address.line2?.trim();
      address = {
        line1: args.address.line1.trim(),
        ...(line2 ? { line2 } : {}),
        city: args.address.city.trim(),
        state: args.address.state.trim().toUpperCase(),
        zip: args.address.zip.trim(),
      };
    } else {
      address = company.address;
    }
    await ctx.db.patch(company._id, {
      name,
      legalName: legalName || undefined,
      phone: phoneRaw ? formatUsPhone(phoneRaw) : undefined,
      website: website || undefined,
      address,
    });
    return null;
  },
});

/** Admins of a GC company set defaults for new projects (§13 Company settings → Defaults). */
export const updateDefaults = mutation({
  args: { defaultRetainageBps: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user, company } = await requireCompanyMember(ctx, { admin: true });
    if (user.emailVerificationTime === undefined) {
      throw new ConvexError({ code: "EMAIL_UNVERIFIED", message: "Verify your email first." });
    }
    if (company.kind !== "gc") throw invalid("Only general contractor companies have project defaults.");
    const bps = args.defaultRetainageBps;
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > MAX_RETAINAGE_BPS) {
      throw invalid("Default retainage must be between 0% and 100%.", "defaultRetainageBps");
    }
    await ctx.db.patch(company._id, { defaultRetainageBps: bps });
    return null;
  },
});

async function targetMembership(ctx: MutationCtx, companyId: Id<"companies">, membershipId: string) {
  const id = ctx.db.normalizeId("companyMembers", membershipId);
  const row = id === null ? null : await ctx.db.get(id);
  if (row === null || row.companyId !== companyId || row.status !== "active") throw notFound();
  return row;
}

async function activeAdminCount(ctx: MutationCtx, companyId: Id<"companies">): Promise<number> {
  const rows = await ctx.db
    .query("companyMembers")
    .withIndex("by_companyId", (q) => q.eq("companyId", companyId))
    .take(500);
  return rows.filter((r) => r.status === "active" && r.role === "admin").length;
}

export const setMemberRole = mutation({
  args: { membershipId: v.string(), role: v.union(v.literal("admin"), v.literal("member")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { company } = await requireCompanyMember(ctx, { admin: true });
    const row = await targetMembership(ctx, company._id, args.membershipId);
    if (row.role === args.role) return null;
    if (row.role === "admin" && (await activeAdminCount(ctx, company._id)) <= 1) {
      throw new ConvexError({ code: "LAST_ADMIN", message: LAST_ADMIN_MESSAGE });
    }
    await ctx.db.patch(row._id, { role: args.role });
    return null;
  },
});

/** Removes a teammate. Access ends on their next request because every guard re-reads the membership. */
export const removeMember = mutation({
  args: { membershipId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { company } = await requireCompanyMember(ctx, { admin: true });
    const row = await targetMembership(ctx, company._id, args.membershipId);
    if (row.role === "admin" && (await activeAdminCount(ctx, company._id)) <= 1) {
      throw new ConvexError({ code: "LAST_ADMIN", message: LAST_ADMIN_MESSAGE });
    }
    await ctx.db.patch(row._id, { status: "removed" });
    return null;
  },
});
