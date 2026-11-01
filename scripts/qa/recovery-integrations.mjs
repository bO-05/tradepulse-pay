#!/usr/bin/env node
/**
 * Isolated recovery-dev integration registration.
 * Read-only by default; pass --apply to create missing, URL-matched webhooks and
 * set only their two Convex settings through the official, dev-scoped MCP.
 * Credentials stay in memory. Never edits or removes an existing registration.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const DEPLOYMENT = "cheery-axolotl-689";
export const SITE = `https://${DEPLOYMENT}.convex.site`;
export const PAYPAL_API = "https://api-m.sandbox.paypal.com";
const AGENTMAIL_API = "https://api.agentmail.to/v0";
const INBOX_IDS = ["dullstreet57@agentmail.to", "cleverneed464@agentmail.to"];
export const MAIL_EVENTS = ["message.received", "message.delivered", "message.bounced", "message.complained", "message.rejected"];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export function assertRecoveryTarget(deployment, paypalEnvironment, deploymentKey) {
  if (deployment !== DEPLOYMENT || paypalEnvironment !== "sandbox" || deploymentKey) {
    throw new Error("Only the isolated recovery dev, PayPal sandbox and logged-in CLI identity are permitted.");
  }
}

export function findByTarget(webhooks, url) {
  const matches = webhooks.filter((item) => item.url === url);
  if (matches.length > 1) throw new Error("Duplicate target registrations require owner review; nothing was changed.");
  return matches[0];
}

export function assertMailScope(detail) {
  if (!sameSet(detail.inbox_ids ?? [], INBOX_IDS) || (detail.pod_ids ?? []).length ||
      !sameSet(detail.event_types ?? [], MAIL_EVENTS) || detail.enabled !== true) {
    throw new Error("Target AgentMail registration has unexpected scope, events or enablement; refusing changes.");
  }
}

function unpack(result) {
  if (result.isError) throw new Error("Official Convex MCP operation failed; values suppressed.");
  return result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === "text").text);
}

async function request(base, pathname, init = {}) {
  const url = new URL(pathname, `${base}/`);
  if (url.origin !== new URL(base).origin) throw new Error("Cross-origin integration request refused.");
  const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Integration API ${new URL(base).hostname} returned HTTP ${response.status}; response suppressed.`);
  return response.status === 204 ? null : response.json();
}

async function allMailWebhooks(headers) {
  const items = [];
  let token;
  const seen = new Set();
  do {
    const query = new URLSearchParams({ limit: "100" });
    if (token) query.set("page_token", token);
    const page = await request(AGENTMAIL_API, `/v0/webhooks?${query}`, { headers });
    items.push(...page.webhooks);
    token = page.next_page_token;
    if (token && seen.has(token)) throw new Error("AgentMail pagination repeated; refusing an incomplete inventory.");
    if (token) seen.add(token);
  } while (token);
  return items;
}

export async function main(apply = false) {
  if (process.env.CONVEX_DEPLOY_KEY) throw new Error("Unset deployment-key overrides before using this helper.");
  const client = new Client({ name: "tradepulse-recovery-integrations", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "node_modules/convex/bin/main.js"), "mcp", "start",
        "--project-dir", root, "--deployment", DEPLOYMENT,
        "--disable-tools", ["data", "envList", "envRemove", "functionSpec", "insights", "logs", "run",
          "runOneoffQuery", "tables", ...(!apply ? ["envSet"] : [])].join(",")],
      stderr: "ignore",
    }));
    const status = unpack(await client.callTool({ name: "status", arguments: { projectDir: root } }));
    const target = status.availableDeployments.find((item) => item.url === `https://${DEPLOYMENT}.convex.cloud`);
    if (!target || target.kind === "prod") throw new Error("Verified non-production target not found.");
    const call = async (name, args) => unpack(await client.callTool({
      name, arguments: { deploymentSelector: target.deploymentSelector, ...args },
    }));
    const read = async (name) => (await call("envGet", { name })).value;
    assertRecoveryTarget(DEPLOYMENT, await read("PAYPAL_ENV"), process.env.CONVEX_DEPLOY_KEY);
    console.log(`target: dev (${DEPLOYMENT}, isolated recovery), PayPal sandbox; mode=${apply ? "apply" : "inspect"}`);
    const set = async (name, value) => {
      if (!["PAYPAL_WEBHOOK_ID", "AGENTMAIL_WEBHOOK_SECRET"].includes(name)) throw new Error("Setting not allowed.");
      const existing = await read(name);
      if (existing && existing !== value) throw new Error(`Conflicting ${name}; refusing credential replacement.`);
      if (existing !== value) {
        console.log(`target: dev (${DEPLOYMENT}, isolated recovery); set ${name} (value suppressed)`);
        await call("envSet", { name, value });
      }
      if (await read(name) !== value) throw new Error(`Read-back failed for ${name}.`);
    };
    const result = { deployment: DEPLOYMENT, mode: apply ? "apply" : "inspect" };
    // Separate providers: one provider's permissions must not prevent the other.
    for (const provider of ["paypal", "agentmail"]) {
      try {
        if (provider === "paypal") {
          const id = await read("PAYPAL_CLIENT_ID");
          const secret = await read("PAYPAL_CLIENT_SECRET");
          if (!id || !secret) throw new Error("PayPal sandbox credentials are missing.");
          const oauth = await request(PAYPAL_API, "/v1/oauth2/token", {
            method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
              "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials",
          });
          const headers = { Authorization: `Bearer ${oauth.access_token}`, "Content-Type": "application/json" };
          const before = (await request(PAYPAL_API, "/v1/notifications/webhooks", { headers })).webhooks ?? [];
          const url = `${SITE}/paypal/webhook`;
          let hook = findByTarget(before, url);
          const source = await readFile(path.join(root, "convex/payments/webhookEvents.ts"), "utf8");
          const array = source.match(/HANDLED_EVENT_TYPES\s*=\s*\[([\s\S]*?)\]\s*as const/);
          if (!array) throw new Error("Cannot read app-handled PayPal event types.");
          const events = [...array[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
          if (!events.length || events.includes("*")) throw new Error("Unsafe PayPal event subscription.");
          if (!hook && apply) hook = await request(PAYPAL_API, "/v1/notifications/webhooks", {
            method: "POST", headers, body: JSON.stringify({ url, event_types: events.map((name) => ({ name })) }),
          });
          if (hook) {
            hook = await request(PAYPAL_API, `/v1/notifications/webhooks/${encodeURIComponent(hook.id)}`, { headers });
            if (hook.url !== url || !sameSet(hook.event_types.map((item) => item.name), events)) {
              throw new Error("Existing PayPal target has unexpected URL/events; refusing changes.");
            }
            if (apply) await set("PAYPAL_WEBHOOK_ID", hook.id);
          }
          const after = (await request(PAYPAL_API, "/v1/notifications/webhooks", { headers })).webhooks ?? [];
          result.paypal = { status: hook ? "registered" : "not_registered", id: hook?.id, target: url,
            events: events.length, registrationVerified: Boolean(hook), environmentVerified: true,
            settingVerified: Boolean(hook) && await read("PAYPAL_WEBHOOK_ID") === hook.id,
            originalRegistrationsPreserved: before.every((item) => after.some((next) => JSON.stringify(next) === JSON.stringify(item))) };
        } else {
          const apiKey = await read("AGENTMAIL_API_KEY");
          if (!apiKey) throw new Error("AgentMail API credential is missing.");
          const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
          const before = await allMailWebhooks(headers);
          const url = `${SITE}/agentmail/webhook`;
          let hook = findByTarget(before, url);
          if (!hook && apply) hook = await request(AGENTMAIL_API, "/v0/webhooks", {
            method: "POST", headers, body: JSON.stringify({
              url, client_id: `tradepulse-${DEPLOYMENT}`, inbox_ids: INBOX_IDS, event_types: MAIL_EVENTS,
            }),
          });
          if (hook) {
            hook = await request(AGENTMAIL_API, `/v0/webhooks/${encodeURIComponent(hook.webhook_id)}`, { headers });
            if (hook.url !== url) throw new Error("AgentMail target URL mismatch.");
            assertMailScope(hook);
            if (!hook.secret) throw new Error("AgentMail did not return the existing signing secret.");
            if (apply) await set("AGENTMAIL_WEBHOOK_SECRET", hook.secret);
          }
          const after = await allMailWebhooks(headers);
          const health = await request(SITE, "/agentmail/webhook");
          result.agentmail = { status: hook ? "registered" : "not_registered", id: hook?.webhook_id,
            target: url, registrationVerified: Boolean(hook), inboxScopeVerified: Boolean(hook), inboxCount: INBOX_IDS.length,
            settingVerified: Boolean(hook) && await read("AGENTMAIL_WEBHOOK_SECRET") === hook.secret,
            endpointVerificationEnforced: health.svixVerification === "enforced",
            originalRegistrationsPreserved: before.every((item) => after.some((next) => JSON.stringify(next) === JSON.stringify(item))) };
        }
      } catch (error) {
        result[provider] = { status: "blocked", reason: error.message };
        process.exitCode = 1;
      }
    }
    const discovery = await request("https://auth.agentid.com", "/.well-known/openid-configuration");
    result.agentid = {
      status: "owner_approval_required", discoveryVerified: discovery.issuer === "https://auth.agentid.com",
      registrationEndpoint: discovery.registration_endpoint,
      callback: `${SITE}/api/auth/callback/agentid`,
      credentialsPresent: Boolean(await read("AUTH_AGENTID_ID")) && Boolean(await read("AUTH_AGENTID_SECRET")),
      blocker: "Official CLI docs require browser approval by the active AgentID organization; registration has no unattended bypass. Existing clients were not copied or modified.",
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await client.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.includes("--apply")).catch(() => {
    console.error("Recovery integration operation failed; credentials and raw provider responses suppressed.");
    process.exitCode = 1;
  });
}
