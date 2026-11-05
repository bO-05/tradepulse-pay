import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { AgreementLedgerView } from "../payments/AgreementLedgerView";
import { AgreementSummaryView } from "../payments/AgreementSummaryView";
import { SovPage } from "../billing/SovEditor";
import { BillingWorklist } from "../billing/BillingWorklist";
import { OwnerPayAppsPage } from "../billing/OwnerBilling";
import { PayAppPage } from "../billing/PayAppPage";
import { PayAppsPage } from "../billing/PayAppsPage";
import { ChangeOrdersPage } from "../payments/ChangeOrders";
import { ChangeOrderDetail } from "../payments/ChangeOrderDetail";
import { ApprovalInbox } from "../payments/inbox/ApprovalInbox";
import { PaymentsWorkspace } from "../payments/PaymentsWorkspace";
import { OwnerPortal } from "../payments/OwnerPortal";
import { SubPortal } from "../payments/SubPortal";
import { BidInvitationsPage } from "../bids/BidInvitationsPage";
import { BidPackagePage } from "../bids/BidPackagePage";
import { BillingAgentsView } from "./BillingAgentsView";
import { JudgeDemoPage } from "../payments/judgeDemo/JudgeDemoPage";
import { CompanySettingsPage } from "../company/CompanySettingsPage";
import { CompliancePage } from "../compliance/CompliancePage";
import { QueryBoundary } from "../lib/QueryBoundary";
import { NotFoundHomeContext, NotFoundState } from "../ui/NotFoundState";
import { PeoplePage } from "../people/PeoplePage";
import { VendorsPage } from "../vendors/VendorsPage";
import { VendorDetailPage } from "../vendors/VendorDetailPage";
import { NotificationBell } from "../notifications/NotificationBell";
import { NotificationsPage } from "../notifications/NotificationsPage";
import { MyProjectsPage } from "../projects/MyProjectsPage";
import { NewProjectWizard } from "../projects/gc/NewProjectWizard";
import { QuickStartWizard } from "../projects/gc/QuickStartWizard";
import { ProjectPage } from "../projects/gc/ProjectPage";
import { ProjectSettingsPage } from "../projects/gc/ProjectSettingsPage";
import { ProjectsListPage } from "../projects/gc/ProjectsListPage";
import { ActiveCompanyContext } from "./companyContext";
import { ConnectionBanner } from "./ConnectionBanner";
import { COMPANY_HASH, DEMO_ONLY_AREAS, agreementHash, navFor, resolveRoute, type Role } from "./navigation";
import { useSignOutAndReset } from "./signOutAndReset";
import { useHash } from "./useHash";

const PaymentsDashboard = lazy(() => import("../dashboard/PaymentsDashboard"));

