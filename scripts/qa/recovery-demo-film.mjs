#!/usr/bin/env node
/**
 * Records the actual hosted recovery app, no mocks or financial writes.
 * Ordinary public demo sign-in and read-only inspection of the independently settled run.
 * Requires locally generated WAVs, Chrome and FFmpeg. No external voice service or uploads.
 * Usage: node scripts/qa/recovery-demo-film.mjs <absolute-narration-directory>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const audio = process.argv[2];
if (!audio || !path.isAbsolute(audio) || process.argv.length !== 3) throw new Error("Pass one absolute narration directory.");
if (!path.resolve(audio).startsWith(path.join(root, ".system_generated") + path.sep)) throw new Error("Use generated workspace narration only.");
const site = "https://cheery-axolotl-689.convex.site";
const runId = "nx74k1sdcnsmqzvkr97kf0ts598hch6p";
const agreementId = "jn78x0j5xeh7q9gb55p26r7pdh8hdmjx";
const agentPayAppId = "ph7fh2dpqnx82kq1dn3gwcp8yx8hcem6";
const directory = path.join(root, "evidence", `submission-film-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(directory, { recursive: true });
const ffmpeg = process.env.QA_FFMPEG_PATH || "C:/Program Files (x86)/FFmpeg/bin/ffmpeg.exe";
const ffprobe = process.env.QA_FFPROBE_PATH || "C:/Program Files (x86)/FFmpeg/bin/ffprobe.exe";
const scenes = JSON.parse(fs.readFileSync(path.join(root, "docs/submission-demo-script.json"), "utf8")).map((scene) => {
  const wav = path.join(audio, `${scene.scene}.wav`);
  const probe = spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", wav], { encoding: "utf8" });
  const seconds = Number(probe.stdout?.trim());
  if (probe.status !== 0 || !Number.isFinite(seconds) || seconds <= 0) throw new Error("Narration duration is invalid.");
  return { ...scene, wav, duration: Math.ceil((seconds + 1.2) * 6) / 6 };
});
const duration = scenes.reduce((sum, scene) => sum + scene.duration, 0);
if (duration >= 178) throw new Error("Narration is too long for a public video under three minutes.");
const report = { target: site, durationSeconds: duration, mode: "Actual app; read-only tour of a previously settled sandbox run",
  narration: "Offline synthetic voice, Microsoft Zira Desktop", scenes: [], errors: [] };
const browser = await puppeteer.launch({
  executablePath: process.env.QA_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, defaultViewport: { width: 1366, height: 768 }, protocolTimeout: 60_000,
});
let page;
let stage = "guide";
async function open(hash) {
  await page.goto(`${site}/${hash}`, { waitUntil: "domcontentloaded" });
}
async function signIn(role) {
  await open("#/demo");
  await page.waitForSelector(`[data-testid="demo-enter-${role}"]`);
  await page.click(`[data-testid="demo-enter-${role}"]`);
  await page.waitForSelector('[data-testid="signed-in-identity"]');
}
async function maskPrivateEmails() {
  await page.evaluate(() => {
    const nodes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (nodes.nextNode()) {
      const node = nodes.currentNode;
      if (["SCRIPT", "STYLE"].includes(node.parentElement?.tagName)) continue;
      node.textContent = node.textContent.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
        (email) => email.endsWith("@demo.tradepulse") || email.endsWith("@example.com") ? email : "[sandbox email]");
    }
  });
}
function assTime(seconds) {
  const total = Math.round(seconds * 100);
  return `${Math.floor(total / 360000)}:${String(Math.floor(total / 6000) % 60).padStart(2, "0")}:${String(Math.floor(total / 100) % 60).padStart(2, "0")}.${String(total % 100).padStart(2, "0")}`;
}
async function record(scene, startY, endY) {
  const fps = 6;
  const filename = `${scene.scene}.mp4`;
  const target = path.join(directory, filename);
  const ass = path.join(directory, `${scene.scene}.ass`);
  fs.writeFileSync(ass, `[Script Info]\nScriptType: v4.00+\nPlayResX: 1366\nPlayResY: 768\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Segoe UI,21,&H00FFFFFF,&H00FFFFFF,&H00101B0B,&H00101B0B,0,0,0,0,100,100,0,0,3,2,0,2,35,35,18,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,${assTime(scene.duration)},Default,,0,0,0,,${scene.caption}\n`);
  const escaped = ass.replaceAll("\\", "/").replaceAll(":", "\\:");
  const encoder = spawn(ffmpeg, ["-v", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "pipe:0",
    "-i", scene.wav, "-vf", `drawbox=x=0:y=ih-65:w=iw:h=65:color=black@0.85:t=fill,subtitles='${escaped}'`,
    "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-af", "apad", "-t", String(scene.duration), "-c:a", "aac", "-movflags", "+faststart", target],
  { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  let encoderError = "";
  encoder.stderr.on("data", (data) => { encoderError += data.toString().slice(0, 1000); });
  encoder.stdin.on("error", () => {});
  const completion = once(encoder, "close");
  const frames = Math.ceil(scene.duration * fps);
  for (let frame = 0; frame < frames; frame++) {
    if (encoder.exitCode !== null) throw new Error(`Local video encoder stopped: ${encoderError.slice(0, 300)}`);
    const fraction = frame / Math.max(1, frames - 1);
    // Hold the first view for half the chapter, then scroll the live page slowly.
    const motion = Math.max(0, (fraction - 0.5) * 2);
    await page.evaluate((y) => window.scrollTo(0, y), Math.round(startY + (endY - startY) * motion));
    await maskPrivateEmails();
    const image = await page.screenshot({ type: "jpeg", quality: 80 });
    if (!encoder.stdin.write(image)) await once(encoder.stdin, "drain");
    await delay(30);
  }
  encoder.stdin.end();
  const [code] = await completion;
  if (code !== 0) throw new Error(`Local video encoder failed: ${encoderError.slice(0, 300)}`);
  report.scenes.push({ scene: scene.scene, durationSeconds: scene.duration, file: filename });
}
async function yFor(selector, offset = -90) {
  return page.$eval(selector, (el, offset) => Math.max(0, el.getBoundingClientRect().top + scrollY + offset), offset);
}
try {
  const gc = await browser.createBrowserContext();
  page = await gc.newPage();
  page.setDefaultTimeout(30_000);
  for (const scene of scenes) {
    stage = scene.scene;
    let startY = 0;
    let endY = 0;
    if (scene.scene === "guide") {
      await open("#/demo");
      await page.waitForSelector('[data-testid="demo-access-page"]');
      endY = 170;
    } else if (scene.scene === "run") {
      await signIn("gc");
      await open(`#/judge-demo/${runId}`);
      await page.waitForSelector('[data-testid="judge-demo-agreement"]');
      await page.waitForFunction(() => document.querySelector('[data-testid="judge-demo-step-owner_pays"]')?.dataset.status === "done");
      startY = await yFor('[data-testid="judge-demo-run"]');
      endY = await yFor('[data-testid="judge-demo-step-payout"]');
    } else if (scene.scene === "ledger") {
      await open(`#/payments/${agreementId}`);
      await page.waitForSelector('[data-testid="ledger-totals"]');
      startY = 0;
      endY = await yFor('[data-testid="ledger-capturedCents"]');
    } else if (scene.scene === "review") {
      await open("#/inbox");
      const entry = `[data-payapp-id="${agentPayAppId}"]`;
      await page.waitForSelector(`${entry} [data-testid="payapp-review-card"]`);
      startY = await yFor(`${entry} [data-testid="payapp-review-card"]`);
      endY = startY + 300;
    } else if (scene.scene === "trace") {
      const entry = `[data-payapp-id="${agentPayAppId}"]`;
      await page.click(`${entry} [data-testid="toggle-agent-trace"]`);
      await page.waitForSelector(`${entry} [data-testid="agent-trace-source"]`);
      startY = await yFor(`${entry} [data-testid="agent-trace-source"]`, -70);
      endY = startY + 300;
    } else if (scene.scene === "owner") {
      const owner = await browser.createBrowserContext();
      page = await owner.newPage();
      await signIn("owner");
      await page.waitForSelector('[data-testid="portal-change-orders"]');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="portal-change-orders"]')].some((el) =>
        el.textContent.includes("INV2-34SZ-2MQV-HYR9-TCRG") && /\bpaid\b/i.test(el.textContent)));
      startY = await page.$$eval('[data-testid="portal-change-orders"]', (rows) => {
        const row = rows.find((el) => el.textContent.includes("INV2-34SZ-2MQV-HYR9-TCRG"));
        return Math.max(0, row.closest("section").getBoundingClientRect().top + scrollY - 24);
      });
      // Keep this project's heading, funding and paid invoice together, not the next shared demo.
      endY = startY;
    } else if (scene.scene === "dashboard") {
      page = (await gc.pages())[0];
      await open("#/dashboard");
      await page.waitForSelector('[data-testid="dashboard-convex-totals"]');
      const basic = await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Use basic view")?.textContent);
      if (basic) await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Use basic view").click());
      await page.waitForSelector('[data-testid="dashboard-basic-view"]');
      endY = 500;
    }
    await record(scene, startY, endY);
  }
  const list = path.join(directory, "chapters.txt");
  fs.writeFileSync(list, report.scenes.map((s) => `file '${s.file}'`).join("\n"));
  const output = path.join(directory, "TradePulse-Pay-demo.mp4");
  const join = spawnSync(ffmpeg, ["-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", output],
    { cwd: directory, encoding: "utf8", timeout: 120_000 });
  if (join.status !== 0) throw new Error("Local chapter concatenation failed.");
  const inspect = spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration,size", "-of", "json", output], { encoding: "utf8" });
  if (inspect.status !== 0) throw new Error("Final video inspection failed.");
  report.media = JSON.parse(inspect.stdout).format;
  if (Number(report.media.duration) >= 180) throw new Error("Final video exceeds the submission limit.");
  report.output = output;
} catch {
  report.errors.push(`Film failed during ${stage}; raw browser diagnostics suppressed.`);
  process.exitCode = 1;
} finally {
  for (const context of browser.browserContexts()) for (const tab of await context.pages()) {
    if (!tab.url().startsWith(site)) continue;
    try {
      await tab.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Sign out")?.click());
      await tab.waitForFunction(() => !document.querySelector('[data-testid="signed-in-identity"]'), { timeout: 3000 });
    } catch { /* Fresh demo contexts are closed even if a view did not have a sign-out control. */ }
  }
  await browser.close();
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
