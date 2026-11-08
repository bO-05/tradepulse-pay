/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { READ_ONLY_REFERENCE_MESSAGE, REFERENCE_AGREEMENT_ID, REFERENCE_RUN_ID } from "../lib/demoReference";
import { signInAs } from "../lib/testIdentity";
import schema from "../schema";

/**
 * Freezing the settled Lopez residential job (VAL-RES-009, VAL-RES-014, VAL-CROSS-005).
 *
 * The freeze is one internal, deployment-locked mutation. Everything else in this file proves the
 * consequences: the seven write paths refuse with READ_ONLY_REFERENCE for both roles, the read
 * views carry the read-only state the UI renders, the commercial reference ids are untouched, and
 * a judge can still start (and reset) a private guided run.
 */

const modules = import.meta.glob("/convex/**/*.ts");
const RECOVERY_SITE = "https://cheery-axolotl-689.convex.site";

beforeAll(() => {
  process.env.CONVEX_SITE_URL = RECOVERY_SITE;
});
afterAll(() => {
  delete process.env.CONVEX_SITE_URL;
});

async function errorData(p: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await p;
  } catch (err) {
    const data = (err as { data?: unknown }).data;
    if (data !== undefined && data !== null && typeof data === "object") return data as { code?: string; message?: string };
    return { message: (err as Error).message };
  }
  throw new Error("expected the call to fail");
}

async function seed() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const ids = await t.run(async (ctx) => {
    const projects = await ctx.db.query("projects").collect();
    const lopez = projects.find((p) => p.title === "Lopez Kitchen Remodel");
    if (lopez === undefined) throw new Error("Lopez Kitchen Remodel is missing from the demo seed");
    const agreements = await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", lopez._id))
      .collect();
    const ortiz = agreements.find((a) => a.subcontractorName === "Ortiz Plumbing");
    if (ortiz === undefined) throw new Error("the Ortiz agreement is missing from the demo seed");
    const contractors = await ctx.db.query("contractors").collect();
    const rosendin = contractors.find((c) => c.companyName === "Rosendin Electric, Inc.");
    if (rosendin === undefined) throw new Error("the Rosendin contractor is missing from the demo seed");
    return {
      lopezId: lopez._id,
      agreementId: ortiz._id,
      contractorId: ortiz.contractorId,
      rosendinContractorId: rosendin._id,
    };
  });
  return { t, ...ids };
}

async function projectFlags(t: Awaited<ReturnType<typeof seed>>["t"]) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("projects").collect();
    return rows.map((p) => ({
      id: p._id,
      title: p.title,
      readOnlyReference: p.readOnlyReference === true,
      readOnlyDemoFixture: p.readOnlyDemoFixture === true,
    }));
  });
}

