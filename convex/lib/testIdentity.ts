import type { TestConvex } from "convex-test";
import type { Id } from "../_generated/dataModel";
import type schema from "../schema";
import type { Role } from "./roles";

type T = TestConvex<typeof schema>;

/**
 * Test-only helper: inserts a users row (+ userProfiles row when `role` is set)
 * and returns an accessor whose identity matches what Convex Auth issues
 * (subject = "<userId>|<sessionId>").
 */
export async function signInAs(
  t: T,
  role: Role | null,
  opts: { email?: string; contractorId?: Id<"contractors">; paypalEmail?: string } = {},
) {
  const email = opts.email ?? `${role ?? "norole"}-${Math.random().toString(36).slice(2, 8)}@test.tradepulse`;
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email });
    if (role !== null) {
      await ctx.db.insert("userProfiles", {
        userId: id,
        role,
        displayName: `Test ${role}`,
        contractorId: opts.contractorId,
        paypalEmail: opts.paypalEmail,
        actorType: "human",
        createdAt: Date.now(),
      });
    }
    return id;
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|test-session`, email }) };
}

/** Convenience for legacy tests that exercise GC-only procurement mutations. */
export async function asGc(t: T) {
  return (await signInAs(t, "gc", { email: "gc@test.tradepulse" })).as;
}

export type GcTest = Awaited<ReturnType<typeof asGc>>;
