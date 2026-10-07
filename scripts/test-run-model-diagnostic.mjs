// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
import { ConvexHttpClient } from "convex/browser";

const client = new ConvexHttpClient("https://brilliant-ferret-962.convex.cloud");

async function testDiagnostic() {
  console.log("==================================================");
  console.log("Testing Live runModelDiagnostic on Dev Convex...");
  console.log("==================================================");

  // 1. Claude Sonnet 5
  console.log("\n[1/3] Testing Claude Sonnet 5...");
  const t0 = Date.now();
  try {
    const claudeRes = await client.action("llmRouter:runModelDiagnostic", {
      model: "claude",
      promptType: "spec_div26",
    });
    console.log(`Claude Sonnet 5 Result in ${Date.now() - t0}ms:`, {
      provider: claudeRes.provider,
      model: claudeRes.model,
      latencyMs: claudeRes.latencyMs,
      throughputTokSec: claudeRes.throughputTokSec,
      hasJson: Boolean(claudeRes.parsedJson),
      preview: claudeRes.content.slice(0, 150) + "...",
    });
  } catch (err) {
    console.error("Claude Diagnostic failed:", err);
  }

  // 2. Gemini 3.8 Flash
  console.log("\n[2/3] Testing Gemini 3.8 Flash...");
  const t1 = Date.now();
  try {
    const geminiRes = await client.action("llmRouter:runModelDiagnostic", {
      model: "gemini",
      promptType: "spec_div26",
    });
    console.log(`Gemini 3.8 Flash Result in ${Date.now() - t1}ms:`, {
      provider: geminiRes.provider,
      model: geminiRes.model,
      latencyMs: geminiRes.latencyMs,
      throughputTokSec: geminiRes.throughputTokSec,
      hasJson: Boolean(geminiRes.parsedJson),
      preview: geminiRes.content.slice(0, 150) + "...",
    });
  } catch (err) {
    console.error("Gemini Diagnostic failed:", err);
  }

  // 3. OpenAI (fallback or key)
  console.log("\n[3/3] Testing OpenAI route / fallback...");
  const t2 = Date.now();
  try {
    const openaiRes = await client.action("llmRouter:runModelDiagnostic", {
      model: "openai",
      promptType: "spec_div26",
    });
    console.log(`OpenAI Route Result in ${Date.now() - t2}ms:`, {
      provider: openaiRes.provider,
      model: openaiRes.model,
      latencyMs: openaiRes.latencyMs,
      throughputTokSec: openaiRes.throughputTokSec,
      hasJson: Boolean(openaiRes.parsedJson),
      preview: openaiRes.content.slice(0, 150) + "...",
    });
  } catch (err) {
    console.error("OpenAI Diagnostic failed:", err);
  }
}

testDiagnostic().catch(console.error);