/** Demo GCs get the payment path first; the procurement back office moves under "More". */
const DEMO_PRIMARY_AREAS = new Set(["inbox", "payments", "billing", "change-orders", "dashboard", "judge-demo"]);

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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const hash = useHash();
  const isDemo = me.isDemo === true;
  const route = resolveRoute(me.role, hash, isDemo, window.location.search, me.actorType);
  const nav = navFor(me.role, isDemo, me.actorType);
  const demoTrim = isDemo && me.role === "gc";
  const primaryNav = demoTrim ? nav.filter((item) => DEMO_PRIMARY_AREAS.has(item.area)) : nav;
  const moreNav = demoTrim ? nav.filter((item) => !DEMO_PRIMARY_AREAS.has(item.area)) : [];
  const homeHash = nav[0].hash;
  const leftProcurement = route.area !== "procurement" && hash !== "" && hash !== "#" && hash !== "#/";
  useEffect(() => {
    if (menuOpen) document.getElementById("workspace-main")?.focus();
    setMenuOpen(false);
  }, [hash]);
  // Sign-in replaces the auth screen with this shell. Move focus into the workspace instead of <body>.
  useEffect(() => {
    document.getElementById("workspace-main")?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menuOpen) {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menuOpen]);

  // `?project=&tab=` belong to the procurement workspace. Once the user moves to another area they would
  // otherwise linger and reopen a stale (for example archived) project the next time Procurement opens.
  useEffect(() => {
    if (!leftProcurement) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("project") && !params.has("tab")) return;
    params.delete("project");
    params.delete("tab");
    const query = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }, [leftProcurement, hash]);

  let content: ReactNode;
  if (route.area === "procurement") content = procurementApp;
  else if (route.area === "sub-portal") content = <SubPortal />;
  else if (route.area === "bid-invitations")
    content = route.tradePackageId ? <BidPackagePage tradePackageId={route.tradePackageId} /> : <BidInvitationsPage />;
  else if (route.area === "owner-portal") content = <OwnerPortal role={me.role} />;
  else if (route.area === "payments") content = <PaymentsWorkspace />;
  else if (route.area === "billing-agents") content = <BillingAgentsView />;
  else if (route.area === "billing") content = <BillingWorklist tab={route.tab} />;
  else if (route.area === "owner-pay-apps") content = <OwnerPayAppsPage />;
  else if (route.area === "pay-apps") content = <PayAppsPage />;
  else if (route.area === "change-orders") content = route.changeOrderId ? <ChangeOrderDetail changeOrderId={route.changeOrderId} /> : <ChangeOrdersPage />;
  else if (route.area === "compliance") content = <CompliancePage role={me.role} focusItemId={route.complianceItemId} />;
  else if (route.area === "pay-app") {
    const back = me.role === "gc" ? { hash: "#/billing", label: "Billing" } : { hash: "#/pay-apps", label: "Pay apps" };
    content = <PayAppPage payAppId={route.payAppId ?? ""} backHash={back.hash} backLabel={back.label} />;
  }
  else if (route.area === "inbox") content = <ApprovalInbox />;
  else if (route.area === "judge-demo") content = <JudgeDemoPage key={route.demoRunId ?? "latest"} initialRunId={route.demoRunId} />;
  else if (route.area === "people") content = <PeoplePage projectId={route.projectId} />;
  else if (route.area === "vendors") content = route.vendorId ? <VendorDetailPage vendorId={route.vendorId} /> : <VendorsPage />;
  else if (route.area === "notifications") content = <NotificationsPage />;
  else if (route.area === "my-projects") content = <MyProjectsPage projectId={route.projectId} />;
  else if (route.area === "company") content = <CompanySettingsPage />;
  else if (route.area === "gc-projects") {
    if (route.view === "new") content = <NewProjectWizard />;
    else if (route.view === "quick-start") content = <QuickStartWizard />;
    else if (route.projectId && route.view === "settings") content = <ProjectSettingsPage projectId={route.projectId} />;
    else if (route.projectId) content = <ProjectPage projectId={route.projectId} />;
    else content = <ProjectsListPage />;
  }
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
  } else if (route.view === "sov") {
    content = <SovPage agreementId={route.agreementId ?? ""} backHash={agreementHash(route.agreementId ?? "")} />;
  } else content = <AgreementSummaryView agreementId={route.agreementId ?? ""} backHash={homeHash} />;

  const isLegacyFullPage = route.area === "procurement";

  return (
    <ActiveCompanyContext.Provider value={{ name: me.companyName ?? null, isDemo }}>
    <NotFoundHomeContext.Provider value={{ href: homeHash, label: nav[0].label }}>
    <div className="workspace-shell min-h-screen min-w-0 bg-slate-950 text-slate-100 font-sans">
      <a
        href="#workspace-main"
        className="skip-link"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("workspace-main")?.focus();
        }}
      >Skip to main content</a>
      <ConnectionBanner />
      <header className="border-b border-slate-800 bg-slate-900 px-4 py-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <a href={homeHash} className="font-bold tracking-tight text-lg">TradePulse Pay</a>
          <div className="flex items-center gap-2">
            {isDemo && <span className="rounded-full border border-amber-700 bg-amber-950 px-2 py-1 text-[10px] font-bold uppercase text-amber-200">Demo</span>}
            {me.actorType === "human" ? <NotificationBell /> : null}
            <button
              ref={menuButton}
              type="button"
              aria-expanded={menuOpen}
              aria-controls="workspace-navigation"
              onClick={() => setMenuOpen((open) => !open)}
              className="min-h-11 rounded-lg border border-slate-600 px-3 text-sm xl:hidden"
            >{menuOpen ? "Close menu" : "Menu"}</button>
          </div>
        </div>
        <p className="mt-1 text-xs text-slate-300 xl:hidden">{ROLE_LABEL[me.role]}{me.companyName ? ` · ${me.companyName}` : ""}</p>
      <nav
        id="workspace-navigation"
        aria-label="Workspace"
        className={`${menuOpen ? "block" : "hidden"} mt-3 min-w-0 text-sm xl:block`}
      >
        {me.companyName ? (
          <span className="mb-2 block text-sm font-semibold text-slate-200" data-testid="active-company-name">
            {me.companyName}
          </span>
        ) : null}
        <ul className="grid gap-1 sm:grid-cols-2 xl:flex xl:flex-wrap">
          {primaryNav.map((item) => {
            const active =
              route.area === item.area ||
              (route.area === "ledger" && item.area === "payments") ||
              (route.area === "pay-app" && (item.area === "billing" || item.area === "pay-apps"));
            const label = demoTrim && item.area === "billing" ? "Pay apps" : item.label;
            return (
              <li key={item.area}>
                <a
                  href={item.hash}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 ${
                    active ? "bg-emerald-700/40 text-emerald-200" : "text-slate-300 hover:bg-slate-800"
                  }`}
                >
                  {label}
                  {DEMO_ONLY_AREAS.has(item.area) ? (
                    <span aria-hidden="true" className="rounded border border-amber-600 px-1 text-[9px] font-bold uppercase text-amber-200">
                      Demo
                    </span>
                  ) : null}
                </a>
              </li>
            );
          })}
          {moreNav.length > 0 ? (
            <li className="relative">
              <details className="group">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-slate-300 hover:bg-slate-800 [&::-webkit-details-marker]:hidden">
                  More
                  <span aria-hidden="true" className="text-[10px] text-slate-400 group-open:rotate-180">▼</span>
                </summary>
                <ul className="mt-1 grid gap-1 rounded-lg border border-slate-700 bg-slate-900 p-1 xl:absolute xl:right-0 xl:z-20 xl:mt-1 xl:w-60 xl:shadow-2xl">
                  {moreNav.map((item) => {
                    const active = route.area === item.area;
                    return (
                      <li key={item.area}>
                        <a
                          href={item.hash}
                          aria-current={active ? "page" : undefined}
                          className={`flex min-h-11 items-center rounded-lg px-3 py-2 ${
                            active ? "bg-emerald-700/40 text-emerald-200" : "text-slate-300 hover:bg-slate-800"
                          }`}
                        >
                          {item.label}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </details>
            </li>
          ) : null}
        </ul>
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-3 border-t border-slate-800 pt-3">
          <span className="min-w-0 [overflow-wrap:anywhere] text-xs text-slate-300" data-testid="signed-in-identity">
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
      </header>
      {isDemo && (
        <aside className="border-b border-amber-900/50 bg-amber-950/20 px-4 py-2 text-xs text-amber-100" data-testid="demo-badge">
          <strong>PayPal sandbox · no real money.</strong> Shared demo accounts: use synthetic data only.{" "}
          <a href="#/demo" className="underline underline-offset-2">Demo guide</a>
        </aside>
      )}
      {isLegacyFullPage ? (
        <div id="workspace-main" tabIndex={-1} className="workspace-content min-w-0 outline-none">{content}</div>
      ) : (
        <main id="workspace-main" tabIndex={-1} className="workspace-content min-w-0 p-4 outline-none sm:p-6">
          <QueryBoundary
            resetKey={hash}
            fallback={(message) => (isNotFoundMessage(message) ? <NotFoundState /> : <QueryErrorAlert message={message} />)}
          >
            {content}
          </QueryBoundary>
        </main>
      )}
      <footer className="px-4 pb-4 text-center text-[11px] leading-relaxed text-slate-400 sm:px-6">
        PayPal sandbox build · no real money moves.
      </footer>
    </div>
    </NotFoundHomeContext.Provider>
    </ActiveCompanyContext.Provider>
  );
}

function isNotFoundMessage(message: string): boolean {
  return /(^|\s)not found\.?$/i.test(message.trim()) || /ArgumentValidationError|Invalid (?:document )?ID/i.test(message);
}

function QueryErrorAlert({ message }: { message: string }) {
  return (
    <div role="alert" className="max-w-xl rounded-2xl border border-rose-800 bg-rose-950/40 p-6 text-sm text-rose-100">
      <p>The page could not load. Your saved records have not been changed.</p>
      <button type="button" className="mt-3 rounded-lg border border-rose-700 px-3 py-2" onClick={() => window.location.reload()}>Reload page</button>
      {/network|connection|offline/i.test(message) && <p className="mt-2">Check your connection and try again.</p>}
    </div>
  );
}
