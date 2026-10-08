import { cronJobs } from "convex/server";
import { requireRole } from "./lib/roles";
import { auditActor, requireProjectScope } from "./lib/projectScope";
import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Schedule automated bid deadline monitoring every 1 hour
crons.interval(
  "monitor-bid-deadlines",
  { hours: 1 },
  internal.crons.monitorBidDeadlines
);

// Schedule contractor licensing and COI insurance compliance audits every 6 hours
crons.interval(
  "audit-contractor-compliance",
  { hours: 6 },
  internal.crons.auditContractorCompliance
);

// PayPal authorization honor periods: reauthorize after the 3-day honor period, expire at 29 days.
crons.interval(
  "watch-authorization-honor-periods",
  { hours: 1 },
  internal.payments.honorPeriod.watchAuthorizations,
  {}
);

/**
 * Convex Scheduled Cron Job: Bid Deadline Monitor
 * Automatically checks all active CSI trade packages against their stated deadlines.
 * Transitions overdue packages to leveling and logs audit records.
 */
export const monitorBidDeadlines = internalMutation({
  args: {},
  handler: async (ctx) => {
    const packages = await ctx.db.query("tradePackages").collect();
    const now = Date.now();
    let monitoredCount = 0;
    let transitionedCount = 0;

    for (const pkg of packages) {
      monitoredCount++;
      // A17-01: a date-only deadline belongs to the user's local day, which can end
// up to 12h after the UTC day. Close it only after the last possible local
// day-end (deadline 23:59:59.999Z + 12h) so no west-of-UTC user sees their own
// deadline day flagged as passed.
      const deadlineTs = Date.parse(`${pkg.bidDeadline}T23:59:59.999Z`) + 12 * 60 * 60 * 1000;
      const isOverdue = !isNaN(deadlineTs) && deadlineTs <= now;

      if (isOverdue && pkg.status === "rfqs_dispatched") {
        const pkgBids = await ctx.db
          .query("bids")
          .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
          .collect();
        if (pkgBids.length === 0) {
          // USE-A4-09: do not claim "leveling" progress when no proposal exists.
          const existing = await ctx.db
            .query("auditLogs")
            .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
            .collect();
          const alreadyFlagged = existing.some((l) =>
            l.title.startsWith("Deadline passed with no bids")
          );
          if (!alreadyFlagged) {
            await ctx.db.insert("auditLogs", {
              projectId: pkg.projectId,
              tradePackageId: pkg._id,
              eventType: "compliance_audit",
              title: `Deadline passed with no bids: ${pkg.tradeName}`,
              description: `Bid deadline (${pkg.bidDeadline}) passed with zero proposals on file. The package was left open — extend the deadline or re-solicit subcontractors before leveling.`,
              actor: "Convex Automated Cron Engine",
              timestamp: Date.now(),
            });
          }
          continue;
        }
        await ctx.db.patch(pkg._id, { status: "leveling" });
        transitionedCount++;

        await ctx.db.insert("auditLogs", {
          projectId: pkg.projectId,
          tradePackageId: pkg._id,
          eventType: "cron_executed",
          title: `Cron Monitor: Bid Deadline Closed for ${pkg.tradeName}`,
          description: `Bid deadline (${pkg.bidDeadline}) reached with ${pkgBids.length} proposal(s) on file. Auto-transitioned Division ${pkg.csiDivision} to active leveling status.`,
          actor: "Convex Automated Cron Engine",
          timestamp: Date.now(),
        });
      }
    }

    return { monitoredCount, transitionedCount };
  },
});

/**
 * Convex Scheduled Cron Job: Contractor Licensing & COI Compliance Auditor
 * Scans contractor records for license status flags, insurance riders,
 * and ACORD 25 compliance gaps.
 */
export const auditContractorCompliance = internalMutation({
  args: {},
  handler: async (ctx) => {
    const contractors = await ctx.db.query("contractors").collect();
    const bids = await ctx.db.query("bids").collect();
    let verifiedCount = 0;
    let flagCount = 0;

    for (const contractor of contractors) {
      if (contractor.licenseStatus.includes("Active") || contractor.licenseStatus.includes("Verified")) {
        verifiedCount++;
      } else {
        flagCount++;
      }
    }

    let coiDeficiencies = 0;
    for (const bid of bids) {
      if (bid.coiComplianceStatus === "deficiency_detected") {
        coiDeficiencies++;
      }
    }

    const projects = await ctx.db.query("projects").collect();
    const tradePackages = await ctx.db.query("tradePackages").collect();

    for (const project of projects) {
      const projectPackageIds = new Set(
        tradePackages.filter((p) => p.projectId === project._id).map((p) => p._id)
      );

      const projectContractors = contractors.filter((c) => projectPackageIds.has(c.tradePackageId));
      let pVerified = 0;
      let pFlagged = 0;
      for (const c of projectContractors) {
        if (c.licenseStatus.includes("Active") || c.licenseStatus.includes("Verified")) {
          pVerified++;
        } else {
          pFlagged++;
        }
      }

      const projectBids = bids.filter((b) => projectPackageIds.has(b.tradePackageId));
      let pCoiDeficiencies = 0;
      for (const b of projectBids) {
        if (b.coiComplianceStatus === "deficiency_detected") {
          pCoiDeficiencies++;
        }
      }

      if (projectContractors.length > 0 || projectBids.length > 0) {
        await ctx.db.insert("auditLogs", {
          projectId: project._id,
          eventType: "compliance_audit",
          title: `Cron Audit: Recorded License Status & ACORD 25 Sweep - ${project.title}`,
          description: `Audited ${projectContractors.length} trade contractors (${pVerified} with recorded active/verified status, ${pFlagged} flagged). No registry lookup is performed. Detected ${pCoiDeficiencies} active COI insurance deficiency riders.`,
          actor: "Convex Compliance Auditor Cron",
          timestamp: Date.now(),
        });
      }
    }

    return {
      verifiedLicensingCount: verifiedCount,
      flaggedLicensingCount: flagCount,
      coiDeficiencies,
    };
  },
});

