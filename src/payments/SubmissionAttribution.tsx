type Attribution = {
  actorType: "human" | "agent";
  agentEmail?: string | null;
  onBehalfOf?: string | null;
  userEmail?: string | null;
};

/** A guided-demo filing is not a signed-in identity for the party it represents. */
export function submissionAttribution(submittedBy: Attribution, filedBy?: string | null): string {
  if (filedBy) {
    return submittedBy.actorType === "agent"
      ? "Filed in the guided demo as the subcontractor's billing agent. It is not a signed-in billing-agent account."
      : "Filed in the guided demo as the subcontractor. It is not a signed-in subcontractor account.";
  }
  if (submittedBy.userEmail && /@demo\.tradepulse$/i.test(submittedBy.userEmail)) {
    return "Submitted by the shared demo account (human), not the real subcontractor.";
  }
  if (submittedBy.actorType === "agent") {
    return `Submitted by billing agent${submittedBy.agentEmail ? ` ${submittedBy.agentEmail}` : ""}${submittedBy.onBehalfOf ? ` · verified account owner: ${submittedBy.onBehalfOf}` : " · no verified account owner recorded"}. The account owner is not necessarily the project's owner.`;
  }
  return `Submitted by ${submittedBy.userEmail ?? "the subcontractor"} (subcontractor, human).`;
}
