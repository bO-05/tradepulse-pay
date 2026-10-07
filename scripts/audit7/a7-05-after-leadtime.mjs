// LEGACY, pre-auth script (TradePulse Pro, Sep 2026). It calls public Convex functions without
// signing in, or targets the old Convex hackathon deployment. The TradePulse Pay role guards
// refuse those calls, so this script no longer works. Kept for history only; it is not a
// verification command. See README "Legacy scripts".
/**
 * A7-05: AFTER-fix live verification for A6-05r/A6-54 (deterministic lead-time),
 * A6-29 (RFQ delivery truth), A6-18 (banner), A6-22 (stable modal ids), A6-07 (accept).
 * Creates AUDIT7-AFTER-<date> on the live deployment and runs the matrix through the UI.
 */
import { delay, openApp, q, call, clickTab, selectProject, selectRibbonPackage, selectPackageCard, clickText, makeFixtureProject, makePackage, addContractor, ingestQuote, poll, writeEvidence, deleteProject, DAILY, PREFIX } from "./lib.mjs";

const TITLE = `${PREFIX}AFTER-${DAILY}`;
const out = { startedAt: new Date().toISOString(), title: TITLE, lead: [], toasts: [], assertions: {} };

function toastText(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="status"],[aria-live="polite"],[aria-live="assertive"]')]
      .map((e) => (e.innerText || "").trim())
      .filter(Boolean)
      .join(" | ")
  );
}

function quoteFor(name, n, div) {
  return [
    "PROPOSAL AND QUOTATION",
    `Subcontractor: ${name}`,
    `Project: ${TITLE}`,
    "Base Bid Price: $500,000.00",
    `Scope: complete Division ${div} scope.`,
    `Schedule: equipment procurement lead time is ${n} weeks from notice to proceed; the project target is 12 weeks.`,
    "Insurance: fully compliant ACORD 25 with $5M commercial umbrella.",
    "Value Engineering: LED lighting alternate credit of $35,000 offered (GC to decide).",
  ].join("\n");
}

// pre-clean
for (const p of ((await q("projects:listProjects", {})) || []).filter((x) => x.title.startsWith(PREFIX))) {
  await deleteProject(p._id);
}

