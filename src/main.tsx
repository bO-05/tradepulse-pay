import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import App from "./App.tsx";
import { AuthGate } from "./auth/AuthGate";
import "./index.css";

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
      <AuthGate procurementApp={<App />} />
    </ConvexAuthProvider>
  </React.StrictMode>
);
