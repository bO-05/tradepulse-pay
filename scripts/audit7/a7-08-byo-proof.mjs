// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
/**
 * A7-08: BYO truth proof — own document upload/persistence/preview, own GC identity
 * in the generated A401-style draft, and the PM-certification gate on the addendum.
 */
import { delay, openApp, q, clickTab, selectProject, selectRibbonPackage, writeEvidence, PREFIX, DAILY } from "./lib.mjs";
import fs from "node:fs";
import path from "node:path";

const TITLE = `${PREFIX}AFTER-${DAILY}`;
const out = { startedAt: new Date().toISOString() };
const proj = ((await q("projects:listProjects", {})) || []).find((p) => p.title === TITLE);
if (!proj) throw new Error("after fixture missing");

const evidenceDir = path.join(process.cwd(), "evidence");
fs.mkdirSync(evidenceDir, { recursive: true });
const specPath = path.join(evidenceDir, "fix6-byo-div22-spec.txt");
fs.writeFileSync(
  specPath,
  [
    "SECTION 22 11 23 - DOMESTIC WATER BOOSTER PUMPS",
    "Furnish and install a triplex domestic water booster pump skid with factory certified startup.",
    "Provide backflow prevention assemblies with municipal inspection certification.",
    "All piping, valves, and seismic restraints per Division 22 requirements.",
    "Lead time: 17 weeks from notice to proceed.",
  ].join("\n"),
  "utf8"
);

const { browser, page } = await openApp(1440, 900);
try {
  await selectProject(page, proj._id);
  await clickTab(page, "01:");
  await delay(1200);

  // Own document upload
  await page.evaluate(() => {
    const sel = document.querySelector('select[aria-label="Document type for upload"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(sel, "spec");
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const input = await page.$("#convex-file-upload");
  await input.uploadFile(specPath);
  await delay(600);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("Upload to Convex Storage"));
    b?.click();
  });
  const file = await (async () => {
    for (let i = 0; i < 40; i++) {
      await delay(1500);
      const files = (await q("files:listFilesByProject", { projectId: proj._id }).catch(() => [])) || [];
      const found = files.find((f) => f.fileName === "fix6-byo-div22-spec.txt");
      if (found) return found;
    }
    return null;
  })();
  out.uploadedFile = file ? { _id: file._id, fileName: file.fileName, fileType: file.fileType, storageId: String(file.storageId).slice(0, 40), hasText: Boolean(file.textContent || file.extractedText) } : null;

  // Persistence across reload
  await page.reload({ waitUntil: "domcontentloaded" });
  await delay(3500);
  await selectProject(page, proj._id);
  await delay(1500);
  await clickTab(page, "01:");
  await delay(1500);
  out.persistedAfterReload = await page.evaluate(() => document.body.innerText.includes("fix6-byo-div22-spec.txt"));

  // Preview the stored document
  out.previewOpened = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("div")].filter((d) => d.innerText && d.innerText.includes("fix6-byo-div22-spec.txt"));
    const scope = rows.length ? rows[rows.length - 1] : null;
    const b = scope ? [...scope.querySelectorAll("button")].find((x) => /preview/i.test(x.getAttribute("aria-label") || x.title || "")) : null;
    b?.click();
    return Boolean(b);
  });
  await delay(1200);
  out.previewDialog = await page.evaluate(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => x.getBoundingClientRect().width > 1);
    return d ? { title: (d.querySelector("h2,h3") || {}).textContent || null, hasSpecText: d.innerText.includes("TRIPLEX") || d.innerText.includes("triplex") } : null;
  });
  await page.keyboard.press("Escape");
  await delay(500);

  // PM gate: addendum disabled with zero certified RFIs
  await clickTab(page, "Pre-Bid Q&A");
  await delay(1600);
  out.addendumGate = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("Issue Pre-Bid Addendum"));
    return b
      ? { disabled: b.disabled, title: b.getAttribute("title") }
      : { disabled: null, note: "button not rendered" };
  });

  // Own GC identity in the generated draft
  const agreements = (await q("agreements:listAgreements", { projectId: proj._id })) || [];
  const agr = agreements.find((a) => a.agreementNumber?.includes("0754"));
  out.ownGcIdentity = agr
    ? {
        agreementNumber: agr.agreementNumber,
        generalContractorName: agr.generalContractorName,
        projectTitle: agr.projectTitle,
        containsGcName: String(agr.contractText || "").includes("AUDIT7 After Water Works Constructors JV"),
        containsOwnSub: String(agr.contractText || "").includes("Willamette Mechanical Systems Inc."),
        sum: agr.contractSum,
      }
    : null;
} catch (err) {
  out.error = String(err?.stack ?? err);
  console.error(err);
} finally {
  await browser.close();
  try {
    fs.unlinkSync(specPath);
  } catch {}
}
await writeEvidence("fix6-a7-08-byo.json", out);
console.log(JSON.stringify({ uploadedFile: out.uploadedFile, persistedAfterReload: out.persistedAfterReload, previewOpened: out.previewOpened, previewDialog: out.previewDialog, addendumGate: out.addendumGate, ownGcIdentity: out.ownGcIdentity }, null, 2));