import { lazy, Suspense, type ReactNode } from "react";
import { AgreementLedgerView } from "../payments/AgreementLedgerView";
import { AgreementSummaryView } from "../payments/AgreementSummaryView";
import { ApprovalInbox } from "../payments/inbox/ApprovalInbox";
import { PaymentsWorkspace } from "../payments/PaymentsWorkspace";
import { OwnerPortal } from "../payments/OwnerPortal";
import { SubPortal } from "../payments/SubPortal";
import { BillingAgentsView } from "./BillingAgentsView";
import { JudgeDemoPage } from "../payments/judgeDemo/JudgeDemoPage";
import { CompanySettingsPage } from "../company/CompanySettingsPage";
import { QueryBoundary } from "../lib/QueryBoundary";
import { NotFoundHomeContext, NotFoundState } from "../ui/NotFoundState";
import { PeoplePage } from "../people/PeoplePage";
import { MyProjectsPage } from "../projects/MyProjectsPage";
import { ActiveCompanyContext } from "./companyContext";
import { ConnectionBanner } from "./ConnectionBanner";
import { COMPANY_HASH, DEMO_ONLY_AREAS, navFor, resolveRoute, type Role } from "./navigation";
import { useSignOutAndReset } from "./signOutAndReset";
import { useHash } from "./useHash";

const PaymentsDashboard = lazy(() => import("../dashboard/PaymentsDashboard"));

const ROLE_LABEL: Record<Role, string> = { gc: "General contractor", sub: "Subcontractor", owner: "Owner" };

export type ShellIdentity = {
  email: string | null;
  displayName: string;
  role: Role;
  contractorName: string | null;
  actorType: "human" | "agent";
  companyName?: string | null;
  isDemo?: boolean;
};

export function RoleShell({ me, procurementApp }: { me: ShellIdentity; procurementApp: ReactNode }) {
  const signOutAndReset = useSignOutAndReset();
  const hash = useHash();
  const isDemo = me.isDemo === true;
  const route = resolveRoute(me.role, hash, isDemo, window.location.search);
  const nav = navFor(me.role, isDemo);
  const homeHash = nav[0].hash;

  let content: ReactNode;
  if (route.area === "procurement") content = procurementApp;
  else if (route.area === "sub-portal") content = <SubPortal />;
  else if (route.area === "owner-portal") content = <OwnerPortal role={me.role} />;
  else if (route.area === "payments") content = <PaymentsWorkspace />;
  else if (route.area === "billing-agents") content = <BillingAgentsView />;
  else if (route.area === "inbox") content = <ApprovalInbox />;
  else if (route.area === "judge-demo") content = <JudgeDemoPage />;
  else if (route.area === "people") content = <PeoplePage projectId={route.projectId} />;
  else if (route.area === "my-projects") content = <MyProjectsPage projectId={route.projectId} />;
  else if (route.area === "company") content = <CompanySettingsPage />;
  else if (route.area === "dashboard")
    content = (
      <Suspense fallback={<p className="text-sm text-slate-400">Loading dashboard…</p>}>
        <PaymentsDashboard />
      </Suspense>
    );
  else if (route.area === "not-found") content = <NotFoundState />;
  else if (route.area === "ledger") {
    const backHash = nav.find((item) => item.area === "payments")?.hash ?? homeHash;
    content = <AgreementLedgerView agreementId={route.agreementId ?? ""} backHash={backHash} />;
  } else content = <AgreementSummaryView agreementId={route.agreementId ?? ""} backHash={homeHash} />;

  const isLegacyFullPage = route.area === "procurement";

  return (
    <ActiveCompanyContext.Provider value={{ name: me.companyName ?? null, isDemo }}>
    <NotFoundHomeContext.Provider value={{ href: homeHash, label: nav[0].label }}>
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
      <ConnectionBanner />
      <nav
        aria-label="Workspace"
        className="w-full bg-slate-900 border-b border-slate-800 px-4 py-2 flex flex-wrap items-center gap-3 text-sm"
      >
        <span className="font-bold tracking-tight mr-2">TradePulse Pay</span>
        {me.companyName ? (
          <span className="mr-2 text-sm font-semibold text-slate-200" data-testid="active-company-name">
            {me.companyName}
          </span>
        ) : null}
        {isDemo ? (
          <span
            className="mr-2 rounded-full border border-amber-600 bg-amber-950/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-200"
            data-testid="demo-badge"
          >
            Demo
          </span>
        ) : null}
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
                  {DEMO_ONLY_AREAS.has(item.area) ? (
                    <span className="ml-1.5 rounded border border-amber-600 px-1 text-[9px] font-bold uppercase text-amber-200">
                      Demo
                    </span>
                  ) : null}
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
          {me.actorType === "human" ? (
            <a
              href={COMPANY_HASH}
              aria-current={route.area === "company" ? "page" : undefined}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800"
            >
              Company settings
            </a>
          ) : null}
          <button
            type="button"
            onClick={() => void signOutAndReset()}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800"
          >
            Sign out
          </button>
        </div>
      </nav>
      {isLegacyFullPage ? (
        content
      ) : (
        <main className="p-4 sm:p-6">
          <QueryBoundary
            resetKey={hash}
            fallback={(message) => (isNotFoundMessage(message) ? <NotFoundState /> : <QueryErrorAlert message={message} />)}
          >
            {content}
          </QueryBoundary>
        </main>
      )}
    </div>
    </NotFoundHomeContext.Provider>
    </ActiveCompanyContext.Provider>
  );
}

function isNotFoundMessage(message: string): boolean {
  return /(^|\s)not found\.?$/i.test(message.trim());
}

function QueryErrorAlert({ message }: { message: string }) {
  return (
    <div role="alert" className="max-w-xl rounded-2xl border border-rose-800 bg-rose-950/40 p-6 text-sm text-rose-100">
      {message}
    </div>
  );
}
