#!/usr/bin/env node
/**
 * TradePulse Pay - AgentMail webhook setup for one Convex deployment.
 *
 * Usage (secrets loaded into the shell, never printed):
 *   set -a; . /path/to/secrets.env; set +a
 *   CONVEX_SITE_URL=https://<deployment>.convex.site node scripts/setup-agentmail-webhook.mjs
 *
 * Creates (or finds, idempotently via client_id "tradepulse-<deployment>") an AgentMail webhook to
 * <site>/agentmail/webhook scoped to the two app inboxes, then pipes its signing secret into
 * `npx convex env set AGENTMAIL_WEBHOOK_SECRET` on stdin. The secret is never printed or written to
 * disk. Use CONVEX_DEPLOY_KEY for the same deployment so the secret lands where the webhook points.
 * It never creates or deletes inboxes.
 */

import { spawnSync } from "node:child_process";

const API = "https://api.agentmail.to/v0";
const INBOX_IDS = ["dullstreet57@agentmail.to", "cleverneed464@agentmail.to"];
const EVENT_TYPES = ["message.received", "message.delivered", "message.bounced", "message.complained", "message.rejected"];

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function agentmail(apiKey, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) fail(`AgentMail ${init.method ?? "GET"} ${path} returned ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  // Required, with no default: the webhook must point at the deployment you are setting up.
  const siteUrl = process.env.CONVEX_SITE_URL?.trim();
  const match = siteUrl ? /^https:\/\/([a-z0-9-]+)\.convex\.site\/?$/.exec(siteUrl) : null;
  if (!match) {
    fail("CONVEX_SITE_URL is required, e.g. CONVEX_SITE_URL=https://<deployment>.convex.site");
  }
  const deployment = match[1];
  // The frozen Convex hackathon submission must never receive TradePulse Pay webhooks.
  if (deployment === "brainy-skunk-440") fail("refusing to target brainy-skunk-440 (frozen Convex hackathon deployment).");

  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) fail("AGENTMAIL_API_KEY is not set in the environment.");

  const url = `https://${deployment}.convex.site/agentmail/webhook`;
  const clientId = `tradepulse-${deployment}`;
  console.log(`Target: ${url} (client_id ${clientId})`);

  const created = await agentmail(apiKey, "/webhooks", {
    method: "POST",
    body: JSON.stringify({ url, client_id: clientId, inbox_ids: INBOX_IDS, event_types: EVENT_TYPES }),
  });
  const webhookId = created?.webhook_id;
  if (!webhookId) fail("AgentMail did not return a webhook id.");
  const detail = await agentmail(apiKey, `/webhooks/${encodeURIComponent(webhookId)}`);
  const secret = detail?.secret ?? created?.secret;
  if (!secret) fail("AgentMail did not return a signing secret.");

  console.log(`Webhook ${webhookId}: enabled=${detail.enabled} inbox_ids=${JSON.stringify(detail.inbox_ids ?? [])}`);
  console.log(`event_types=${JSON.stringify(detail.event_types ?? [])}`);
  const scoped = JSON.stringify([...(detail.inbox_ids ?? [])].sort()) === JSON.stringify([...INBOX_IDS].sort());
  if (!scoped) fail("the existing webhook for this client_id is not scoped to the two app inboxes; fix it before use.");

  const set = spawnSync("npx", ["convex", "env", "set", "AGENTMAIL_WEBHOOK_SECRET"], {
    input: secret,
    stdio: ["pipe", "ignore", "pipe"],
    encoding: "utf8",
  });
  if (set.status !== 0) {
    const err = String(set.stderr ?? "").split(secret).join("[redacted]");
    fail(`convex env set AGENTMAIL_WEBHOOK_SECRET failed: ${err.slice(0, 300)}`);
  }
  console.log("Set AGENTMAIL_WEBHOOK_SECRET on the Convex deployment (value not shown).");
}

main().catch((err) => fail(err?.message || String(err)));
