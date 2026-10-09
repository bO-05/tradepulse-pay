// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { InviteEmailStatus } from "../../convex/lib/inviteRules";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useQuery: () => undefined,
}));

const { ToastProvider } = await import("../ui");
const { InviteResult } = await import("./InviteDialog");
const { InviteList } = await import("./InviteList");

const STATUSES: InviteEmailStatus[] = ["sent", "not_sent", "skipped_budget", "failed", "bounced"];
const DAY = 86_400_000;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const withToasts = (child: ReturnType<typeof createElement>) => createElement(ToastProvider, null, child);

function renderResult(emailStatus: InviteEmailStatus, emailError: string | null = null): string {
  const result = { link: "http://localhost:3150/#/invite/abc", email: "kim@eastbay.test", emailStatus, emailError };
  return text(renderToStaticMarkup(withToasts(createElement(InviteResult, { result }))));
}

function renderList(emailStatus: InviteEmailStatus, emailError: string | null): string {
  const now = Date.now();
  const invite = {
    _id: `inv_${emailStatus}`,
    email: "kim@eastbay.test",
    kind: "sub" as const,
    status: "pending" as const,
    emailStatus,
    emailError,
    expiresAt: now + 7 * DAY,
    createdAt: now,
    lastSentAt: emailStatus === "sent" ? now : null,
  };
  return text(renderToStaticMarkup(withToasts(createElement(InviteList, { invites: [invite], emptyText: "No invites" }))));
}

describe("invite result in the create dialog", () => {
  test("says Email sent only for a real send", () => {
    for (const s of STATUSES) {
      const out = renderResult(s);
      if (s === "sent") expect(out).toContain("Email sent");
      else expect(out, s).not.toMatch(/email sent/i);
    }
  });

  test("each non-sent status reads honestly", () => {
    expect(renderResult("not_sent")).toContain("Not emailed — share the link");
    expect(renderResult("skipped_budget")).toContain("Email limit reached for today — copy the invite link instead");
    expect(renderResult("failed")).toContain("Email failed — copy the link or resend");
    expect(renderResult("failed", "AgentMail 500")).toContain("Email failed — copy the link or resend (AgentMail 500)");
    expect(renderResult("bounced")).toContain("Email bounced — copy the link or resend");
  });
});

describe("invite list on People and Company settings", () => {
  test("the status pill says Email sent only for sent invites", () => {
    for (const s of STATUSES) {
      for (const err of [null, "AgentMail 500"]) {
        const out = renderList(s, err);
        if (s === "sent") expect(out).toContain("Pending · Email sent");
        else expect(out, `${s} ${err}`).not.toMatch(/email sent/i);
      }
    }
  });

  test("not emailed and daily-limit invites say so", () => {
    expect(renderList("not_sent", null)).toContain("Pending · Not emailed");
    expect(renderList("skipped_budget", null)).toContain("Pending · Not emailed (daily limit)");
  });

  test("failed and bounced invites show the copy-or-resend guidance with or without an error", () => {
    expect(renderList("failed", null)).toContain("Pending · Email failed");
    expect(renderList("failed", null)).toContain("Email failed — copy the link or resend");
    expect(renderList("failed", null)).not.toContain("resend (");
    expect(renderList("failed", "AgentMail 500")).toContain("Email failed — copy the link or resend (AgentMail 500)");
    expect(renderList("bounced", null)).toContain("Pending · Email bounced");
    expect(renderList("bounced", null)).toContain("Email bounced — copy the link or resend");
    expect(renderList("bounced", "Mailbox does not exist")).toContain("Email bounced — copy the link or resend (Mailbox does not exist)");
  });
});
