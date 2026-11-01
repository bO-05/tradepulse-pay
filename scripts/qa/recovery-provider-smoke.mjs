/**
 * Recovery DEV only: two real Mistral calls, through authenticated procurement
 * diagnostics and the Studio protocol proxy. No business writes or tool execution.
 * Uses a fresh public demo login; its token stays in memory and is revoked.
 * This does not certify the separately licensed Studio UI.
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cloud = "https://cheery-axolotl-689.convex.cloud";
const site = "https://cheery-axolotl-689.convex.site";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const client = new ConvexHttpClient(cloud);
const report = { target: site, checks: {}, errors: [] };
let token;
let phase = "sign-in";
try {
  const login = await client.action(api.auth.signIn, {
    provider: "password",
    params: { flow: "signIn", email: "gc@demo.tradepulse", password: "TradePulseDemo!2026" },
  });
  token = login.tokens?.token;
  if (!token) throw new Error("No temporary demo session.");
  client.setAuth(token);

  phase = "procurement diagnostic";
  const diagnostic = await client.action(api.llmRouter.runModelDiagnostic, {
    model: "mistral", promptType: "spec_div26",
  });
  report.checks.procurement = {
    provider: diagnostic.provider,
    model: diagnostic.model,
    isLive: diagnostic.isLive,
    usedFallback: diagnostic.usedFallback,
  };
  if (diagnostic.provider !== "Mistral" || !diagnostic.isLive || diagnostic.usedFallback) {
    report.errors.push("Procurement did not return a live Mistral result.");
  }

  phase = "Studio protocol proxy";
  const response = await fetch(`${site}/ai/studio`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      input: [{ type: "message", role: "user", content: "Call readSandboxStatus once. Do not send money." }],
      tools: [{
        name: "readSandboxStatus", description: "Read-only test tool. Returns sandbox status.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }],
      toolChoice: "required",
    }),
    signal: AbortSignal.timeout(120_000),
  });
  report.checks.studioHttpStatus = response.status;
  if (!response.ok) throw new Error("Studio protocol request failed.");
  const lines = (await response.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const result = lines.find(line => line.kind === "final")?.response;
  const tools = (result?.output ?? []).filter(item => item.type === "function_call").map(item => item.name);
  report.checks.studio = {
    model: result?.model,
    status: result?.status,
    usage: result?.usage,
    tools,
    eventTypes: lines.filter(line => line.kind === "event").map(line => line.event.type),
  };
  if (result?.status !== "completed" || !/^mistral-large-4(?:-|$)/.test(result.model ?? "") ||
      !tools.includes("readSandboxStatus")) {
    report.errors.push("Studio did not return the requested real Mistral tool call.");
  }
} catch {
  // SDK errors can contain request headers or prompts. Record only our phase.
  report.errors.push(`Recovery provider smoke failed during ${phase}.`);
} finally {
  if (token) {
    try { await client.action(api.auth.signOut, {}); }
    catch { report.errors.push("Could not revoke the temporary demo session."); }
    client.clearAuth();
  }
  const directory = path.join(root, "evidence", `recovery-provider-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${directory}`);
  console.log(JSON.stringify(report, null, 2));
}
if (report.errors.length) process.exitCode = 1;
