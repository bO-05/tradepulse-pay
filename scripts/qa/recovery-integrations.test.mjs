import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRecoveryTarget, assertMailScope, findByTarget, DEPLOYMENT, MAIL_EVENTS, PAYPAL_API } from "./recovery-integrations.mjs";

test("permits only recovery dev and mandatory PayPal sandbox without key overrides", () => {
  assert.doesNotThrow(() => assertRecoveryTarget(DEPLOYMENT, "sandbox", undefined));
  for (const other of ["earnest-mongoose-745", "exuberant-boar-323", "brainy-skunk-440"]) {
    assert.throws(() => assertRecoveryTarget(other, "sandbox", undefined));
  }
  assert.throws(() => assertRecoveryTarget(DEPLOYMENT, "live", undefined));
  assert.throws(() => assertRecoveryTarget(DEPLOYMENT, "sandbox", "override"));
  assert.equal(PAYPAL_API, "https://api-m.sandbox.paypal.com");
});

test("matches exact target URL and refuses duplicate registrations", () => {
  const target = "https://recovery.example/webhook";
  const old = { url: "https://original.example/webhook", id: "original" };
  const own = { url: target, id: "recovery" };
  assert.equal(findByTarget([old, own], target), own);
  assert.equal(findByTarget([old], target), undefined);
  assert.throws(() => findByTarget([own, { ...own, id: "duplicate" }], target));
  assert.equal(old.id, "original");
});

test("requires precisely the two app inboxes, handled events and no pod catchall", () => {
  const hook = { inbox_ids: ["dullstreet57@agentmail.to", "cleverneed464@agentmail.to"],
    event_types: MAIL_EVENTS, enabled: true };
  assert.doesNotThrow(() => assertMailScope(hook));
  assert.doesNotThrow(() => assertMailScope({ ...hook, inbox_ids: [...hook.inbox_ids].reverse() }));
  for (const changes of [
    { inbox_ids: [] }, { inbox_ids: [...hook.inbox_ids, "unrelated"] }, { pod_ids: ["all"] },
    { enabled: false }, { event_types: ["message.received"] },
  ]) assert.throws(() => assertMailScope({ ...hook, ...changes }));
});
