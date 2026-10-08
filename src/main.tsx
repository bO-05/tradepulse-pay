import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import App from "./App.tsx";
import { AuthGate } from "./auth/AuthGate";
import { useHash } from "./auth/useHash";
import { InvitePage } from "./invites/InvitePage";
import { inviteTokenFromHash } from "./invites/inviteSession";
import { ToastProvider } from "./ui";
import "./index.css";

// Dev-only design-system gallery; the constant-false branch lets the production build drop the chunk.
const UiKitGallery = import.meta.env.DEV ? lazy(() => import("./ui/UiKitGallery")) : null;

function Root() {
  const hash = useHash();
  if (UiKitGallery && hash.startsWith("#/ui-kit")) {
    return (
      <Suspense fallback={<div role="status">Loading UI kit…</div>}>
        <UiKitGallery />
      </Suspense>
    );
  }
  const inviteToken = inviteTokenFromHash(hash);
  if (inviteToken !== null) return <InvitePage key={inviteToken} token={inviteToken} />;
  return <AuthGate procurementApp={<App />} />;
}

function getConvexUrl(): string {
  if (typeof window !== "undefined" && window.location.hostname.endsWith(".convex.site")) {
    return `https://${window.location.hostname.replace(".convex.site", ".convex.cloud")}`;
  }
  const url = import.meta.env.VITE_CONVEX_URL as string | undefined;
  if (!url) throw new Error("VITE_CONVEX_URL is not set. Run `npx convex dev` or add it to .env.local (see .env.example).");
  return url;
}

const convex = new ConvexReactClient(getConvexUrl());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConvexAuthProvider client={convex}>
      <ToastProvider>
        <Root />
      </ToastProvider>
    </ConvexAuthProvider>
  </React.StrictMode>
);
