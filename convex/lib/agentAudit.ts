import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { normalizeAgentEmail } from "./agentAccess";
import type { Viewer } from "./roles";

export type AgentAuditFields = { agentSub?: string; agentEmail?: string; ownerEmail?: string };

function compact(fields: AgentAuditFields): AgentAuditFields {
  const out: AgentAuditFields = {};
  if (fields.agentSub) out.agentSub = fields.agentSub;
  if (fields.agentEmail) out.agentEmail = normalizeAgentEmail(fields.agentEmail);
  if (fields.ownerEmail) out.ownerEmail = fields.ownerEmail;
  return out;
}

/**
 * Agent and owner attribution for an audit row written by the signed-in viewer; empty for humans.
 * The email is the AgentID id_token address that getViewer just matched to an active agentLinks
 * row, so it never comes from client arguments.
 */
export function viewerAgentAuditFields(viewer: Viewer): AgentAuditFields {
  if (viewer.user.actorType !== "agent") return {};
  return compact({
    agentSub: viewer.user.agentSub,
    agentEmail: viewer.profile.agentEmail ?? viewer.user.email,
    ownerEmail: viewer.user.ownerEmail,
  });
}

/** For pay apps a billing agent submitted: the agent and owner later audit rows are attributed to. */
export async function submitterAuditFields(
  ctx: QueryCtx,
  payApp: Doc<"payApplications"> | null,
): Promise<AgentAuditFields> {
  if (payApp === null || payApp.submittedBy.actorType !== "agent") return {};
  const user = await ctx.db.get(payApp.submittedBy.userId);
  return compact({
    agentSub: user?.agentSub,
    agentEmail: payApp.submittedBy.agentEmail ?? user?.email,
    ownerEmail: payApp.submittedBy.ownerEmail ?? user?.ownerEmail,
  });
}
