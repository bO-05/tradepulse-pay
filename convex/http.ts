import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";
import { agentmailWebhook } from "./agentmailWebhook";
import { getRealDocumentPdfBytes } from "./realDocuments";
import { auth } from "./auth";
import { paypalWebhook } from "./payments/webhook";
import { studioPreflight, studioProxy } from "./dashboard/studioProxy";
import { projectFileDownload, projectFilePreflight } from "./projectFileDownload";
import { buildLlmsTxt, PRODUCT_NAME } from "./lib/llmsTxt";

const http = httpRouter();

// Convex Auth (JWKS, OpenID config, /api/auth/* OAuth routes). Must stay ahead of
// the /api/ JSON-404 prefix handlers and the static-hosting catch-all below.
auth.addHttpRoutes(http);

// PayPal webhooks: public, but every delivery is signature-verified with PayPal before processing.
http.route({
  path: "/paypal/webhook",
  method: "POST",
  handler: paypalWebhook,
});

// AG Studio chat LLM proxy: requires the Convex Auth token (GC or owner); the Anthropic key stays server-side.
http.route({ path: "/ai/studio", method: "POST", handler: studioProxy });
http.route({ path: "/ai/studio", method: "OPTIONS", handler: studioPreflight });

// Inbound AgentMail webhook: public, but every delivery is Svix signature-verified before any write.
http.route({ path: "/agentmail/webhook", method: "POST", handler: agentmailWebhook });

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

// Machine-readable product description
http.route({
  path: "/llms.txt",
  method: "GET",
  handler: httpAction(async (_ctx, req) => {
    const siteUrl = process.env.CONVEX_SITE_URL || new URL(req.url).origin;
    const manifest = buildLlmsTxt(siteUrl);
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
        app: PRODUCT_NAME,
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

// Project uploads: bytes only for callers with access to the file's project (bearer token).
http.route({ pathPrefix: "/api/project-files/", method: "GET", handler: projectFileDownload });
http.route({ pathPrefix: "/api/project-files/", method: "OPTIONS", handler: projectFilePreflight });

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