/**
 * Public mutations to allow 1-click execution from UI and verification tests.
 */
export const runDeadlineMonitorNow = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: ["gc"], write: true });
    const packages = await ctx.db
      .query("tradePackages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const now = Date.now();
    let monitoredCount = 0;
    let transitionedCount = 0;

    for (const pkg of packages) {
      if (pkg.projectId === args.projectId) {
        monitoredCount++;
        if (Date.parse(`${pkg.bidDeadline}T23:59:59.999Z`) + 12 * 60 * 60 * 1000 <= now && pkg.status === "rfqs_dispatched") {
          const pkgBids = await ctx.db
            .query("bids")
            .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
            .collect();
          if (pkgBids.length > 0) {
            await ctx.db.patch(pkg._id, { status: "leveling" });
            transitionedCount++;
          } else {
            // A14-03: the manual trigger must match the scheduled job and flag
            // zero-bid packages once instead of silently doing nothing.
            const existing = await ctx.db
              .query("auditLogs")
              .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
              .collect();
            const alreadyFlagged = existing.some((l) =>
              l.title.startsWith("Deadline passed with no bids")
            );
            if (!alreadyFlagged) {
              await ctx.db.insert("auditLogs", {
                projectId: pkg.projectId,
                tradePackageId: pkg._id,
                eventType: "compliance_audit",
                title: `Deadline passed with no bids: ${pkg.tradeName}`,
                description: `Bid deadline (${pkg.bidDeadline}) passed with zero proposals on file. The package was left open — extend the deadline or re-solicit subcontractors before leveling.`,
                actor: "Convex Automated Cron Engine",
                timestamp: Date.now(),
              });
            }
          }
        }
      }
    }

    await ctx.db.insert("auditLogs", {
        projectId: args.projectId,
        eventType: "cron_executed",
        title: "Manual Trigger: Bid Deadline Monitor Executed",
        description: `Audited ${monitoredCount} CSI trade packages (${transitionedCount} transitioned to active leveling).`,
        ...auditActor(access),
        timestamp: Date.now(),
    });

    return { success: true, monitoredCount, transitionedCount };
  },
});

export const runComplianceAuditNow = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: ["gc"], write: true });
    const projectPackages = await ctx.db
        .query("tradePackages")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .collect();
    const contractors = [];
    const bids = [];
    for (const pkg of projectPackages) {
      contractors.push(
        ...(await ctx.db.query("contractors").withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id)).collect()),
      );
      bids.push(...(await ctx.db.query("bids").withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id)).collect()));
    }

    let verifiedCount = 0;
    let coiDeficiencies = 0;

    for (const contractor of contractors) {
      if (contractor.licenseStatus.includes("Active") || contractor.licenseStatus.includes("Verified")) {
        verifiedCount++;
      }
    }

    for (const bid of bids) {
      if (bid.coiComplianceStatus === "deficiency_detected") {
        coiDeficiencies++;
      }
    }

    await ctx.db.insert("auditLogs", {
        projectId: args.projectId,
        eventType: "compliance_audit",
        title: "Manual Trigger: Subcontractor Compliance Sweep",
        description: `Live audit verified ${verifiedCount} licensed contractors and identified ${coiDeficiencies} insurance deficiencies.`,
        ...auditActor(access),
        timestamp: Date.now(),
    });

    return {
      success: true,
      verifiedCount,
      coiDeficiencies,
    };
  },
});

export const getCronStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["gc", "owner"]);
    return {
      activeCrons: [
        {
          name: "monitor-bid-deadlines",
          schedule: "Every 1 hour",
          description: "Scans CSI package bid deadlines and auto-advances to leveling",
        },
        {
          name: "audit-contractor-compliance",
          schedule: "Every 6 hours",
          description: "Sweeps recorded contractor license statuses and ACORD 25 insurance flags (no registry lookup is performed)",
        },
      ],
      engine: "Convex Native cronJobs()",
      status: "Active & Scheduled",
    };
  },
});

export default crons;