describe("freeze the settled residential reference", () => {
  test("protectResidentialReference freezes only Lopez and is idempotent", async () => {
    const { t, lopezId } = await seed();
    const before = await projectFlags(t);
    expect(before.find((p) => p.id === lopezId)?.readOnlyReference).toBe(false);

    const first = await t.mutation(internal.judgeDemo.reference.protectResidentialReference, {});
    expect(first).toEqual({ projectId: lopezId, alreadyProtected: false });

    const after = await projectFlags(t);
    expect(after.find((p) => p.id === lopezId)?.readOnlyReference).toBe(true);
    // Every other project keeps exactly the flags it had: the commercial walkthrough is not
    // repointed and no run project is frozen by this mutation.
    for (const row of before.filter((p) => p.id !== lopezId)) {
      expect(after.find((p) => p.id === row.id)).toEqual(row);
    }

    const second = await t.mutation(internal.judgeDemo.reference.protectResidentialReference, {});
    expect(second).toEqual({ projectId: lopezId, alreadyProtected: true });
    // The commercial reference identities the mission must never move are untouched constants.
    expect(REFERENCE_RUN_ID).toBe("nx74k1sdcnsmqzvkr97kf0ts598hch6p");
    expect(REFERENCE_AGREEMENT_ID).toBe("jn78x0j5xeh7q9gb55p26r7pdh8hdmjx");
  });

  test("the freeze is restricted to the recovery deployment", async () => {
    const { t } = await seed();
    process.env.CONVEX_SITE_URL = "https://another-deployment.convex.site";
    try {
      expect(await errorData(t.mutation(internal.judgeDemo.reference.protectResidentialReference, {}))).toMatchObject({
        code: "WRONG_DEPLOYMENT",
      });
    } finally {
      process.env.CONVEX_SITE_URL = RECOVERY_SITE;
    }
  });

  test("all seven write paths refuse with READ_ONLY_REFERENCE for the GC and the sub", async () => {
    const { t, lopezId, agreementId, contractorId } = await seed();
    const gc = await signInAs(t, "gc", { email: "gc@demo.tradepulse" });
    const sub = await signInAs(t, "sub", { email: "sub4@demo.tradepulse", contractorId });

    // Documents that would be writable on a live job are prepared before the freeze, so every
    // refusal below is caused by the reference lock and not by a missing record.
    const draw = await gc.as.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: lopezId });
    const draft = await sub.as.mutation(api.payApps.g703.startPayApp, { agreementId });
    const draftPayAppId = draft.payAppId;
    const evidenceId = await t.run(async (ctx) =>
      ctx.db.insert("waiverEvidence", {
        payAppId: draftPayAppId,
        agreementId,
        kind: "conditional",
        signedByUserId: sub.userId,
        signedByName: "Marisol Ortiz",
        amountCents: 400_000,
        throughDate: "2026-11-15",
        statementText: "Conditional waiver statement (test fixture).",
        statementHash: "a".repeat(64),
        statementVersion: "test",
        ticketHash: "b".repeat(64),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
    );

    await t.mutation(internal.judgeDemo.reference.protectResidentialReference, {});

    // (1) new owner draw, (2) save draw, (3) submit draw — GC role.
    // (4) sign waiver, (7) file pay app — sub role.
    // (5) set waiver gate, (6) create change order — GC role.
    const attempts: Array<{ path: string; role: "gc" | "sub"; call: () => Promise<unknown> }> = [
      { path: "new owner draw", role: "gc", call: () => gc.as.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: lopezId }) },
      {
        path: "save draw",
        role: "gc",
        call: () => gc.as.mutation(api.billing.ownerPayApps.saveOwnerPayApp, { ownerPayAppId: draw.ownerPayAppId, entries: [] }),
      },
      {
        path: "submit draw",
        role: "gc",
        call: () => gc.as.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId: draw.ownerPayAppId }),
      },
      {
        path: "sign waiver",
        role: "sub",
        call: () =>
          sub.as.mutation(api.lienWaivers.signWaiver, {
            payAppId: draftPayAppId,
            kind: "conditional",
            signedByName: "Marisol Ortiz",
            acknowledged: true,
            evidenceId,
          }),
      },
      { path: "set waiver gate", role: "gc", call: () => gc.as.mutation(api.lienWaivers.setGate, { agreementId, enabled: false }) },
      {
        path: "create change order",
        role: "gc",
        call: () =>
          gc.as.mutation(api.billing.changeOrders.createChangeOrder, {
            scope: "prime",
            projectId: lopezId,
            title: "Add under-cabinet lighting",
            description: "Reference job change order attempt.",
            amountCents: 120_000,
          }),
      },
      { path: "file pay app", role: "sub", call: () => sub.as.mutation(api.payApps.g703.submitPayApp, { payAppId: draftPayAppId }) },
      // The legacy filing path is kept alongside g703; it must refuse identically.
      {
        path: "file pay app (legacy submission)",
        role: "sub",
        call: () =>
          sub.as.mutation(api.payApps.submit.submitPayApplication, {
            agreementId,
            periodLabel: "Period 2",
            lines: [],
            notes: "",
            lienWaiver: false,
          }),
      },
    ];

    const observed: Record<string, string> = {};
    for (const attempt of attempts) {
      const data = await errorData(attempt.call());
      observed[`${attempt.path} (${attempt.role})`] = data.code ?? data.message ?? "no code";
      expect(data, attempt.path).toMatchObject({ code: "READ_ONLY_REFERENCE", message: READ_ONLY_REFERENCE_MESSAGE });
    }
    // Both party roles are represented, and the seven asserted paths are exactly the contract's.
    expect(Object.keys(observed).filter((k) => k.endsWith("(gc)"))).toHaveLength(5);
    expect(Object.keys(observed).filter((k) => k.endsWith("(sub)"))).toHaveLength(3);
  });

  test("the read views carry the read-only state the UI renders", async () => {
    const { t, lopezId, agreementId, contractorId } = await seed();
    const gc = await signInAs(t, "gc", { email: "gc@demo.tradepulse" });
    const sub = await signInAs(t, "sub", { email: "sub4@demo.tradepulse", contractorId });
    const draw = await gc.as.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: lopezId });
    const draft = await sub.as.mutation(api.payApps.g703.startPayApp, { agreementId });

    await t.mutation(internal.judgeDemo.reference.protectResidentialReference, {});

    // The pay app page shows the reference notice and hides every write control.
    const payApp = await sub.as.query(api.payApps.g703.getPayApp, { payAppId: draft.payAppId });
    expect(payApp).toMatchObject({
      readOnlyReference: true,
      editable: false,
      canSubmit: false,
      canWithdraw: false,
      canRevise: false,
      canDiscard: false,
      canApprove: false,
    });

    // The GC owner-billing tab disables "New owner pay app" and explains why.
    const list = await gc.as.query(api.billing.ownerPayApps.listOwnerPayApps, { projectId: lopezId });
    expect(list.readOnlyReference).toBe(true);
    expect(list.create).toMatchObject({ allowed: false, reason: READ_ONLY_REFERENCE_MESSAGE });

    // The draw detail view has no edit, submit or invoice controls on a frozen job.
    const detail = await gc.as.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId: draw.ownerPayAppId });
    expect(detail.readOnlyReference).toBe(true);
    expect(detail.controls).toMatchObject({
      edit: false,
      submit: false,
      refresh: false,
      delete: false,
      approve: false,
      requestChanges: false,
      sendInvoice: false,
      refreshStatus: false,
    });

    // The project row the project page reads carries the freeze flag.
    const project = await gc.as.query(api.projects.getProject, { projectId: lopezId });
    expect(project.readOnlyReference).toBe(true);
  });

  test("the guided demo is still resettable, private to its creator, and never touches the reference", async () => {
    const { t, lopezId, rosendinContractorId } = await seed();
    const gc = await signInAs(t, "gc", { email: "gc@demo.tradepulse" });
    const owner = await signInAs(t, "owner", { email: "owner@demo.tradepulse" });
    // The guided driver files on sub1 (Rosendin); the account must exist for startRun to award it.
    await signInAs(t, "sub", { email: "sub1@demo.tradepulse", contractorId: rosendinContractorId });

    await t.mutation(internal.judgeDemo.reference.protectResidentialReference, {});

    // A fresh run can still start after the freeze and is writable.
    const run = await gc.as.mutation(api.judgeDemo.runs.startRun, {});
    const mine = await gc.as.query(api.judgeDemo.runs.getRun, { runId: run.runId });
    expect(mine).not.toBeNull();
    expect(mine?.readOnlyReference).toBe(false);
    expect(mine?.agreementId).toBe(run.agreementId);

    // The run is private: the Owner account queries the id the GC created and reads "missing".
    expect(await owner.as.query(api.judgeDemo.runs.getRun, { runId: run.runId })).toBeNull();
    expect(await owner.as.query(api.judgeDemo.runs.getRunByPath, { runId: run.runId })).toBeNull();
    // A signed-out caller is still refused outright.
    await expect(t.query(api.judgeDemo.runs.getRun, {})).rejects.toThrow();

    // The demo reset still runs, and the frozen reference survives it untouched.
    const beforeReset = await t.run(async (ctx) => await ctx.db.get(lopezId));
    await gc.as.mutation(api.projects.seedInitialData, { force: true });
    const afterReset = await t.run(async (ctx) => await ctx.db.get(lopezId));
    expect(afterReset?.title).toBe("Lopez Kitchen Remodel");
    expect(afterReset?.readOnlyReference).toBe(true);
    expect(afterReset?.contractValueCents).toBe(beforeReset?.contractValueCents);
    expect(afterReset?.projectKind).toBe("residential");
    // The reset rebuilt the commercial walkthrough, so the demo still has its non-reference job.
    const after = await projectFlags(t);
    expect(after.some((p) => p.title === "The Domain Tower B - Commercial MEP")).toBe(true);
  }, 60_000);
});
