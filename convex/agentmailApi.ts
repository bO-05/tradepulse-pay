/**
 * AgentMail configuration for the host deployment. Sending lives only in
 * `convex/lib/mailer.ts`; inboxes are fixed (never created or deleted by the app).
 */

const DEFAULT_BASE_URL = "https://api.agentmail.to/v0";

export interface AgentmailConfig {
  apiKey: string;
  baseUrl: string;
}

export function agentmailConfig(): AgentmailConfig | null {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (process.env.AGENTMAIL_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  return { apiKey, baseUrl };
}

export function isAgentmailConfigured(): boolean {
  return Boolean(process.env.AGENTMAIL_API_KEY);
}
