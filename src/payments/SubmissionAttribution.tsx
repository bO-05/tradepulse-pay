type Attribution = {
  actorType: "human" | "agent";
  agentEmail?: string | null;
  onBehalfOf?: string | null;
  userEmail?: string | null;
};

/** A demo driver's account is not an AgentID identity or the represented subcontractor. */
export function submissionAttribution(submittedBy: Attribution, filedBy?: string | null): string {
  if (filedBy) {
    return `Filed by the guided demo driver, acting as ${submittedBy.actorType === "agent" ? "the subcontractor's billing agent" : "the subcontractor"} (demo stand-in). No independent ${submittedBy.actorType === "agent" ? "AgentID sign-in" : "subcontractor sign-in"} is implied.`;
  }
  if (submittedBy.actorType === "agent") {
    return `Submitted by billing agent${submittedBy.agentEmail ? ` ${submittedBy.agentEmail}` : ""}${submittedBy.onBehalfOf ? ` · verified AgentID account owner: ${submittedBy.onBehalfOf}` : " · no verified AgentID account owner recorded"}. The AgentID account owner is not necessarily the project's construction Owner.`;
  }
  return `Submitted by ${submittedBy.userEmail ?? "the subcontractor"} (subcontractor, human).`;
}
