import { useAuthActions } from "@convex-dev/auth/react";
import type { ReactNode } from "react";
import { AgreementLedgerView } from "../payments/AgreementLedgerView";
import { AgreementSummaryView } from "../payments/AgreementSummaryView";
import { PaymentsWorkspace } from "../payments/PaymentsWorkspace";
import { OwnerPortal } from "../payments/OwnerPortal";
import { SubPortal } from "../payments/SubPortal";
import { BillingAgentsView } from "./BillingAgentsView";
import { NAV_BY_ROLE, resolveRoute, type Role } from "./navigation";
import { useHash } from "./useHash";

const ROLE_LABEL: Record<Role, string> = { gc: "General contractor", sub: "Subcontractor", owner: "Owner" };

export type ShellIdentity = {
  email: string | null;
  displayName: string;
  role: Role;
  contractorName: string | null;
  actorType: "human" | "agent";
};

export function RoleShell({ me, procurementApp }: { me: ShellIdentity; procurementApp: ReactNode }) {
  const { signOut } = useAuthActions();
  const hash = useHash();
  const route = resolveRoute(me.role, hash);
  const nav = NAV_BY_ROLE[me.role];
  const homeHash = nav[0].hash;

  let content: ReactNode;
  if (route.area === "procurement") content = procurementApp;
  else if (route.area === "sub-portal") content = <SubPortal />;
  else if (route.area === "owner-portal") content = <OwnerPortal />;
  else if (route.area === "payments") content = <PaymentsWorkspace />;
  else if (route.area === "billing-agents") content = <BillingAgentsView />;
  else if (route.area === "ledger") {
    const backHash = nav.find((item) => item.area === "payments")?.hash ?? homeHash;
    content = <AgreementLedgerView agreementId={route.agreementId ?? ""} backHash={backHash} />;
  } else content = <AgreementSummaryView agreementId={route.agreementId ?? ""} backHash={homeHash} />;

  const isLegacyFullPage = route.area === "procurement";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
      <nav
        aria-label="Workspace"
        className="w-full bg-slate-900 border-b border-slate-800 px-4 py-2 flex flex-wrap items-center gap-3 text-sm"
      >
        <span className="font-bold tracking-tight mr-2">TradePulse Pay</span>
        <ul className="flex flex-wrap items-center gap-1">
          {nav.map((item) => {
            const active = route.area === item.area || (route.area === "ledger" && item.area === "payments");
            return (
              <li key={item.area}>
                <a
                  href={item.hash}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-lg px-3 py-1.5 ${
                    active ? "bg-emerald-700/40 text-emerald-200" : "text-slate-300 hover:bg-slate-800"
                  }`}
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-slate-300" data-testid="signed-in-identity">
            <span className="font-semibold">{me.displayName}</span>
            {me.email ? <span className="text-slate-400"> · {me.email}</span> : null}
            <span className="ml-2 rounded-full border border-slate-700 px-2 py-0.5 text-[10px] uppercase tracking-wide">
              {ROLE_LABEL[me.role]}
            </span>
            {me.actorType === "agent" ? (
              <span
                className="ml-1 rounded-full border border-sky-700 bg-sky-950/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-sky-200"
                data-testid="billing-agent-badge"
              >
                Billing agent{me.contractorName ? ` · ${me.contractorName}` : ""}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800"
          >
            Sign out
          </button>
        </div>
      </nav>
      {isLegacyFullPage ? content : <main className="p-4 sm:p-6">{content}</main>}
    </div>
  );
}
