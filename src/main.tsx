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
  return (import.meta.env.VITE_CONVEX_URL as string) || "https://brainy-skunk-440.convex.cloud";
}

const convex = new ConvexReactClient(getConvexUrl());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConvexAuthProvider client={convex}>
      <AuthGate procurementApp={<App />} />
    </ConvexAuthProvider>
  </React.StrictMode>
);
