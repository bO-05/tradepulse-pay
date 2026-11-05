import { useAuthToken } from "@convex-dev/auth/react";
import { useConvex } from "convex/react";
import { useMemo, useRef, useState } from "react";
import { AgStudioAiModule, enableStudioDevValidations, type AgAiHarnessSetup } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { api } from "../../convex/_generated/api";
import { createTradePulseHarness } from "./aiHarness";
import { buildDashboardData, type DashboardRaw } from "./dataSources";
import { DASHBOARD_INITIAL_STATE } from "./layout";
import { createConvexStudioAdapter, studioProxyUrl } from "./studioAdapter";
import { StudioIsland } from "./StudioIsland";
import { DashboardFallback, StudioErrorBoundary } from "./DashboardFallback";
import { tradePulseStudioTheme } from "./theme";
import { dashboardWidgets, type DashboardRegistry } from "./widgets";

const STUDIO_MODULES = [AgStudioAiModule];
if (import.meta.env.DEV) enableStudioDevValidations();

export default function StudioDashboard({ raw }: { raw: DashboardRaw }) {
  const data = useMemo(() => buildDashboardData(raw), [raw]);
  const [editing, setEditing] = useState(false);
  const convex = useConvex();
  const token = useAuthToken();
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const ai = useMemo<AgAiHarnessSetup>(() => {
    const adapter = createConvexStudioAdapter({
      url: studioProxyUrl({
        VITE_CONVEX_SITE_URL: import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
        VITE_CONVEX_URL: import.meta.env.VITE_CONVEX_URL as string | undefined,
      }),
      getToken: () => tokenRef.current,
    });
    return (params) => createTradePulseHarness(params, {
      adapter,
      loadPaySummary: () => convex.query(api.dashboard.payAgent.getPaySummary, {}),
    });
  }, [convex]);
  const fallback = <DashboardFallback raw={raw} reason="The optional dashboard layout could not load." />;

  return (
    <>
      {!raw.readOnly && (
        <button type="button" onClick={() => setEditing((v) => !v)}
          className="rounded-lg border border-emerald-700 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-900/40">
          {editing ? "Done editing" : "Edit layout"}
        </button>
      )}
      <StudioIsland style={{ height: "calc(100vh - 150px)", minHeight: 640 }}>
        <StudioErrorBoundary fallback={fallback}>
          <AgStudioProvider licenseKey={import.meta.env.VITE_AG_STUDIO_LICENSE_KEY} modules={STUDIO_MODULES}>
            <div style={{ height: "100%" }} data-testid="ag-studio-dashboard">
              <AgStudio<DashboardRegistry> data={data} mode={!raw.readOnly && editing ? "edit" : "view"}
                theme={tradePulseStudioTheme} widgets={dashboardWidgets} initialState={DASHBOARD_INITIAL_STATE} ai={ai} />
            </div>
          </AgStudioProvider>
        </StudioErrorBoundary>
      </StudioIsland>
    </>
  );
}
