import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { AgentMail } from "@agentmail/convex";
import { components, internal } from "./_generated/api";
import { getRealDocumentPdfBytes } from "./realDocuments";
import { auth } from "./auth";

const http = httpRouter();

// Convex Auth (JWKS, OpenID config, /api/auth/* OAuth routes). Must stay ahead of
// the /api/ JSON-404 prefix handlers and the static-hosting catch-all below.
auth.addHttpRoutes(http);

// Inbound AgentMail Webhook. Never mutate procurement records without Svix verification.
http.route({
  path: "/agentmail/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.AGENTMAIL_WEBHOOK_SECRET;
    const hasSvixHeaders =
      Boolean(req.headers.get("svix-id")) &&
      Boolean(req.headers.get("svix-signature"));

    // Enforce Svix cryptographic verification whenever secret is configured
    if (secret) {
      if (!hasSvixHeaders) {
        return new Response(
          JSON.stringify({ error: "Missing required svix headers for signature verification" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
      try {
        const activeAgentMail = new AgentMail(components.agentmail, {
          webhookSecret: secret,
          onMessageReceived: internal.email.onMessageReceived,
        });
        return await activeAgentMail.handleWebhook(ctx as any, req);
      } catch (err: any) {
        console.warn("AgentMail Svix verification failed:", err?.message || err);
        return new Response(
          JSON.stringify({ error: err?.message || "Webhook verification failed" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    return new Response(
      JSON.stringify({ error: "Webhook verification is not configured." }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }),
});

// AgentMail Webhook status / health probe
http.route({
  path: "/agentmail/webhook",
  method: "GET",
  handler: httpAction(async () => {
    const isConfigured = Boolean(process.env.AGENTMAIL_WEBHOOK_SECRET);
    return new Response(
      JSON.stringify({
        status: "active",
        endpoint: "/agentmail/webhook",
        svixVerification: isConfigured ? "enforced" : "not_configured",
        instructions: isConfigured
          ? "Webhook secret configured and active."
          : "Webhook disabled until AGENTMAIL_WEBHOOK_SECRET is configured.",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }),
});

// Wayne Sutton / Vibe Apps llms.txt discoverability endpoint
http.route({
  path: "/llms.txt",
  method: "GET",
  handler: httpAction(async () => {
    const siteUrl = process.env.CONVEX_SITE_URL || "https://brainy-skunk-440.convex.site";
    const manifest = `# TradePulse Pro - Autonomous Construction Procurement API
> Autonomous Trade Subcontractor Procurement, RFQ Distribution & Real-Time Bid Leveling
> Built for the Convex "All Gas" Hackathon 2026

## Overview
TradePulse Pro automates the $1.8T commercial construction subcontractor procurement workflow:
1. CSI MasterFormat Trade Scoping (Div 22 Plumbing, Div 23 HVAC, Div 26 Electrical)
2. Subcontractor Web Discovery with per-record provenance (license data only when published in the source)
3. Programmatic Project Inboxes via AgentMail (@agentmail.to) — shared when the free-tier plan limit is reached, disclosed on each package
4. Autonomous Pre-Bid RFI Clarifications via OpenAI, Gemini & Claude high-throughput reasoning (OpenAI is a BYOK adapter; Gemini/Claude run when no OpenAI key is configured)
5. Forensic Bid Leveling & Scope Gap Normalization via Claude & OpenAI (OpenAI is a BYOK adapter)

## Live Endpoints & Endpoints Specification
- Web UI: ${siteUrl}
- Webhook Ingest: POST ${siteUrl}/agentmail/webhook
- Discoverability: GET ${siteUrl}/llms.txt
- Reactive Engine: Convex Realtime WebSockets (Zero Polling Invariant)

## Verification & Audit Trail
- Public repository: https://github.com/bO-05/tradepulse-pro
- Independent audit + remediation reports: docs/audits/ (audit-6-usefulness, audit-6-remediation)
- Browser-only re-verification guide for auditors: docs/audits/audit-6-remediation.md (section 9)

## Normalization Formula (ADR-0003)
Leveled Cost = Base Bid + Sum(Scope Gaps) + Lead Time Penalty + COI Penalty - Accepted Alternates

## Sponsor Synergy
- Convex: Reactive backend, real-time database, scheduled functions, HTTP actions, static hosting
- OpenAI: BYOK adapter for structured extraction and bid parsing (activates when OPENAI_API_KEY is configured; the pipeline routes to Gemini/Claude otherwise)
- Firecrawl: Subcontractor web discovery with provenance labels; state-registry verification only when a registry page is actually the source
- AgentMail: Stateful programmatic email inboxes for subcontractor bidding
`;
    return new Response(manifest, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }),
});

// Health check endpoint
http.route({
  path: "/api/health",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(
      JSON.stringify({
        status: "ok",
        app: "TradePulse Pro",
        timestamp: Date.now(),
        version: "1.0.0",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }),
});

// Helper function to serve authentic construction PDF documents
function serveRealDocument(fileName: string): Response {
  const cleanName = fileName.replace(/^[/\\]+/, "").split(/[?#]/)[0];
  const pdfBytes = getRealDocumentPdfBytes(cleanName);
  if (!pdfBytes) {
    return new Response(
      JSON.stringify({
        error: "Document not found in certified registry",
        requestedFile: cleanName,
        availableDocuments: [
          "01_00_00_General_Requirements.pdf",
          "26_00_00_Electrical_Systems_Spec.pdf",
          "23_00_00_HVAC_Systems_Spec.pdf",
          "22_00_00_Plumbing_Systems_Spec.pdf",
          "E-101_Main_Switchgear_Penthouse_Plan.pdf",
          "Rosendin_Electric_Proposal_AIA.pdf",
          "Alterman_Power_Quote_Proposal.pdf",
          "Rosendin_Electric_ACORD25_COI.pdf",
        ],
      }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(pdfBytes as any, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${cleanName}"`,
      "Content-Length": String(pdfBytes.length),
      "Cache-Control": "no-cache, must-revalidate",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// 1. CSI MasterFormat Technical Specifications (Div 01, Div 26, Div 23, Div 22)
http.route({
  pathPrefix: "/specs/",
  method: "GET",
  handler: httpAction(async (_ctx, req) => {
    const url = new URL(req.url);
    const fileName = url.pathname.replace(/^\/specs\//, "");
    return serveRealDocument(fileName);
  }),
});

// 2. BIM Architectural Drawings & Switchgear Penthouse Blueprints
http.route({
  pathPrefix: "/drawings/",
  method: "GET",
  handler: httpAction(async (_ctx, req) => {
    const url = new URL(req.url);
    const fileName = url.pathname.replace(/^\/drawings\//, "");
    return serveRealDocument(fileName);
  }),
});

// 3. Subcontractor Itemized Proposals & AIA Quotations
http.route({
  pathPrefix: "/quotes/",
  method: "GET",
  handler: httpAction(async (_ctx, req) => {
    const url = new URL(req.url);
    const fileName = url.pathname.replace(/^\/quotes\//, "");
    return serveRealDocument(fileName);
  }),
});

// 4. ACORD 25 Certificates of Liability Insurance
http.route({
  pathPrefix: "/insurance/",
  method: "GET",
  handler: httpAction(async (_ctx, req) => {
    const url = new URL(req.url);
    const fileName = url.pathname.replace(/^\/insurance\//, "");
    return serveRealDocument(fileName);
  }),
});

// 5. Universal Document Access Endpoints
http.route({
  pathPrefix: "/api/files/",
  method: "GET",
  handler: httpAction(async (_ctx, req) => {
    const url = new URL(req.url);
    const fileName = url.pathname.replace(/^\/api\/files\//, "");
    return serveRealDocument(fileName);
  }),
});

http.route({
  pathPrefix: "/files/",
  method: "GET",
  handler: httpAction(async (_ctx, req) => {
    const url = new URL(req.url);
    const fileName = url.pathname.replace(/^\/files\//, "");
    return serveRealDocument(fileName);
  }),
});

// Explicit JSON 404 responses for unknown API / webhook paths.
// These are registered BEFORE the static hosting fallback so machine clients never receive
// the SPA HTML shell with HTTP 200 for a bad API path (keep SPA fallback only for real routes).
function jsonNotFound(req: Request, prefix: string): Response {
  return new Response(
    JSON.stringify({
      error: "Not found",
      path: new URL(req.url).pathname,
      apiPrefix: prefix,
      hint: "Check the API path or see /llms.txt for available endpoints.",
    }),
    { status: 404, headers: { "Content-Type": "application/json" } }
  );
}

http.route({
  pathPrefix: "/api/",
  method: "GET",
  handler: httpAction(async (_ctx, req) => jsonNotFound(req, "/api/")),
});

http.route({
  pathPrefix: "/api/",
  method: "POST",
  handler: httpAction(async (_ctx, req) => jsonNotFound(req, "/api/")),
});

http.route({
  pathPrefix: "/agentmail/",
  method: "GET",
  handler: httpAction(async (_ctx, req) => jsonNotFound(req, "/agentmail/")),
});

http.route({
  pathPrefix: "/agentmail/",
  method: "POST",
  handler: httpAction(async (_ctx, req) => jsonNotFound(req, "/agentmail/")),
});

// CRITICAL: Register static routes at the end of app-owned HTTP router!
registerStaticRoutes(http, components.staticHosting);

export default http;
