import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { FormEvent, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { formatDate } from "../payments/format";

function errorText(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | string;
    return typeof data === "string" ? data : data.message ?? "Request failed.";
  }
  return "Request failed. Try again.";
}

/** GC-only: authorize AgentID billing agents to act for a subcontractor, or revoke them. */
export function BillingAgentsView() {
  const links = useQuery(api.agentLinks.listAgentLinks, {});
  const contractors = useQuery(api.agentLinks.listLinkableContractors, {});
  const addLink = useMutation(api.agentLinks.addAgentLink);
  const revokeLink = useMutation(api.agentLinks.revokeAgentLink);
  const [agentEmail, setAgentEmail] = useState("");
  const [contractorId, setContractorId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || contractorId === "") return;
    setBusy(true);
    setError(null);
    try {
      await addLink({ agentEmail, contractorId: contractorId as Id<"contractors"> });
      setAgentEmail("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async (linkId: Id<"agentLinks">) => {
    setError(null);
    try {
      await revokeLink({ linkId });
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <section aria-labelledby="billing-agents-heading" className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 id="billing-agents-heading" className="text-base font-semibold mb-1">
          Authorized billing agents
        </h2>
        <p className="text-xs text-slate-400 mb-4">
          A subcontractor's AI billing agent signs in with AgentID. It can view that subcontractor's agreements and
          submit pay applications only while its email is linked here. It can never approve, fund or pay. Revoking a
          link removes access on the agent's next request.
        </p>
        <form onSubmit={onAdd} className="flex flex-wrap items-end gap-3" aria-label="Add billing agent">
          <div className="space-y-1">
            <label htmlFor="agent-email" className="block text-xs font-medium text-slate-300">
              Agent email
            </label>
            <input
              id="agent-email"
              type="email"
              required
              placeholder="agent@agentmail.to"
              value={agentEmail}
              onChange={(e) => setAgentEmail(e.target.value)}
              className="w-72 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="agent-contractor" className="block text-xs font-medium text-slate-300">
              Subcontractor
            </label>
            <select
              id="agent-contractor"
              required
              value={contractorId}
              onChange={(e) => setContractorId(e.target.value)}
              className="w-64 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
            >
              <option value="">Select a subcontractor…</option>
              {(contractors ?? []).map((c) => (
                <option key={c._id} value={c._id}>
                  {c.companyName}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-sm font-semibold px-4 py-2"
          >
            {busy ? "Adding…" : "Add agent"}
          </button>
        </form>
        {error && (
          <p role="alert" className="mt-3 text-sm text-rose-300 bg-rose-950/60 border border-rose-800/70 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
      </section>

      <section aria-labelledby="billing-agents-list" className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h3 id="billing-agents-list" className="text-sm font-semibold mb-3">
          Links
        </h3>
        {links === undefined ? (
          <p className="text-sm text-slate-400" role="status">
            Loading links…
          </p>
        ) : links.length === 0 ? (
          <p className="text-sm text-slate-400">No billing agents authorized yet.</p>
        ) : (
          <table className="w-full text-sm" data-testid="agent-links">
            <thead className="text-xs text-slate-400 text-left">
              <tr>
                <th className="py-2 pr-3 font-medium">Agent email</th>
                <th className="py-2 pr-3 font-medium">Subcontractor</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Added</th>
                <th className="py-2 pr-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link._id} className="border-t border-slate-800">
                  <td className="py-2 pr-3 font-mono text-xs">{link.agentEmail}</td>
                  <td className="py-2 pr-3">{link.contractorName}</td>
                  <td className="py-2 pr-3">
                    {link.status === "active" ? (
                      <span className="rounded-full bg-emerald-900/60 text-emerald-200 px-2 py-0.5 text-xs">Active</span>
                    ) : (
                      <span className="rounded-full bg-slate-800 text-slate-300 px-2 py-0.5 text-xs">
                        Revoked{link.revokedAt ? ` ${formatDate(link.revokedAt)}` : ""}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-slate-400">{formatDate(link.createdAt)}</td>
                  <td className="py-2 pr-3 text-right">
                    {link.status === "active" ? (
                      <button
                        type="button"
                        onClick={() => void onRevoke(link._id)}
                        aria-label={`Revoke ${link.agentEmail}`}
                        className="rounded-lg border border-rose-800 text-rose-200 px-3 py-1 text-xs hover:bg-rose-950"
                      >
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
