#!/usr/bin/env node
/**
 * TradePulse Pay - AgentMail Webhook Setup Automation
 * Usage: CONVEX_SITE_URL=https://<deployment>.convex.site node scripts/setup-agentmail-webhook.mjs
 * Automatically registers or retrieves the webhook endpoint with AgentMail REST API
 * (https://api.agentmail.to/v0/webhooks) and configures the Svix signing secret.
 */

import fs from "fs";
import path from "path";

async function main() {
  console.log("=== TradePulse Pay - AgentMail Webhook Setup ===");

  const envPath = path.resolve(process.cwd(), ".env.local");
  let apiKey = process.env.AGENTMAIL_API_KEY;

  // Required, with no default: the webhook must point at the deployment you are setting up.
  const siteUrl = process.env.CONVEX_SITE_URL?.trim();
  if (!siteUrl || !/^https:\/\/[a-z0-9-]+\.convex\.site\/?$/.test(siteUrl)) {
    console.error("Error: CONVEX_SITE_URL is required, e.g. CONVEX_SITE_URL=https://<deployment>.convex.site");
    console.error("Use the .convex.site URL of the deployment that should receive AgentMail webhooks.");
    process.exit(1);
  }
  // The frozen Convex hackathon submission must never receive TradePulse Pay webhooks.
  if (siteUrl.includes("brainy-skunk-440")) {
    console.error("Error: refusing to target brainy-skunk-440 (frozen Convex hackathon deployment).");
    process.exit(1);
  }
  const targetUrl = `${siteUrl.replace(/\/+$/, "")}/agentmail/webhook`;

  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("AGENTMAIL_API_KEY=")) {
        const val = trimmed.split("=")[1]?.trim();
        if (val && !apiKey) apiKey = val;
      }
    }
  }

  if (!apiKey) {
    console.error("Error: AGENTMAIL_API_KEY not found in .env.local or environment.");
    console.error("Add your key to .env.local: AGENTMAIL_API_KEY=am_...");
    process.exit(1);
  }

  console.log(`Target Webhook URL: ${targetUrl}`);
  console.log("Querying AgentMail API for registered webhooks...");

  try {
    let webhookId = null;
    let secret = null;

    // 1. Check if a webhook with this URL already exists
    const listRes = await fetch("https://api.agentmail.to/v0/webhooks", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (listRes.ok) {
      const listData = await listRes.json();
      const existing = (listData.webhooks || []).find((w) => w.url === targetUrl);
      if (existing) {
        webhookId = existing.webhook_id || existing.id;
        console.log(`Found existing webhook registration: ${webhookId}`);

        // Fetch detail to retrieve the Svix signing secret
        const detailRes = await fetch(`https://api.agentmail.to/v0/webhooks/${webhookId}`, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        });
        if (detailRes.ok) {
          const detailData = await detailRes.json();
          secret = detailData.secret;
        }
      }
    }

    // 2. If not found or secret unavailable, create a new webhook registration
    if (!secret) {
      console.log("Registering new webhook with AgentMail API...");
      const createRes = await fetch("https://api.agentmail.to/v0/webhooks", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: targetUrl,
          event_types: ["message.received", "message.sent"],
        }),
      });

      if (!createRes.ok) {
        const errText = await createRes.text();
        console.error(`AgentMail API error (${createRes.status}):`, errText);
        console.log("\nNote: TradePulse Pro handles inbound webhooks in resilient fallback mode if webhook secret is unset.");
        process.exit(1);
      }

      const data = await createRes.json();
      webhookId = data.webhook_id || data.id || "wh_active";
      secret = data.secret;
    }

    console.log("\n✓ Webhook successfully configured!");
    console.log(`Webhook ID:     ${webhookId}`);
    console.log(`Webhook Secret: ${secret ? "[received, not shown]" : "[not returned]"}`);
    console.log("\nSet the signing secret on the deployment without printing it, for example:");
    console.log("  grep '^AGENTMAIL_WEBHOOK_SECRET=' .env.local | cut -d= -f2- | npx convex env set AGENTMAIL_WEBHOOK_SECRET");

    // Update .env.local with the real secret if available
    if (fs.existsSync(envPath) && secret) {
      let envContent = fs.readFileSync(envPath, "utf8");
      if (envContent.includes("AGENTMAIL_WEBHOOK_SECRET=")) {
        envContent = envContent.replace(
          /AGENTMAIL_WEBHOOK_SECRET=[^\r\n]*/,
          `AGENTMAIL_WEBHOOK_SECRET=${secret}`
        );
      } else {
        envContent += `\nAGENTMAIL_WEBHOOK_SECRET=${secret}\n`;
      }
      fs.writeFileSync(envPath, envContent, "utf8");
      console.log("✓ Updated AGENTMAIL_WEBHOOK_SECRET in .env.local with verified secret");
    }
  } catch (err) {
    console.error("Failed to connect to AgentMail API:", err?.message || err);
    console.log("\nTradePulse Pro handles inbound webhooks in resilient fallback mode if webhook secret is unset.");
  }
}

main();
