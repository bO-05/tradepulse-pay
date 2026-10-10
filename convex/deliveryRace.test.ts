/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildTenancyFixture } from "./lib/tenancyFixtures";
import { inviteStatusLabel } from "./lib/inviteRules";
import { SYSTEM_INBOX, RFQ_INBOX } from "./lib/mailer";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

async function inviteSetup() {
  const t = convexTest(schema, modules);
  const f = await buildTenancyFixture(t);
  const inviteId = await t.run((ctx) =>
    ctx.db.insert("invites", {
      tokenHash: "hash-race",
      email: "invitee@example.test",
      kind: "teammate",
      inviterCompanyId: f.gcA.companyId,
      status: "pending",
      expiresAt: Date.now() + 86_400_000,
      emailStatus: "not_sent",
      tokenVersion: 2,
      createdByUserId: f.gcA.admin.userId,
      createdAt: Date.now(),
    }),
  );
  return { t, f, inviteId };
}

async function reserve(t: T, key: string, kind: "invite" | "rfq" = "invite"): Promise<Id<"emailOutbox">> {
  const r = await t.mutation(internal.emailOutbox.reserveSend, {
    kind,
    to: "invitee@example.test",
    fromInbox: kind === "rfq" ? RFQ_INBOX : SYSTEM_INBOX,
    subject: "Invite",
    idempotencyKey: key,
  });
  if (r.action !== "send") throw new Error(`unexpected ${r.action}`);
  return r.outboxId;
}

const bounce = (t: T, messageId: string) =>
  t.mutation(internal.emailOutbox.recordDeliveryEvent, { agentmailMessageId: messageId, event: "bounced" });
const finish = (t: T, outboxId: Id<"emailOutbox">, messageId: string) =>
  t.mutation(internal.emailOutbox.finishSend, { outboxId, status: "sent", agentmailMessageId: messageId, threadId: "thread-1" });
const recordSent = (t: T, inviteId: Id<"invites">, tokenVersion: number) =>
  t.mutation(internal.invites.recordEmailResult, { inviteId, tokenVersion, emailStatus: "sent" });

describe("delivery failures that arrive before the send outcome is stored", () => {
  test("a bounce before the outbox row has its message id is kept and applied when the send finishes", async () => {
    const { t, inviteId } = await inviteSetup();
    const outboxId = await reserve(t, `invite.${inviteId}.2`);
    await bounce(t, "<early@ses>");
    await finish(t, outboxId, "<early@ses>");
    expect(await t.run((ctx) => ctx.db.get(outboxId))).toMatchObject({ status: "delivery_failed", deliveryEvent: "bounced", threadId: "thread-1" });

    await recordSent(t, inviteId, 2);
    const invite = (await t.run((ctx) => ctx.db.get(inviteId)))!;
    expect(invite).toMatchObject({ emailStatus: "bounced", emailError: expect.stringContaining("not delivered") });
    expect(inviteStatusLabel(invite, Date.now())).toBe("Pending · Email bounced");
    expect(await t.query(internal.emailOutbox.listForDay, {})).toMatchObject({ chargedCount: 1, sentCount: 0 });
  });

  test("a bounce between outbox completion and the invite result is not overwritten by Email sent", async () => {
    const { t, inviteId } = await inviteSetup();
    const outboxId = await reserve(t, `invite.${inviteId}.2`);
    await finish(t, outboxId, "<mid@ses>");
    await bounce(t, "<mid@ses>");
    await recordSent(t, inviteId, 2);
    expect(await t.run((ctx) => ctx.db.get(inviteId))).toMatchObject({ emailStatus: "bounced" });
    // A late finishSend (e.g. a reconcile) never turns the terminal row back into sent.
    await finish(t, outboxId, "<mid@ses>");
    expect(await t.run((ctx) => ctx.db.get(outboxId))).toMatchObject({ status: "delivery_failed" });
  });

  test("an old link's bounce or result never touches a rotated invite", async () => {
    const { t, inviteId } = await inviteSetup();
    const outboxId = await reserve(t, `invite.${inviteId}.2`);
    await finish(t, outboxId, "<old@ses>");
    await t.run((ctx) => ctx.db.patch(inviteId, { tokenVersion: 3, emailStatus: "not_sent" }));
    await bounce(t, "<old@ses>");
    await recordSent(t, inviteId, 2);
    expect(await t.run((ctx) => ctx.db.get(inviteId))).toMatchObject({ tokenVersion: 3, emailStatus: "not_sent" });

    const next = await reserve(t, `invite.${inviteId}.3`);
    await finish(t, next, "<new@ses>");
    await recordSent(t, inviteId, 3);
    expect(await t.run((ctx) => ctx.db.get(inviteId))).toMatchObject({ tokenVersion: 3, emailStatus: "sent" });
  });

  test("an early RFQ rejection is recorded on the project feed when the send finishes", async () => {
    const { t, f } = await inviteSetup();
    const outboxId = await reserve(t, `rfq.${f.gcA.project.contractorId}.123`, "rfq");
    await t.mutation(internal.emailOutbox.recordDeliveryEvent, { agentmailMessageId: "<rfq-early@ses>", event: "rejected" });
    await finish(t, outboxId, "<rfq-early@ses>");
    expect(await t.run((ctx) => ctx.db.get(outboxId))).toMatchObject({ status: "delivery_failed", deliveryEvent: "rejected" });
    const logs = await t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).filter((l) => l.eventType === "rfq_email_failed"));
    expect(logs).toHaveLength(1);
  });
});
