// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
import { ConvexHttpClient } from "convex/browser";

async function testModelDiagnostics(deploymentName, url) {
  console.log(`\n========================================`);
  console.log(`Testing Live LLMs on ${deploymentName}: ${url}`);
  console.log(`========================================`);
  const client = new ConvexHttpClient(url);

  for (const model of ["claude", "gemini", "openai"]) {
    process.stdout.write(`Testing model: ${model.padEnd(8)} ... `);
    const t0 = Date.now();
    try {
      const res = await client.action("llmRouter:runModelDiagnostic", {
        model,
        promptType: "spec_div26",
      });
      const dur = Date.now() - t0;
      console.log(`OK (${dur} ms) | provider: ${res.provider} | model: ${res.model} | tokens: in=${res.inputTokens} out=${res.outputTokens} (${res.throughputTokSec} tok/s)`);
    } catch (err) {
      console.log(`FAILED:`, err.message);
    }
  }
}

async function main() {
  await testModelDiagnostics("DEV", "https://brilliant-ferret-962.convex.cloud");
  await testModelDiagnostics("PROD", "https://brainy-skunk-440.convex.cloud");
}

main().catch(console.error);
