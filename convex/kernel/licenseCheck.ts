"use node";

// Node runtime: the SDK routes playwright.execute straight to the browser VM
// using Request features the default Convex runtime does not implement.
import Kernel from "@onkernel/sdk";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { buildCslbScript, describeKernelFailure, parseCslbPage, scrub, type CslbStatus } from "./cslb";

const CREATE_TIMEOUT_MS = 30_000;
// The SDK (60 s request timeout, one retry) settles creation within ~125 s of starting, i.e.
// within this grace after our own timeout. Create + grace + delete stays under the 3-minute
// stale-check deadline in licenseChecks.ts.
const LATE_CREATE_GRACE_MS = 100_000;
const EXECUTE_TIMEOUT_MS = 95_000;
const DELETE_TIMEOUT_MS = 20_000;
const POLL_LIMIT_MS = 150_000;

class LicenseCheckTimeout extends Error {
  override name = "LicenseCheckTimeout";
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LicenseCheckTimeout(`${what} timed out after ${Math.round(ms / 1000)} s.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type Lookup = { status: CslbStatus; rawSummary: string; browserDeleted?: boolean };

/**
 * One CSLB lookup in a fresh KERNEL browser. Headful, because only headful
 * sessions expose a live view. The browser is deleted in every outcome.
 */
async function lookupCslb(
  ctx: ActionCtx,
  checkId: Id<"licenseChecks">,
  licenseNumber: string,
): Promise<Lookup> {
  const apiKey = process.env.KERNEL_API_KEY?.trim();
  if (!apiKey) return { status: "unverified", rawSummary: "KERNEL_API_KEY is not configured; no CSLB lookup was run." };
  const kernel = new Kernel({ apiKey, maxRetries: 1, timeout: 60_000 });
  let sessionId: string | undefined;
  let result: Lookup = { status: "unverified", rawSummary: "CSLB lookup not completed." };
  try {
    const creation = kernel.browsers.create({ stealth: true, headless: false, timeout_seconds: 120 });
    let browser: Awaited<typeof creation>;
    try {
      browser = await withTimeout(creation, CREATE_TIMEOUT_MS, "Starting the KERNEL browser");
    } catch (error) {
      // Our timeout does not cancel the SDK request: KERNEL may still create the browser. Keep
      // waiting for that outcome so a late session is deleted in `finally` instead of leaking.
      if (error instanceof LicenseCheckTimeout) {
        const late = await withTimeout(creation, LATE_CREATE_GRACE_MS, "Waiting for the late KERNEL browser").catch(() => undefined);
        if (late) sessionId = late.session_id;
      }
      throw error;
    }
    sessionId = browser.session_id;
    await ctx.runMutation(internal.kernel.licenseChecks.attachBrowser, {
      checkId,
      kernelSessionId: browser.session_id,
      liveViewUrl: browser.browser_live_view_url ?? undefined,
    });
    const run = await withTimeout(
      kernel.browsers.playwright.execute(browser.session_id, { code: buildCslbScript(licenseNumber), timeout_sec: 80 }),
      EXECUTE_TIMEOUT_MS,
      "The CSLB lookup",
    );
    if (!run.success) {
      const first = (run.error ?? "unknown error").split("\n")[0].slice(0, 200);
      result = { status: "unverified", rawSummary: scrub(`CSLB lookup did not complete: ${first}`, apiKey) };
    } else {
      const page = (run.result ?? {}) as { url?: unknown; text?: unknown };
      result = parseCslbPage(
        { url: typeof page.url === "string" ? page.url : "", text: typeof page.text === "string" ? page.text : "" },
        licenseNumber,
      );
    }
  } catch (error) {
    result = { status: "unverified", rawSummary: `CSLB lookup not completed: ${describeKernelFailure(error, apiKey)}` };
  } finally {
    if (sessionId !== undefined) {
      let deleted = false;
      try {
        await withTimeout(kernel.browsers.deleteByID(sessionId), DELETE_TIMEOUT_MS, "Deleting the KERNEL browser");
        deleted = true;
      } catch (error) {
        console.warn(`KERNEL browser delete failed: ${describeKernelFailure(error, apiKey)}`);
      }
      result = { ...result, browserDeleted: deleted };
    }
  }
  return result;
}

async function perform(ctx: ActionCtx, checkId: Id<"licenseChecks">, licenseNumber: string): Promise<void> {
  let outcome: Lookup;
  try {
    outcome = await lookupCslb(ctx, checkId, licenseNumber);
  } catch (error) {
    outcome = { status: "unverified", rawSummary: `CSLB lookup not completed: ${describeKernelFailure(error)}` };
  }
  await ctx.runMutation(internal.kernel.licenseChecks.finishCheck, { checkId, ...outcome });
}

export const performLicenseCheck = internalAction({
  args: { checkId: v.id("licenseChecks"), licenseNumber: v.string() },
  handler: async (ctx, args) => {
    await perform(ctx, args.checkId, args.licenseNumber);
    return null;
  },
});

export type LicenseCheckResult = {
  checkId: Id<"licenseChecks">;
  contractorId: Id<"contractors">;
  licenseNumber: string;
  status: CslbStatus;
  rawSummary: string;
  checkedAt: number;
  cached: boolean;
};

/**
 * Runs (or reuses) a check and waits for its final status. For server-side
 * callers such as the pay agent's checkLicense tool and payout preparation.
 */
export const checkLicenseNow = internalAction({
  args: { contractorId: v.id("contractors"), trigger: v.optional(v.string()) },
  handler: async (ctx, args): Promise<LicenseCheckResult> => {
    const begun = await ctx.runMutation(internal.kernel.licenseChecks.beginCheck, {
      contractorId: args.contractorId,
      trigger: args.trigger ?? "agent",
    });
    if (begun.kind === "started") await perform(ctx, begun.checkId, begun.licenseNumber);
    const deadline = Date.now() + POLL_LIMIT_MS;
    let row: Doc<"licenseChecks"> | null = await ctx.runQuery(internal.kernel.licenseChecks.getCheck, { checkId: begun.checkId });
    while (row !== null && row.phase === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      row = await ctx.runQuery(internal.kernel.licenseChecks.getCheck, { checkId: begun.checkId });
    }
    if (row === null) throw new Error("License check row disappeared.");
    const stillRunning = row.phase === "running";
    return {
      checkId: row._id,
      contractorId: row.contractorId,
      licenseNumber: row.licenseNumber,
      status: stillRunning ? "unverified" : row.status,
      rawSummary: stillRunning ? "CSLB lookup still running; treated as unverified." : row.rawSummary,
      checkedAt: row.checkedAt,
      cached: begun.kind === "cached",
    };
  },
});
