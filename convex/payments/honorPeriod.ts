import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { env, internalAction, type ActionCtx } from "../_generated/server";
import { toPayPalString } from "../lib/money";
import { paypalErrorData } from "./captures";
import { HONOR_PERIOD_MS } from "./funding";
import type { BeginWatch } from "./honorPeriodDb";
import { payPalClientForAction } from "./paypalClient";

/**
 * Honor-period watcher (architecture §4 step 6), run hourly from convex/crons.ts. For each funded,
 * uncaptured authorization past its 3-day honor period and before expiry it calls
 * POST /v2/payments/authorizations/{id}/reauthorize; expired authorizations are closed without a call.
 * A PayPal rejection is logged and leaves the original authorization intact. One row's failure never
 * stops the others.
 *
 * Validators: backdate a row with `payments/testing:backdateAuthorization`, then
 * `npx convex run payments/honorPeriod:watchAuthorizations '{"paymentId":"<id>"}'`.
 */

const outcomeValidator = v.object({
  paymentId: v.id("payments"),
  outcome: v.union(
    v.literal("reauthorized"),
    v.literal("rejected"),
    v.literal("expired"),
    v.literal("skipped"),
    v.literal("error"),
  ),
  detail: v.string(),
  authorizationId: v.optional(v.string()),
  newAuthorizationId: v.optional(v.string()),
  issues: v.optional(v.array(v.string())),
});
type Outcome = Infer<typeof outcomeValidator>;

async function watchOne(ctx: ActionCtx, paymentId: Id<"payments">, now: number): Promise<Outcome> {
  const begun: BeginWatch = await ctx.runMutation(internal.payments.honorPeriodDb.beginWatch, { paymentId, now });
  if (begun.state === "skip") return { paymentId, outcome: "skipped", detail: begun.reason };
  if (begun.state === "expired") {
    return { paymentId, outcome: "expired", detail: `payment expired; milestone ${begun.milestoneStatus ?? "unchanged"}` };
  }

  const paypal = payPalClientForAction(ctx, env, {
    actor: "system:honor-period-watcher",
    projectId: begun.projectId,
    agreementId: begun.agreementId,
  });
  let out;
  try {
    out = await paypal.sdkWrite("paypal.authorizations.reauthorize", begun.requestId, (sdk, paypalRequestId) =>
      sdk.payments.reauthorizePayment({
        authorizationId: begun.authorizationId,
        paypalRequestId,
        prefer: "return=representation",
        body: { amount: { currencyCode: "USD", value: toPayPalString(begun.amountCents) } },
      }),
    );
  } catch (e) {
    const data = paypalErrorData(e);
    if (data !== null && data.status < 500) {
      await ctx.runMutation(internal.payments.honorPeriodDb.recordReauthorizeRejected, {
        paymentId,
        authorizationId: begun.authorizationId,
        httpStatus: data.status,
        paypalName: data.name,
        issues: data.issues,
        message: data.message,
      });
      return {
        paymentId,
        outcome: "rejected",
        detail: `PayPal ${data.status} ${data.name}: ${data.message}`,
        authorizationId: begun.authorizationId,
        issues: data.issues,
      };
    }
    // Network or 5xx: nothing is stored, so the next run retries with the same PayPal-Request-Id.
    const message = e instanceof ConvexError ? String((e.data as { message?: unknown })?.message ?? "PayPal error") : "unknown error";
    return { paymentId, outcome: "error", detail: `Reauthorization outcome unknown (${message}); retried next run.`, authorizationId: begun.authorizationId };
  }

  const auth = out.response.result;
  if (!auth?.id) {
    return { paymentId, outcome: "error", detail: "PayPal did not return a new authorization id.", authorizationId: begun.authorizationId };
  }
  const created = auth.createTime ? Date.parse(auth.createTime) : NaN;
  const expires = auth.expirationTime ? Date.parse(auth.expirationTime) : NaN;
  await ctx.runMutation(internal.payments.honorPeriodDb.recordReauthorization, {
    paymentId,
    previousAuthorizationId: begun.authorizationId,
    newAuthorizationId: auth.id,
    paypalStatus: auth.status,
    honorPeriodEndsAt: (Number.isFinite(created) ? created : Date.now()) + HONOR_PERIOD_MS,
    authorizationExpiresAt: Number.isFinite(expires) ? expires : undefined,
    auditRecorded: out.auditRecorded,
  });
  return {
    paymentId,
    outcome: "reauthorized",
    detail: `new authorization ${auth.id} (${auth.status ?? "status not returned"})`,
    authorizationId: begun.authorizationId,
    newAuthorizationId: auth.id,
  };
}

export const watchAuthorizations = internalAction({
  args: { paymentId: v.optional(v.id("payments")) },
  returns: v.object({ checkedAt: v.number(), results: v.array(outcomeValidator) }),
  handler: async (ctx, { paymentId }) => {
    const now = Date.now();
    const ids: Id<"payments">[] = await ctx.runQuery(internal.payments.honorPeriodDb.listWatched, { paymentId });
    const results: Outcome[] = [];
    for (const id of ids) {
      try {
        results.push(await watchOne(ctx, id, now));
      } catch (e) {
        const message = e instanceof Error ? e.message : "unknown error";
        console.error(`Honor-period watcher failed for ${id}: ${message}`);
        results.push({ paymentId: id, outcome: "error", detail: message });
      }
    }
    return { checkedAt: now, results };
  },
});
