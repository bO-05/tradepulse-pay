export function AgentNotAuthorized({
  agentEmail,
  ownerName,
  ownerEmail,
  onSignOut,
}: {
  agentEmail: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  onSignOut: () => void;
}) {
  const owner = ownerName && ownerEmail ? `${ownerName} (${ownerEmail})` : ownerName ?? ownerEmail;
  return (
    <div className="max-w-md text-center space-y-3 px-4" data-testid="agent-not-authorized">
      <h1 className="text-lg font-semibold">Agent not authorized</h1>
      <p className="text-sm text-slate-300">
        The billing agent <span className="font-semibold">{agentEmail ?? "(no email supplied)"}</span>
        {owner ? (
          <>
            {" "}
            owned by <span className="font-semibold">{owner}</span>
          </>
        ) : null}{" "}
        signed in with AgentID, but no general contractor has authorized it for a subcontractor.
      </p>
      <p className="text-xs text-slate-400">
        Ask the general contractor to add this agent under “Authorized billing agents”. No project data is available
        until then.
      </p>
      <button
        type="button"
        onClick={onSignOut}
        className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
      >
        Sign out
      </button>
    </div>
  );
}