const { browser, page } = await openApp(1440, 900);
try {
  const proj = await makeFixtureProject(page, {
    title: TITLE,
    gc: "AUDIT7 After Water Works Constructors JV",
    budget: 3000000,
    weeks: 52,
    spec: "Division 22, 26 and 03 scope for the AUDIT7 after-fix probe.",
  });
  out.project = proj.proj;
  if (!proj.proj) throw new Error("after fixture not created");
  // A6-18 banner (text updated when sign-in replaced the public-URL disclosure)
  out.assertions.banner = await page.evaluate(() =>
    document.body.innerText.includes("Shared demo — the demo accounts and their password are public, so anyone can see this data.")
  );

  for (const spec of [
    { csi: "22 00 00", name: "AUDIT7 After Plumbing", budget: 900000, div: "22", n: [17, 17] },
    { csi: "26 00 00", name: "AUDIT7 After Electrical", budget: 900000, div: "26", n: [16] },
  ]) {
    await clickTab(page, "01:");
    await delay(800);
    await makePackage(page, spec.csi, spec.name, spec.budget, `Division ${spec.div} scope.`);
    const pkgs = await poll(() => q("tradePackages:listByProject", { projectId: proj.proj._id }), (x) => (x || []).some((p) => p.csiDivision.startsWith(spec.div)), 30000, 1200);
    const pkg = (pkgs || []).find((p) => p.csiDivision.startsWith(spec.div));
    const ctrName = `AUDIT7 After ${spec.div} Bidder`;
    await addContractor(page, pkg.tradeName, ctrName, `estimating@audit7-after-${spec.div}.invalid`, `OR-AUDIT7-A${spec.div}`);
    const ctrs = await q("contractors:listByPackage", { tradePackageId: pkg._id });
    const ctr = (ctrs || []).find((c) => c.companyName === ctrName);
    for (const n of spec.n) {
      const before = (await q("bids:listByPackage", { tradePackageId: pkg._id })) || [];
      await ingestQuote(page, ctr._id, quoteFor(ctrName, n, spec.div));
      const bid = await poll(
        () => q("bids:listByPackage", { tradePackageId: pkg._id }).then((bs) => bs.find((b) => b.contractorId === ctr._id)),
        (b) => Boolean(b) && ((b.revisionNumber || 1) > (before[0]?.revisionNumber || 0) || b.longLeadEquipmentWeeks === n),
        120000,
        2500
      );
      await delay(1200);
      const cardText = await page.evaluate(() => {
        const t = (document.querySelector("main") || document.body).innerText;
        const idx = t.indexOf("Equipment Lead Time");
        return idx === -1 ? null : t.slice(idx, idx + 320).replace(/\n+/g, " | ");
      });
      out.lead.push({
        div: spec.div,
        inputWeeks: n,
        persistedWeeks: bid?.longLeadEquipmentWeeks ?? null,
        persistedPenalty: bid?.leadTimePenalty ?? null,
        persistedTarget: bid?.leadTimeTargetWeeks ?? null,
        persistedLeveled: bid?.leveledTotalCost ?? null,
        veAccepted: (bid?.valueEngineeringAlternates || []).map((v) => ({ deduct: v.costDeduct, accepted: v.isAccepted })),
        cardText,
        expectedPenalty: Math.max(0, n - (spec.div === "22" ? 16 : 12)) * 6000,
      });
      console.log(`[after-lead] div${spec.div} N=${n} -> weeks=${bid?.longLeadEquipmentWeeks} target=${bid?.leadTimeTargetWeeks} penalty=$${bid?.leadTimePenalty}`);
    }

    // A6-29: dispatch a single RFQ from Discovery and capture the true toast
    if (spec.div === "22") {
      await clickTab(page, "Discovery");
      await delay(1200);
      await selectRibbonPackage(page, pkg.tradeName);
      await delay(700);
      const invite = await page.evaluate((name) => {
        const row = [...document.querySelectorAll("h4")].find((h) => h.textContent.trim() === name);
        const scope = row ? row.closest("div.p-4") : null;
        const b = scope ? [...scope.querySelectorAll("button")].find((x) => x.textContent.includes("Invite to Bid")) : null;
        b?.click();
        return Boolean(b);
      }, ctrName);
      out.assertions.inviteClicked = invite;
      const seen = new Set();
      for (let i = 0; i < 10; i++) {
        await delay(1500);
        const t = await toastText(page);
        if (t && !seen.has(t)) {
          seen.add(t);
          out.toasts.push({ at: i, text: t });
        }
      }
      const logs = (await q("auditLogs:listRecentLogs", { projectId: proj.proj._id, limit: 100 })) || [];
      out.dispatchLogs = logs.filter((l) => /AgentMail Delivery|RFQ Invitation/i.test(l.title)).slice(0, 4).map((l) => ({ title: l.title, description: l.description }));
      await clickTab(page, "01:");
      await delay(1200);
      out.assertions.packageDeliveryNotice = await page.evaluate(() =>
        document.body.innerText.includes("Email delivery unavailable")
      );
      out.packageCardText = await page.evaluate(() => {
        const t = (document.querySelector("main") || document.body).innerText;
        const idx = t.indexOf("Email delivery unavailable");
        return idx === -1 ? null : t.slice(Math.max(0, idx - 140), idx + 120).replace(/\n+/g, " | ");
      });
    }
  }

  // A6-22 stable ids + A6-07 accept on the Div 22 package
  await clickTab(page, "01:");
  await delay(800);
  const pkgsAll = await q("tradePackages:listByProject", { projectId: proj.proj._id });
  const p22 = pkgsAll.find((p) => p.csiDivision.startsWith("22"));
  await clickTab(page, "01:");
  await delay(600);
  await page.evaluate((name) => {
    const h = [...document.querySelectorAll("h3")].find((x) => x.textContent.trim() === name);
    h?.click();
  }, p22.tradeName);
  await clickTab(page, "04:");
  await delay(900);
  await clickText(page, "Ingest Quote / PDF");
  await delay(900);
  out.assertions.ingestModalIds = await page.evaluate(() => ({
    select: Boolean(document.getElementById("ingest-contractor-select")),
    file: Boolean(document.getElementById("ingest-proposal-file")),
    fileAria: document.getElementById("ingest-proposal-file")?.getAttribute("aria-label") ?? null,
    filename: Boolean(document.getElementById("ingest-document-filename")),
    quote: Boolean(document.getElementById("ingest-quote-text")),
    accept: document.getElementById("ingest-proposal-file")?.getAttribute("accept") ?? null,
  }));
  await page.keyboard.press("Escape");
  await delay(400);
} catch (err) {
  out.error = String(err?.stack ?? err);
  console.error(err);
} finally {
  await browser.close();
}
await writeEvidence("fix6-a7-05-after.json", out);
console.log(JSON.stringify({ assertions: out.assertions, lead: out.lead.map((l) => [l.div, l.inputWeeks, l.persistedWeeks, l.persistedTarget, l.persistedPenalty, l.expectedPenalty]), toasts: out.toasts, dispatchLogs: out.dispatchLogs, packageCardText: out.packageCardText, cardText: out.lead[0]?.cardText }, null, 2));