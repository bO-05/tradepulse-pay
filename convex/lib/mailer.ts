/**
 * The only email send path in the app. Every attempt is recorded in `emailOutbox`
 * (sent | uncertain | delivery_failed | failed | skipped_budget | blocked_recipient) and is subject to the daily
 * budget guard. Outside production, recipients outside EMAIL_RECIPIENT_ALLOWLIST are refused (lib/recipientAllowlist.ts).
 * Only a definite refusal releases a budget slot; a lost or timed-out response stays charged as
 * `uncertain` until a retry with the same Idempotency-Key reconciles it.
 * Notifications are in-app only and cannot be emailed through here.
 */
import type { GenericActionCtx, GenericDataModel } from "convex/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { agentmailConfig } from "../agentmailApi";
import { BLOCKED_RECIPIENT_MESSAGE } from "./recipientAllowlist";

export const SYSTEM_INBOX = "cleverneed464@agentmail.to";
export const RFQ_INBOX = "dullstreet57@agentmail.to";
export const SYSTEM_SENDER_NAME = "TradePulse Pay";

/** Sends other than auth codes stop this many sends short of the daily budget. */
export const AUTH_CODE_RESERVE = 10;
/** Used when EMAIL_DAILY_BUDGET is unset or not a number (the prod value). */
export const DEFAULT_DAILY_BUDGET = 30;

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ERROR_LENGTH = 500;

export type MailKind = "auth_code" | "invite" | "rfq" | "rfi_answer" | "other";
export type MailFrom = "system" | "rfq";

export interface SendEmailRequest {
  kind: MailKind;
  from: MailFrom;
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Stable per logical event; reused verbatim on retries and sent as AgentMail's Idempotency-Key. */
  idempotencyKey: string;
  companyId?: Id<"companies">;
  projectId?: Id<"projects">;
  /** Reply inside an existing AgentMail thread (RFI answers). */
  replyToMessageId?: string;
  /** Values (codes, tokens) that must never be stored; they are redacted from the stored subject. */
  redact?: string[];
}

export type SendEmailResult =
  | { status: "sent"; outboxId: Id<"emailOutbox">; messageId: string; threadId: string }
  | { status: "skipped_budget"; outboxId: Id<"emailOutbox">; message: string }
  | { status: "failed"; outboxId?: Id<"emailOutbox">; error: string; uncertain?: boolean; blockedRecipient?: boolean };

export const DEMO_NO_EMAIL_MESSAGE = "Demo company: no external email is sent.";

export const MAILER_IN_FLIGHT_MESSAGE = "This email is already being sent.";

export const BUDGET_SKIP_MESSAGE = "Email limit reached for today. No email was sent.";

export const UNCERTAIN_SEND_MESSAGE =
  "AgentMail did not confirm the send. The email may still arrive, and it counts toward today's email limit.";

/** Connection never opened, so AgentMail cannot have accepted the request. */
const DEFINITE_TRANSPORT_FAILURE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|certificate|ERR_TLS/i;
/** Gateway/timeout statuses where AgentMail may have processed the request behind the proxy. */
const INDETERMINATE_STATUSES = new Set([408, 502, 504]);

export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function readDailyBudget(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_BUDGET;
}

/** How many sends (sent or in flight) today a send of this kind may find before it is skipped. */
export function sendLimitFor(kind: MailKind, budget: number): number {
  return kind === "auth_code" ? budget : Math.max(0, budget - AUTH_CODE_RESERVE);
}

