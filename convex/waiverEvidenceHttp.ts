import { ConvexError } from "convex/values";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { browserOrigins } from "./lib/browserOrigins";
import { sha256Hex } from "./lib/waiverStatement";
import { IP_MAX_CHARS, STATEMENT_MAX_CHARS, USER_AGENT_MAX_CHARS } from "./lib/waiverEvidence";

/**
 * The only writer of signing evidence, because this is the only place where the request headers
 * exist. The route is authenticated by the ticket: the token is unguessable, single use, expires,
 * and is stored only as a SHA-256. A caller who does not hold a ticket issued to them cannot create
 * evidence, and evidence is useless without the matching authenticated signWaiver call.
 */

const MAX_BODY_CHARS = 8_192;

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  if (!origin || !browserOrigins().includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function json(req: Request, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(req) },
  });
}

/** Best-effort client address, with the header we trusted, because the headers differ per edge. */
function clientAddress(req: Request): { ip: string; source: string } {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return { ip: first.slice(0, IP_MAX_CHARS), source: "x-forwarded-for" };
  }
  const real = req.headers.get("x-real-ip");
  if (real) return { ip: real.trim().slice(0, IP_MAX_CHARS), source: "x-real-ip" };
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return { ip: cf.trim().slice(0, IP_MAX_CHARS), source: "cf-connecting-ip" };
  return { ip: "", source: "unavailable" };
}

function readString(body: Record<string, unknown>, key: string, min: number, max: number): string {
  const value = body[key];
  if (typeof value !== "string") throw new Error(`Missing ${key}.`);
  if (value.length < min || value.length > max) throw new Error(`${key} must be ${min}-${max} characters.`);
  return value;
}

export const waiverEvidencePost = httpAction(async (ctx, req) => {
  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return json(req, 413, { error: "Body too large." });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json(req, 400, { error: "Expected a JSON object." });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return json(req, 400, { error: "Expected JSON." });
  }

  let ticket: string;
  let statementText: string;
  try {
    ticket = readString(body, "ticket", 20, 128);
    statementText = readString(body, "statementText", 40, STATEMENT_MAX_CHARS);
  } catch (err) {
    return json(req, 400, { error: err instanceof Error ? err.message : "Invalid request." });
  }

  const address = clientAddress(req);
  const userAgent = (req.headers.get("user-agent") ?? "").slice(0, USER_AGENT_MAX_CHARS);
  const statementHash = await sha256Hex(statementText);

  try {
    const result = await ctx.runMutation(internal.waiverEvidence.recordEvidence, {
      ticket,
      statementText,
      statementHash,
      ipAddress: address.ip,
      ipSource: address.source,
      userAgent,
    });
    return json(req, 200, {
      evidenceId: result.evidenceId,
      statementHash: result.statementHash,
      observedAt: result.observedAt,
    });
  } catch (err) {
    const data = err instanceof ConvexError ? (err.data as { message?: string } | undefined) : undefined;
    return json(req, 409, { error: data?.message ?? "The signing evidence could not be recorded." });
  }
});

export const waiverEvidencePreflight = httpAction(async (_ctx, req) =>
  new Response(null, { status: 204, headers: cors(req) }),
);
