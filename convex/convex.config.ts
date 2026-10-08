import { defineApp } from "convex/server";
import { v } from "convex/values";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import firecrawl from "@firecrawl/firecrawl-convex/convex.config";
import agentmail from "@agentmail/convex/convex.config";

const app = defineApp({
  env: {
    // Must stay required: the firecrawl component declares FIRECRAWL_API_KEY as
    // required, and Convex rejects binding it to an optional parent var. Pushes
    // fail until it is set (scripts/sync-convex-env.sh sets it).
    FIRECRAWL_API_KEY: v.string(),
    FIRECRAWL_WEBHOOK_SECRET: v.optional(v.string()),
    AGENTMAIL_API_KEY: v.optional(v.string()),
    AGENTMAIL_WEBHOOK_SECRET: v.optional(v.string()),
    EMAIL_DAILY_BUDGET: v.optional(v.string()),
    OPENAI_API_KEY: v.optional(v.string()),
    GEMINI_API_KEY: v.optional(v.string()),
    ANTHROPIC_API_KEY: v.optional(v.string()),
    VERTEX_PROJECT_ID: v.optional(v.string()),
    VERTEX_LOCATION: v.optional(v.string()),
    VERTEX_ACCESS_TOKEN: v.optional(v.string()),
    VERTEX_API_KEY: v.optional(v.string()),
    VERTEX_MODEL: v.optional(v.string()),
    GEMINI_MODEL: v.optional(v.string()),
    ANTHROPIC_MODEL: v.optional(v.string()),
    OPENAI_MODEL: v.optional(v.string()),
    PAYPAL_CLIENT_ID: v.optional(v.string()),
    PAYPAL_CLIENT_SECRET: v.optional(v.string()),
    PAYPAL_ENV: v.optional(v.string()),
    PAYPAL_WEBHOOK_ID: v.optional(v.string()),
    PAYPAL_SANDBOX_GC_BUYER_EMAIL: v.optional(v.string()),
    PAYPAL_SANDBOX_SUB1_EMAIL: v.optional(v.string()),
    PAYPAL_SANDBOX_SUB2_EMAIL: v.optional(v.string()),
    PAYPAL_SANDBOX_SUB3_EMAIL: v.optional(v.string()),
    PAYPAL_SANDBOX_OWNER_EMAIL: v.optional(v.string()),
    KERNEL_API_KEY: v.optional(v.string()),
    AUTH_AGENTID_ID: v.optional(v.string()),
    AUTH_AGENTID_SECRET: v.optional(v.string()),
    JWT_PRIVATE_KEY: v.optional(v.string()),
    JWKS: v.optional(v.string()),
    SITE_URL: v.optional(v.string()),
  },
});

// 1. Static hosting on the deployment's .convex.site origin (app-owned root router mode)
app.use(staticHosting);

// 2. Firecrawl web discovery & durable crawler component
app.use(firecrawl, {
  httpPrefix: "/firecrawl/",
  env: {
    FIRECRAWL_API_KEY: app.env.FIRECRAWL_API_KEY as any,
    FIRECRAWL_WEBHOOK_SECRET: app.env.FIRECRAWL_WEBHOOK_SECRET,
  },
});

// 3. AgentMail component: kept mounted only so its existing tables are not dropped.
// The app does not call it. Sends go through convex/lib/mailer.ts and inbound
// webhooks through convex/agentmailWebhook.ts (which reuses its Svix verifier).
app.use(agentmail);

export default app;