export function inboxFor(from: MailFrom): string {
  return from === "rfq" ? RFQ_INBOX : SYSTEM_INBOX;
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

/** AgentMail accepts only A-Z a-z 0-9 - . _ ~ in Idempotency-Key; other keys are hashed deterministically. */
export async function agentmailIdempotencyKey(key: string): Promise<string> {
  if (IDEMPOTENCY_KEY_PATTERN.test(key)) return key;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function redactSubject(subject: string, redact: string[] = []): string {
  let out = subject;
  for (const secret of redact) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out.slice(0, 300);
}

export type MailerCtx = Pick<GenericActionCtx<GenericDataModel>, "runMutation">;

export interface MailerOptions {
  fetchImpl?: typeof fetch;
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

export async function sendEmail(ctx: MailerCtx, req: SendEmailRequest, opts: MailerOptions = {}): Promise<SendEmailResult> {
  const to = req.to.trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) {
    return { status: "failed", error: `Invalid recipient address.` };
  }
  if (!req.idempotencyKey) {
    return { status: "failed", error: "Missing idempotency key." };
  }
  const fromInbox = inboxFor(req.from);

  const reservation = await ctx.runMutation(internal.emailOutbox.reserveSend, {
    kind: req.kind,
    to,
    fromInbox,
    subject: redactSubject(req.subject, req.redact),
    idempotencyKey: req.idempotencyKey,
    companyId: req.companyId,
    projectId: req.projectId,
  });

  if (reservation.action === "demo_blocked") {
    return { status: "failed", error: DEMO_NO_EMAIL_MESSAGE };
  }
  if (reservation.action === "blocked_recipient") {
    return { status: "failed", outboxId: reservation.outboxId, error: BLOCKED_RECIPIENT_MESSAGE, blockedRecipient: true };
  }
  if (reservation.action === "already_sent") {
    return {
      status: "sent",
      outboxId: reservation.outboxId,
      messageId: reservation.messageId ?? "",
      threadId: reservation.threadId ?? "",
    };
  }
  if (reservation.action === "delivery_failed") {
    return { status: "failed", outboxId: reservation.outboxId, error: reservation.error ?? "The email was not delivered." };
  }
  if (reservation.action === "in_flight") {
    return { status: "failed", outboxId: reservation.outboxId, error: MAILER_IN_FLIGHT_MESSAGE };
  }
  if (reservation.action === "skipped_budget") {
    return { status: "skipped_budget", outboxId: reservation.outboxId, message: BUDGET_SKIP_MESSAGE };
  }

  const outboxId = reservation.outboxId;
  const reconcile = reservation.reconcile;
  const fail = async (error: string): Promise<SendEmailResult> => {
    // A slot that may already have been spent by an earlier uncertain attempt is never released.
    if (reconcile) return await uncertain(error);
    const clean = truncate(error);
    await ctx.runMutation(internal.emailOutbox.finishSend, { outboxId, status: "failed", error: clean });
    return { status: "failed", outboxId, error: clean };
  };
  const uncertain = async (detail: string): Promise<SendEmailResult> => {
    const clean = truncate(`${UNCERTAIN_SEND_MESSAGE} (${detail})`);
    await ctx.runMutation(internal.emailOutbox.finishSend, { outboxId, status: "uncertain", error: clean });
    return { status: "failed", outboxId, error: clean, uncertain: true };
  };

  const config = agentmailConfig();
  if (!config) return await fail("AGENTMAIL_API_KEY is not set on this deployment.");

  const path = req.replyToMessageId
    ? `/inboxes/${encodeURIComponent(fromInbox)}/messages/${encodeURIComponent(req.replyToMessageId)}/reply`
    : `/inboxes/${encodeURIComponent(fromInbox)}/messages/send`;
  const body = req.replyToMessageId
    ? { text: req.text, html: req.html, labels: ["transactional", req.kind] }
    : { to: [to], subject: req.subject, text: req.text, html: req.html, labels: ["transactional", req.kind] };

  const doFetch = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const idempotencyHeader = await agentmailIdempotencyKey(req.idempotencyKey);
  const post = () =>
    postToAgentmail(doFetch, config.baseUrl + path, {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyHeader,
    }, JSON.stringify(body));

  let outcome = await post();
  let acceptedEarlier = false;
  if (outcome.kind === "accepted_unreadable") {
    // AgentMail accepted the send, so the slot is spent. Record that before the same-key replay,
    // which returns the original message's ids without sending again.
    acceptedEarlier = true;
    await uncertain(outcome.detail);
    outcome = await post();
  }
  if (outcome.kind === "definite_failure" && !acceptedEarlier) return await fail(outcome.detail);
  if (outcome.kind !== "accepted") return await uncertain(outcome.detail);
  const { messageId, threadId } = outcome;
  const finished = await ctx.runMutation(internal.emailOutbox.finishSend, {
    outboxId,
    status: "sent",
    agentmailMessageId: messageId,
    threadId: threadId || undefined,
  });
  // A bounce or rejection that arrived before the ids were stored has already made the row terminal.
  if (finished?.status === "delivery_failed") return { status: "failed", outboxId, error: finished.error };
  return { status: "sent", outboxId, messageId, threadId };
}

type PostOutcome =
  | { kind: "accepted"; messageId: string; threadId: string }
  | { kind: "accepted_unreadable"; detail: string }
  | { kind: "indeterminate"; detail: string }
  | { kind: "definite_failure"; detail: string };

async function postToAgentmail(
  doFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<PostOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await doFetch(url, { method: "POST", headers, body, signal: controller.signal });
    } catch (err: any) {
      const detail = `AgentMail request failed: ${[err?.message, err?.cause?.code, err?.cause?.message].filter(Boolean).join(" ") || String(err)}`;
      return { kind: DEFINITE_TRANSPORT_FAILURE.test(detail) ? "definite_failure" : "indeterminate", detail };
    }
    let raw: string | null;
    try {
      raw = await response.text();
    } catch {
      raw = null;
    }
    if (INDETERMINATE_STATUSES.has(response.status)) return { kind: "indeterminate", detail: `AgentMail ${response.status}` };
    if (!response.ok) return { kind: "definite_failure", detail: `AgentMail ${response.status}: ${(raw ?? "").slice(0, 300)}` };
    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    const messageId = typeof parsed?.message_id === "string" ? parsed.message_id : "";
    const threadId = typeof parsed?.thread_id === "string" ? parsed.thread_id : "";
    if (!messageId) {
      return { kind: "accepted_unreadable", detail: `AgentMail ${response.status} response without a message id` };
    }
    return { kind: "accepted", messageId, threadId };
  } finally {
    clearTimeout(timer);
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Minimal branded HTML part for a plain-text body. */
export function brandedHtml(text: string): string {
  const paragraphs = escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;line-height:1.5"><p style="margin:0 0 16px;font-weight:bold;font-size:16px">${SYSTEM_SENDER_NAME}</p>${paragraphs}</div>`;
}
