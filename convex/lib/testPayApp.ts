import type { TestConvex } from "convex-test";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type schema from "../schema";

type T = TestConvex<typeof schema>;
type Caller = Pick<T, "action">;

/**
 * Test-only: an approved Phase-1 style pay app (no G702) on the tranche's agreement whose approved
 * gross is `amountCents`, so payout mechanics can be exercised through the real canPay path.
 */
export async function insertApprovedPayApp(t: T, milestoneId: Id<"milestones">, amountCents: number): Promise<Id<"payApplications">> {
  return await t.run(async (ctx) => {
    const milestone = (await ctx.db.get(milestoneId))!;
    const user = (await ctx.db.query("users").first())!;
    const now = Date.now();
    return await ctx.db.insert("payApplications", {
      agreementId: milestone.agreementId,
      subUserId: user._id,
      periodLabel: `Test period ${now}`,
      lines: [],
      requestedTotalCents: amountCents,
      notes: "",
      lienWaiver: true,
      status: "approved",
      submittedBy: { userId: user._id, actorType: "human" },
      finalApproval: { totalCents: amountCents, lines: [], approvedBy: user._id, approvedAt: now },
      createdAt: now,
    });
  });
}

const payAppsByKey = new WeakMap<T, Map<string, Promise<Id<"payApplications">>>>();

/**
 * What the removed milestone "Release & pay" did, now through an approved pay app: one approved pay
 * app per `requestKey` (so a repeated key is a double click on the same pay app), paid from the tranche.
 */
export async function payFromTranche(
  t: T,
  caller: Caller,
  args: { milestoneId: Id<"milestones">; amountCents: number; requestKey: string },
) {
  let byKey = payAppsByKey.get(t);
  if (byKey === undefined) {
    byKey = new Map();
    payAppsByKey.set(t, byKey);
  }
  let pending = byKey.get(args.requestKey);
  if (pending === undefined) {
    pending = insertApprovedPayApp(t, args.milestoneId, args.amountCents);
    byKey.set(args.requestKey, pending);
  }
  return await caller.action(api.billing.pay.payPayApp, { payAppId: await pending, trancheId: args.milestoneId });
}
