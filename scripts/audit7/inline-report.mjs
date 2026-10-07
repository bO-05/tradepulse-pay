// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const reportPath = path.join(root, "docs", "audits", "audit-6-remediation.html");
const map = {
  __IMG_LEAD__: "fix6-a7-05b-lead-arithmetic.png",
  __IMG_RFQ__: "fix6-a7-05b-rfq-toast.png",
  __IMG_NOTICE__: "fix6-a7-05b-package-notice.png",
  __IMG_MODAL__: "fix6-conv-r2b-03-ingest-modal.png",
};

let html = fs.readFileSync(reportPath, "utf8");
html = html.replace('<span class="k new k part">', '<span class="k part">');
for (const [placeholder, file] of Object.entries(map)) {
  const p = path.join(root, "evidence", file);
  const b64 = fs.readFileSync(p).toString("base64");
  html = html.split(placeholder).join(`data:image/png;base64,${b64}`);
  console.log(`inlined ${file} (${(fs.statSync(p).size / 1024).toFixed(0)} KB)`);
}
if (html.includes("__IMG_")) throw new Error("unreplaced placeholder remains");
fs.writeFileSync(reportPath, html, "utf8");

const stamp = new Date();
const pad = (n) => String(n).padStart(2, "0");
const hours12 = stamp.getUTCHours() % 12 || 12;
const ampm = stamp.getUTCHours() >= 12 ? "PM" : "AM";
const name = `TradePulse-Pro-Remediation-Pass3-${stamp.toISOString().slice(0, 10)}-${pad(hours12)}-${pad(stamp.getUTCMinutes())}-${ampm}-UTC.html`;
const outDir = path.join(root, "doc", "tradepulse audit 6", "remediation");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, name);
fs.writeFileSync(outPath, html, "utf8");
console.log(`wrote ${outPath} (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(2)} MB)`);