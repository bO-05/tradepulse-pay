/**
 * Deterministic mount for the real JudgeDemoPage used by the mounted fake-timer browser regression.
 *
 * The page is the production component, unchanged. Its Convex hooks are replaced at the Vite
 * dependency boundary by the harness (`convex/react` is served as an in-memory fixture), so the real
 * interval effect, cleanup and run-history rendering execute in Chrome without a DOM test library,
 * without a Convex deployment and without creating or reading live demo data. Selection mirrors the
 * app shell: a hash change remounts the page with `initialRunId`, exactly as RoleShell does.
 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import { JudgeDemoPage } from "../../../src/payments/judgeDemo/JudgeDemoPage";
import "../../../src/index.css";

const w = window as unknown as {
  __React: typeof React;
  __judgeDemoFixture: { selectedRunId: string | null; queries: Record<string, unknown> };
  __mountJudgeDemo: () => void;
};

w.__React = React;

const container = document.getElementById("root");
if (container === null) throw new Error("fixture root is missing");
const root = createRoot(container);

function routeRunId(): string | undefined {
  const match = window.location.hash.match(/^#\/judge-demo\/([^/?#]+)$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function render() {
  const runId = routeRunId();
  w.__judgeDemoFixture.selectedRunId = runId ?? null;
  root.render(
    <React.StrictMode>
      <JudgeDemoPage key={runId ?? "latest"} initialRunId={runId} />
    </React.StrictMode>,
  );
}

w.__mountJudgeDemo = render;
window.addEventListener("hashchange", render);
render();
